import { describe, it, expect, vi } from "vitest";
import { PlannerModel } from "../src/client/model.ts";
import { taskId, type PlannerSnapshot } from "../src/shared/model.ts";
const base = (revision = 1): PlannerSnapshot => ({
  today: "2026-09-21",
  state: {
    revision,
    timeZone: "UTC",
    tasks: [],
    routines: [],
    days: { "2026-09-21": { planned: false, closed: false } },
  },
});
const add = {
  type: "task.add" as const,
  id: taskId("test-task"),
  title: "A task",
  date: "2026-09-21",
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
describe("browser task mirror", () => {
  it("does not show a write as saved before its durable response", async () => {
    const pending = deferred<Response>();
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json(base()))
      .mockReturnValueOnce(pending.promise);
    const model = new PlannerModel(request);
    await model.refresh();
    const command = model.run(add);
    expect(model.getSnapshot().busy).toBe(true);
    expect(model.getSnapshot().data?.state.tasks).toEqual([]);
    pending.resolve(
      Response.json({
        ...base(2),
        state: {
          ...base(2).state,
          tasks: [
            {
              ...add,
              id: add.id,
              type: undefined,
              originalDate: add.date,
              status: "open",
              order: 0,
            },
          ].map(({ type, ...task }) => task),
        },
      }),
    );
    expect(await command).toBe(true);
    expect(model.getSnapshot().data?.state.tasks).toHaveLength(1);
    await model.dispose();
  });
  it("retries a lost response with exactly the same operation id and blocks other mutations meanwhile", async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json(base()))
      .mockRejectedValueOnce(new TypeError("offline"))
      .mockResolvedValueOnce(Response.json(base(2)));
    const model = new PlannerModel(request);
    await model.refresh();
    expect(await model.run(add)).toBe(false);
    expect(model.getSnapshot().retryCommand).toEqual(add);
    expect(await model.run({ ...add, id: taskId("other") })).toBe(false);
    expect(model.getSnapshot().retryable).toBe(true);
    expect(await model.retry()).toBe(true);
    expect(request.mock.calls[1]?.[1]?.body).toBe(
      request.mock.calls[2]?.[1]?.body,
    );
    await model.dispose();
  });
  it("refreshes after a revision conflict instead of silently reapplying", async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json(base()))
      .mockResolvedValueOnce(
        Response.json(
          { error: { code: "conflict", message: "stale" } },
          { status: 409 },
        ),
      )
      .mockResolvedValueOnce(Response.json(base(5)));
    const model = new PlannerModel(request);
    await model.refresh();
    expect(await model.run(add)).toBe(false);
    expect(model.getSnapshot().data?.state.revision).toBe(5);
    expect(model.getSnapshot().error).toBe("conflict");
    expect(request).toHaveBeenCalledTimes(3);
    await model.dispose();
  });
  it("does not replace a fresh command response with an older GET response", async () => {
    const old = deferred<Response>();
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json(base()))
      .mockReturnValueOnce(old.promise)
      .mockResolvedValueOnce(Response.json(base(4)));
    const model = new PlannerModel(request);
    await model.refresh();
    const refresh = model.refresh();
    await model.run(add);
    old.resolve(Response.json(base(2)));
    await refresh;
    expect(model.getSnapshot().data?.state.revision).toBe(4);
    await model.dispose();
  });
  it("requires explicit confirmation before resending a colliding routine move", async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json(base()))
      .mockResolvedValueOnce(
        Response.json(
          { error: { code: "duplicate-occurrence" } },
          { status: 409 },
        ),
      )
      .mockResolvedValueOnce(Response.json(base(2)));
    const model = new PlannerModel(request);
    await model.refresh();
    const command = {
      type: "task.move" as const,
      id: add.id,
      date: "2026-09-22",
    };
    await model.run(command);
    expect(model.getSnapshot().duplicate).toEqual({
      command,
      expectedRevision: 1,
    });
    expect(request).toHaveBeenCalledTimes(2);
    await model.confirmDuplicate();
    expect(
      JSON.parse(String(request.mock.calls[2]?.[1]?.body)).command
        .allowDuplicate,
    ).toBe(true);
    await model.dispose();
  });
  it("rejects invalid wire snapshots and retains the last confirmed tasks", async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json(base()))
      .mockResolvedValueOnce(
        Response.json({ state: { tasks: [] }, today: "not-a-date" }),
      );
    const model = new PlannerModel(request);
    await model.refresh();
    await model.refresh();
    expect(model.getSnapshot().data).toEqual(base());
    expect(model.getSnapshot().error).toBe("read");
    await model.dispose();
  });
  it("aborts and drains pending requests without notifying disposed observers", async () => {
    const request = vi.fn<typeof fetch>().mockImplementation(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => reject(new Error("aborted")),
            { once: true },
          );
        }),
    );
    const model = new PlannerModel(request);
    const listener = vi.fn();
    model.subscribe(listener);
    const pending = model.refresh();
    const before = listener.mock.calls.length;
    await model.dispose();
    await pending;
    expect(listener).toHaveBeenCalledTimes(before);
    expect(await model.run(add)).toBe(false);
  });
});
