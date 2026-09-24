import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import {
  aggregateSchema,
  dateInZone,
  initialAggregate,
  PlannerEngine,
  receiptLimit,
  type PlannerAggregate,
  type PlannerPersistence,
} from "../src/host/engine.ts";
import {
  commandSchema,
  routineId,
  snapshotSchema,
  taskId,
  type PlannerCommand,
} from "../src/shared/model.ts";

class MemoryPersistence implements PlannerPersistence {
  value = initialAggregate("UTC");
  fail = false;
  writes = 0;
  closed = false;
  beforeWrite?: () => Promise<void>;
  get() {
    return this.value;
  }
  async set(value: PlannerAggregate) {
    await this.beforeWrite?.();
    if (this.fail) throw new Error("disk write failed");
    this.value = structuredClone(value);
    this.writes++;
  }
  async close() {
    this.closed = true;
  }
}
const engines: PlannerEngine[] = [];
afterEach(async () => {
  await Promise.all(engines.splice(0).map((engine) => engine.dispose()));
});
function fixture() {
  const persistence = new MemoryPersistence();
  let instant = "2026-09-07T12:00:00Z";
  let operations = 0;
  const engine = new PlannerEngine(persistence, "UTC", () => new Date(instant));
  engines.push(engine);
  return {
    persistence,
    engine,
    advance(value: string) {
      instant = value;
    },
    send(command: PlannerCommand) {
      return engine.mutate({
        expectedRevision: persistence.value.state.revision,
        operationId: "op-" + ++operations,
        command,
      });
    },
  };
}
const daily = {
  type: "routine.save",
  id: routineId("daily"),
  title: "Walk",
  weekdays: [0, 1, 2, 3, 4, 5, 6],
  enabled: true,
} satisfies PlannerCommand;
const add = (id = "one", date = "2026-09-07"): PlannerCommand => ({
  type: "task.add",
  id: taskId(id),
  title: "Manual task",
  date,
});

describe("daily planner aggregate", () => {
  it("rejects a configured timezone mismatch before opening without changing saved data", () => {
    const persistence = new MemoryPersistence();
    const saved = structuredClone(persistence.value);
    expect(() => new PlannerEngine(persistence, "America/Los_Angeles")).toThrow(
      expect.objectContaining({ code: "timezone-mismatch", status: 409 }),
    );
    expect(persistence.value).toEqual(saved);
    expect(persistence.writes).toBe(0);
  });

  it("rejects mismatched reads, writes and receipt retries without persistence changes", async () => {
    const f = fixture();
    const request = {
      expectedRevision: 0,
      operationId: "retry-zone",
      command: daily,
    };
    await f.engine.mutate(request);
    f.persistence.value.state.timeZone = "America/Los_Angeles";
    const saved = structuredClone(f.persistence.value);
    const writes = f.persistence.writes;
    f.advance("2026-09-09T00:30:00Z");
    await expect(f.engine.read()).rejects.toMatchObject({
      code: "timezone-mismatch",
    });
    await expect(f.send(add("later", "2026-09-09"))).rejects.toMatchObject({
      code: "timezone-mismatch",
    });
    await expect(f.engine.mutate(request)).rejects.toMatchObject({
      code: "timezone-mismatch",
    });
    await expect(
      f.engine.mutate({ ...request, operationId: "stale" }),
    ).rejects.toMatchObject({ code: "timezone-mismatch" });
    expect(f.persistence.value).toEqual(saved);
    expect(f.persistence.writes).toBe(writes);
  });

  it.each(["occurrence:", "occurrence:manual", "occurrence:manual:1"])(
    "rejects a new manual task with reserved identity %s without writing",
    async (id) => {
      const f = fixture();
      const saved = structuredClone(f.persistence.value);
      await expect(f.send(add(id))).rejects.toMatchObject({
        code: "reserved-id",
      });
      expect(f.persistence.value).toEqual(saved);
      expect(f.persistence.writes).toBe(0);
    },
  );

  it.each(["read", "delete", "move"] as const)(
    "recovers persisted occurrence ID collisions through %s without changing old tasks implicitly",
    async (operation) => {
      const f = fixture();
      const baseId = taskId(
        "occurrence:" +
          createHash("sha256").update(daily.id).digest("hex") +
          ":2026-09-07",
      );
      const legacyTasks = [baseId, taskId(baseId + ":1")].map((id, order) => ({
        id,
        title: "Legacy manual task",
        date: "2026-09-07",
        originalDate: "2026-09-07",
        status: "open" as const,
        order,
      }));
      f.persistence.value.state.tasks = structuredClone(legacyTasks);
      f.persistence.value.state.routines = [
        {
          id: daily.id,
          title: daily.title,
          weekdays: daily.weekdays,
          enabled: true,
        },
      ];
      expect(aggregateSchema.safeParse(f.persistence.value).success).toBe(true);
      const recovered =
        operation === "read"
          ? await f.engine.read()
          : await f.send(
              operation === "delete"
                ? { type: "task.delete", id: baseId }
                : { type: "task.move", id: baseId, date: "2026-09-08" },
            );
      const generated = recovered.state.tasks.find(
        (task) => task.routineId === daily.id,
      )!;
      expect(generated.id).toBe(baseId + ":2");
      expect(recovered.state.tasks).toHaveLength(3);
      expect(recovered.state.tasks[1]).toEqual(legacyTasks[1]);
      if (operation === "read")
        expect(recovered.state.tasks[0]).toEqual(legacyTasks[0]);
      if (operation === "delete")
        expect(recovered.state.tasks[0]).toMatchObject({
          id: baseId,
          status: "deleted",
        });
      if (operation === "move")
        expect(recovered.state.tasks[0]).toMatchObject({
          id: baseId,
          date: "2026-09-08",
          originalDate: "2026-09-07",
        });
      expect(await f.engine.read()).toEqual(recovered);

      await f.send({
        type: "task.move",
        id: generated.id,
        date: "2026-09-09",
        allowDuplicate: true,
      });
      expect((await f.engine.read()).state.tasks).toHaveLength(3);
      await f.send({ type: "task.delete", id: generated.id });
      await f.engine.dispose();
      const reopenedPersistence = new MemoryPersistence();
      reopenedPersistence.value = structuredClone(f.persistence.value);
      let instant = "2026-09-07T12:00:00Z";
      const reopened = new PlannerEngine(
        reopenedPersistence,
        "UTC",
        () => new Date(instant),
      );
      engines.push(reopened);
      const restored = await reopened.read();
      expect(restored.state.tasks).toEqual(f.persistence.value.state.tasks);
      expect(reopenedPersistence.writes).toBe(0);
      instant = "2026-09-12T12:00:00Z";
      const later = await reopened.read();
      expect(
        later.state.tasks
          .filter((task) => task.routineId === daily.id)
          .map((task) => task.originalDate),
      ).toEqual(["2026-09-07", "2026-09-12"]);
    },
  );

  it("generates once on mutation and repeated GETs without automatic planning", async () => {
    const f = fixture();
    const first = await f.send(daily);
    const again = await f.engine.read();
    expect(again).toEqual(first);
    expect(again.state.tasks).toHaveLength(1);
    expect(again.state.days["2026-09-07"]).toEqual({
      planned: false,
      closed: false,
    });
    expect(f.persistence.writes).toBe(1);
    expect(snapshotSchema.parse(again)).toEqual(again);
  });

  it("retains yesterday open tasks and never backfills skipped dates", async () => {
    const f = fixture();
    await f.send(daily);
    await f.send(add());
    f.advance("2026-09-08T00:01:00Z");
    const next = await f.engine.read();
    expect(next.state.tasks.map((task) => task.date)).toEqual([
      "2026-09-07",
      "2026-09-07",
      "2026-09-08",
    ]);
    f.advance("2026-09-12T10:00:00Z");
    const skipped = await f.engine.read();
    expect(skipped.state.tasks.map((task) => task.originalDate)).toEqual([
      "2026-09-07",
      "2026-09-07",
      "2026-09-08",
      "2026-09-12",
    ]);
    expect(skipped.state.tasks.every((task) => task.status === "open")).toBe(
      true,
    );
  });

  it("keeps tombstones and original occurrence identities after delete or move", async () => {
    const f = fixture();
    const initial = await f.send(daily);
    const id = initial.state.tasks[0]!.id;
    await f.send({ type: "task.delete", id });
    expect((await f.engine.read()).state.tasks).toHaveLength(1);
    await f.send({ type: "task.restore", id });
    await f.send({
      type: "task.move",
      id,
      date: "2026-09-09",
      allowDuplicate: true,
    });
    const moved = await f.engine.read();
    expect(moved.state.tasks).toHaveLength(1);
    expect(moved.state.tasks[0]).toMatchObject({
      id,
      date: "2026-09-09",
      originalDate: "2026-09-07",
      dateChanges: [
        {
          from: "2026-09-07",
          to: "2026-09-09",
          at: "2026-09-07T12:00:00.000Z",
        },
      ],
    });
    f.advance("2026-09-09T12:00:00Z");
    const target = await f.engine.read();
    expect(target.state.tasks).toHaveLength(2);
    expect(target.state.tasks[0]!.id).toBe(id);
    expect(new Set(target.state.tasks.map((task) => task.id)).size).toBe(2);
  });

  it("requires confirmation for present and unmaterialized routine collisions without merging", async () => {
    const f = fixture();
    const first = await f.send(daily);
    const id = first.state.tasks[0]!.id;
    await expect(
      f.send({ type: "task.move", id, date: "2026-09-08" }),
    ).rejects.toMatchObject({ code: "duplicate-occurrence", status: 409 });
    expect(f.persistence.value.state).toEqual(first.state);
    f.advance("2026-09-08T12:00:00Z");
    await f.engine.read();
    await expect(
      f.send({ type: "task.move", id, date: "2026-09-08" }),
    ).rejects.toMatchObject({ code: "duplicate-occurrence" });
    const confirmed = await f.send({
      type: "task.move",
      id,
      date: "2026-09-08",
      allowDuplicate: true,
    });
    expect(confirmed.state.tasks).toHaveLength(2);
    expect(
      confirmed.state.tasks.every(
        (task) => task.status === "open" && task.date === "2026-09-08",
      ),
    ).toBe(true);
  });

  it("template edits, pause and deletion leave materialized tasks unchanged", async () => {
    const f = fixture();
    const first = await f.send(daily);
    const edited = await f.send({
      ...daily,
      title: "New title",
      weekdays: [2],
    });
    expect(edited.state.tasks).toEqual(first.state.tasks);
    const paused = await f.send({ ...daily, title: "Paused", enabled: false });
    expect(paused.state.tasks).toEqual(first.state.tasks);
    f.advance("2026-09-08T12:00:00Z");
    expect((await f.engine.read()).state.tasks).toEqual(first.state.tasks);
    await f.send({ ...daily, title: "Tuesday" });
    const removed = await f.send({ type: "routine.delete", id: daily.id });
    expect(removed.state.tasks.map((task) => task.title)).toEqual([
      "Walk",
      "Tuesday",
    ]);
    f.advance("2026-09-09T12:00:00Z");
    expect((await f.engine.read()).state.tasks).toHaveLength(2);
  });

  it("permits only open tasks to move and only to today or future", async () => {
    const f = fixture();
    await f.send(add());
    await expect(
      f.send({ type: "task.move", id: taskId("one"), date: "2026-09-06" }),
    ).rejects.toMatchObject({ code: "invalid-date" });
    await f.send({ type: "task.complete", id: taskId("one"), completed: true });
    await expect(
      f.send({ type: "task.move", id: taskId("one"), date: "2026-09-08" }),
    ).rejects.toMatchObject({ code: "invalid-state" });
    await f.send({ type: "task.delete", id: taskId("one") });
    await expect(
      f.send({ type: "task.move", id: taskId("one"), date: "2026-09-08" }),
    ).rejects.toMatchObject({ code: "invalid-state" });
  });

  it("rejects stale revision while safe retries precede the revision check", async () => {
    const f = fixture();
    const request = {
      expectedRevision: 0,
      operationId: "stable",
      command: add(),
    };
    const first = await f.engine.mutate(request);
    expect(await f.engine.mutate(request)).toEqual(first);
    await f.send(add("two"));
    const latest = await f.engine.mutate(request);
    expect(latest.state.revision).toBe(2);
    expect(latest.state.tasks).toHaveLength(2);
    await expect(
      f.engine.mutate({ ...request, operationId: "new" }),
    ).rejects.toMatchObject({ code: "conflict", status: 409 });
    await expect(
      f.engine.mutate({ ...request, command: add("different") }),
    ).rejects.toMatchObject({ code: "operation-mismatch", status: 409 });
    expect(f.persistence.writes).toBe(2);
  });

  it("keeps bounded receipts across a reconstructed engine", async () => {
    const f = fixture();
    for (let i = 0; i <= receiptLimit; i++)
      await f.engine.mutate({
        expectedRevision: i,
        operationId: "op" + i,
        command: { type: "day.plan", date: "2026-09-07" },
      });
    expect(f.persistence.value.receipts).toHaveLength(receiptLimit);
    expect(f.persistence.value.receipts[0]!.operationId).toBe("op1");
    const restored = new PlannerEngine(
      f.persistence,
      "UTC",
      () => new Date("2026-09-07T12:00:00Z"),
    );
    engines.push(restored);
    expect(
      (
        await restored.mutate({
          expectedRevision: receiptLimit,
          operationId: "op" + receiptLimit,
          command: { type: "day.plan", date: "2026-09-07" },
        })
      ).state.revision,
    ).toBe(receiptLimit + 1);
    await expect(
      restored.mutate({
        expectedRevision: 0,
        operationId: "op0",
        command: { type: "day.plan", date: "2026-09-07" },
      }),
    ).rejects.toMatchObject({ code: "conflict" });
  });

  it("close refuses open tasks, and add/uncomplete/restore explicitly reopen", async () => {
    const f = fixture();
    await f.send(add());
    await expect(
      f.send({ type: "day.close", date: "2026-09-07" }),
    ).rejects.toMatchObject({ code: "open-tasks" });
    await f.send({ type: "task.complete", id: taskId("one"), completed: true });
    expect(
      (await f.send({ type: "day.close", date: "2026-09-07" })).state.days[
        "2026-09-07"
      ]!.closed,
    ).toBe(true);
    expect(
      (
        await f.send({
          type: "task.complete",
          id: taskId("one"),
          completed: false,
        })
      ).state.days["2026-09-07"]!.closed,
    ).toBe(false);
    await f.send({ type: "task.delete", id: taskId("one") });
    await f.send({ type: "day.close", date: "2026-09-07" });
    expect(
      (await f.send({ type: "task.restore", id: taskId("one") })).state.days[
        "2026-09-07"
      ]!.closed,
    ).toBe(false);
    await f.send({ type: "task.complete", id: taskId("one"), completed: true });
    await f.send({ type: "day.close", date: "2026-09-07" });
    expect((await f.send(add("two"))).state.days["2026-09-07"]!.closed).toBe(
      false,
    );
    await f.send({ type: "task.delete", id: taskId("two") });
    await f.send({ type: "day.close", date: "2026-09-07" });
    expect(
      (await f.send({ type: "day.reopen", date: "2026-09-07" })).state.days[
        "2026-09-07"
      ]!.closed,
    ).toBe(false);
  });

  it("never publishes draft state or receipts after a durable write failure", async () => {
    const f = fixture();
    const original = structuredClone(f.persistence.value);
    f.persistence.fail = true;
    await expect(f.send(add())).rejects.toThrow("disk write failed");
    expect(f.persistence.value).toEqual(original);
    f.persistence.fail = false;
    await f.send(daily);
    const previous = structuredClone(f.persistence.value);
    f.advance("2026-09-08T12:00:00Z");
    f.persistence.fail = true;
    await expect(f.engine.read()).rejects.toThrow("disk write failed");
    expect(f.persistence.value).toEqual(previous);
    f.persistence.fail = false;
    expect((await f.engine.read()).state.tasks).toHaveLength(2);
  });

  it("serializes competing mutations and reads, then drains before closing", async () => {
    const f = fixture();
    let release!: () => void;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    f.persistence.beforeWrite = async () => {
      entered();
      await barrier;
    };
    const first = f.engine.mutate({
      expectedRevision: 0,
      operationId: "a",
      command: add(),
    });
    await started;
    const read = f.engine.read();
    const second = f.engine.mutate({
      expectedRevision: 0,
      operationId: "b",
      command: add("two"),
    });
    const rejection = expect(second).rejects.toMatchObject({
      code: "conflict",
    });
    const disposal = f.engine.dispose();
    expect(f.engine.dispose()).toBe(disposal);
    expect(f.persistence.closed).toBe(false);
    await expect(f.engine.read()).rejects.toMatchObject({
      code: "unavailable",
    });
    release();
    await first;
    expect((await read).state.tasks).toHaveLength(1);
    await rejection;
    await disposal;
    expect(f.persistence.closed).toBe(true);
    expect(f.persistence.writes).toBe(1);
  });

  it("serializes concurrent generation at midnight exactly once", async () => {
    const f = fixture();
    await f.send(daily);
    f.advance("2026-09-08T00:00:00Z");
    const results = await Promise.all([
      f.engine.read(),
      f.engine.read(),
      f.engine.read(),
    ]);
    expect(results.map((result) => result.state.revision)).toEqual([2, 2, 2]);
    expect(f.persistence.writes).toBe(2);
    expect(results[0]!.state.tasks).toHaveLength(2);
  });

  it("returns detached snapshots and maintains exact visible reorder membership", async () => {
    const f = fixture();
    await f.send(add());
    await f.send(add("two"));
    await expect(
      f.send({
        type: "task.reorder",
        date: "2026-09-07",
        ids: [taskId("one")],
      }),
    ).rejects.toMatchObject({ code: "invalid-order" });
    const ordered = await f.send({
      type: "task.reorder",
      date: "2026-09-07",
      ids: [taskId("two"), taskId("one")],
    });
    expect(ordered.state.tasks.map((task) => task.order)).toEqual([1, 0]);
    ordered.state.tasks[0]!.title = "Mutated externally";
    expect((await f.engine.read()).state.tasks[0]!.title).toBe("Manual task");
  });

  it("validates calendar dates, IDs, input fields, titles and weekdays", async () => {
    expect(() => taskId("../escape")).toThrow();
    expect(() => routineId("")).toThrow();
    expect(
      commandSchema.safeParse({ ...add(), date: "2026-02-30" }).success,
    ).toBe(false);
    expect(
      commandSchema.safeParse({ ...daily, weekdays: [1, 1] }).success,
    ).toBe(false);
    expect(commandSchema.safeParse({ ...daily, weekdays: [7] }).success).toBe(
      false,
    );
    expect(commandSchema.safeParse({ ...daily, weekdays: [] }).success).toBe(
      false,
    );
    expect(commandSchema.safeParse({ ...add(), title: " " }).success).toBe(
      false,
    );
    expect(commandSchema.safeParse({ ...add(), extra: true }).success).toBe(
      false,
    );
    const f = fixture();
    await expect(f.engine.mutate(null)).rejects.toMatchObject({
      code: "invalid-request",
    });
    const value = await f.send({ ...daily, title: "  Walk  " });
    expect(value.state.routines[0]!.title).toBe("Walk");
    const bad = structuredClone(f.persistence.value);
    bad.state.tasks.push(structuredClone(bad.state.tasks[0]!));
    expect(aggregateSchema.safeParse(bad).success).toBe(false);
  });

  it("uses local-zone dates at midnight and DST boundaries", () => {
    expect(
      dateInZone(new Date("2026-09-07T00:30:00Z"), "America/Los_Angeles"),
    ).toBe("2026-09-06");
    expect(
      dateInZone(new Date("2026-03-08T09:59:59Z"), "America/Los_Angeles"),
    ).toBe("2026-03-08");
    expect(
      dateInZone(new Date("2026-03-08T10:00:00Z"), "America/Los_Angeles"),
    ).toBe("2026-03-08");
  });
});
