import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Context } from "@deepseek-ai/cordis";
import Storage from "@deepseek-ai/dsh-storage";
import { DomainFacility } from "@deepseek-ai/dsh-storage-domain";
import { JsonStorageBackend } from "@deepseek-ai/dsh-storage-json";
import { HostConnectionService } from "@deepseek-ai/dsh-client-connection";
import * as plugin from "../src/host/index.ts";
import { plannerDomainSpec } from "../src/host/domain.ts";
import { initialAggregate, PlannerEngine } from "../src/host/engine.ts";
import { snapshotSchema, taskId } from "../src/shared/model.ts";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const dispose of cleanup.splice(0).reverse()) await dispose();
});
async function harness() {
  const root = await mkdtemp(join(tmpdir(), "daily-planner-test-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const ctx = new Context();
  cleanup.push(() => ctx.fiber.dispose());
  await ctx.plugin(Storage);
  const backend = new JsonStorageBackend(root);
  cleanup.push(() => backend.close());
  ctx.storage.backend.register("json", backend);
  const facility = new DomainFacility(ctx, { backend: "json" });
  cleanup.push(() => facility.closeAll());
  ctx.storage.mount("domain", facility);
  ctx.provide("storageDomain", facility);
  return { ctx, root, facility };
}

describe("real storage-domain aggregate", () => {
  it("reopens one durable aggregate with unchanged identities and retry receipts", async () => {
    const { facility, root } = await harness();
    const domain = await facility.open(plannerDomainSpec("UTC"));
    const engine = new PlannerEngine(
      {
        get: () => domain.global.get(),
        set: (value) => domain.global.set(value),
        close: () => domain.close(),
      },
      "UTC",
      () => new Date("2026-09-07T12:00:00Z"),
    );
    cleanup.push(() => engine.dispose());
    const request = {
      expectedRevision: 0,
      operationId: "durable-retry",
      command: {
        type: "task.add",
        id: taskId("durable-task"),
        title: "Persisted",
        date: "2026-09-07",
      },
    };
    const first = await engine.mutate(request);
    await engine.dispose();
    const bytes = JSON.parse(
      await readFile(join(root, "daily_planner.json"), "utf8"),
    ) as {
      unit: { name: string; version: number };
      global: { state: unknown; receipts: unknown[] };
      tables: unknown;
    };
    expect(bytes.unit).toEqual({ name: "daily_planner", version: 1 });
    expect(bytes.tables).toEqual({});
    expect(bytes.global.state).toEqual(first.state);
    expect(bytes.global.receipts).toHaveLength(1);
    const reopened = await facility.open(plannerDomainSpec("UTC"));
    const second = new PlannerEngine(
      {
        get: () => reopened.global.get(),
        set: (value) => reopened.global.set(value),
        close: () => reopened.close(),
      },
      "UTC",
      () => new Date("2026-09-07T12:00:00Z"),
    );
    cleanup.push(() => second.dispose());
    expect(await second.mutate(request)).toEqual(first);
    expect(await second.read()).toEqual(first);
  });

  it("refuses a schema-invalid durable aggregate without silently resetting user data", async () => {
    const { facility, root } = await harness();
    const bad = initialAggregate("UTC");
    const malformed = {
      unit: { name: "daily_planner", version: 1 },
      global: { ...bad, state: { ...bad.state, revision: -1 } },
      tables: {},
    };
    const path = join(root, "daily_planner.json");
    const text = JSON.stringify(malformed);
    await writeFile(path, text);
    await expect(facility.open(plannerDomainSpec("UTC"))).rejects.toMatchObject(
      { code: "invalid-record" },
    );
    expect(await readFile(path, "utf8")).toBe(text);
  });
});

describe("real Connection exact registration and plugin disposal", () => {
  it("rejects a mismatched saved time zone without changing disk and releases the domain", async () => {
    const { ctx, facility, root } = await harness();
    const domain = await facility.open(plannerDomainSpec("UTC"));
    await domain.global.set(initialAggregate("UTC"));
    await domain.close();
    const path = join(root, "daily_planner.json");
    const before = await readFile(path, "utf8");
    const carrier = ctx.plugin((connectionCtx) => {
      new HostConnectionService(
        connectionCtx,
        [],
        {} as ConstructorParameters<typeof HostConnectionService>[2],
      );
    });
    await carrier;
    cleanup.push(() => carrier.dispose());
    const connection = ctx.get("connection") as HostConnectionService;
    const fiber = ctx.plugin(
      plugin,
      plugin.Config({ timeZone: "Asia/Shanghai" } as plugin.Config),
    );
    await expect(fiber.await()).rejects.toMatchObject({
      code: "timezone-mismatch",
    });
    expect(facility.get("daily_planner")).toBeUndefined();
    expect(await readFile(path, "utf8")).toBe(before);
    expect(
      (
        await connection
          .createSharedFetchHandler("/api")
          .fetch(new Request("http://localhost/api/dsh-daily-planner"))
      ).status,
    ).toBe(404);
    const recovered = await facility.open(plannerDomainSpec("UTC"));
    expect(recovered.global.get()).toEqual(initialAggregate("UTC"));
    await recovered.close();
  });

  it("closes the acquired domain when exact route registration fails", async () => {
    const { ctx, facility } = await harness();
    const carrier = ctx.plugin((connectionCtx) => {
      new HostConnectionService(
        connectionCtx,
        [],
        {} as ConstructorParameters<typeof HostConnectionService>[2],
      );
    });
    await carrier;
    cleanup.push(() => carrier.dispose());
    const connection = ctx.get("connection") as HostConnectionService;
    const unregister = connection.fetch.register({
      path: "/api/dsh-daily-planner",
      methods: ["GET"],
      requestBody: "buffered",
      fetch: async () => new Response("occupied"),
    });
    cleanup.push(unregister);
    const fiber = ctx.plugin(
      plugin,
      plugin.Config({ timeZone: "UTC" } as plugin.Config),
    );
    await expect(fiber.await()).rejects.toThrow("already registered");
    expect(facility.get("daily_planner")).toBeUndefined();
    const recovered = await facility.open(plannerDomainSpec("UTC"));
    expect(recovered.global.get()).toEqual(initialAggregate("UTC"));
    await recovered.close();
  });
  it("mounts only the exact path and methods, removes it on unload, and reopens the domain", async () => {
    const { ctx, facility } = await harness();
    const carrier = ctx.plugin((connectionCtx) => {
      // Shared dispatch tests do not invoke authentication; the physical carrier owns that policy.
      new HostConnectionService(
        connectionCtx,
        [],
        {} as ConstructorParameters<typeof HostConnectionService>[2],
      );
    });
    await carrier;
    cleanup.push(() => carrier.dispose());
    const connection = ctx.get("connection") as HostConnectionService;
    const shared = connection.createSharedFetchHandler("/api");
    const fiber = ctx.plugin(
      plugin,
      plugin.Config({ timeZone: "UTC" } as plugin.Config),
    );
    await fiber;
    cleanup.push(() => fiber.dispose());
    const response = await shared.fetch(
      new Request("http://localhost/api/dsh-daily-planner"),
    );
    expect(response.status).toBe(200);
    const initial = snapshotSchema.parse(await response.json());
    for (const [path, method] of [
      ["/dsh-daily-planner", "GET"],
      ["/api/dsh-daily-planner/extra", "GET"],
      ["/api/dsh-daily-planner", "DELETE"],
      ["/api/dsh-daily-planner", "HEAD"],
    ]) {
      expect(
        (await shared.fetch(new Request("http://localhost" + path, { method })))
          .status,
      ).toBe(404);
    }
    const post = await shared.fetch(
      new Request("http://localhost/api/dsh-daily-planner", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          expectedRevision: initial.state.revision,
          operationId: "mounted-add",
          command: {
            type: "task.add",
            id: "one",
            title: "From real route",
            date: initial.today,
          },
        }),
      }),
    );
    expect(post.status).toBe(200);
    await fiber.dispose();
    expect(
      (
        await shared.fetch(
          new Request("http://localhost/api/dsh-daily-planner"),
        )
      ).status,
    ).toBe(404);
    expect(facility.get("daily_planner")).toBeUndefined();
    const again = ctx.plugin(
      plugin,
      plugin.Config({ timeZone: "UTC" } as plugin.Config),
    );
    await again;
    cleanup.push(() => again.dispose());
    const persisted = snapshotSchema.parse(
      await (
        await shared.fetch(
          new Request("http://localhost/api/dsh-daily-planner"),
        )
      ).json(),
    );
    expect(persisted.state.tasks[0]!.title).toBe("From real route");
    expect(persisted.state.revision).toBe(1);
  });
});
