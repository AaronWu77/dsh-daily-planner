import { afterEach, describe, expect, it, vi } from "vitest";
import { initialAggregate, PlannerEngine } from "../src/host/engine.ts";
import { plannerRoute } from "../src/host/route.ts";
import { Config, inject, name } from "../src/host/index.ts";
import { snapshotSchema } from "../src/shared/model.ts";

const engines: PlannerEngine[] = [];
afterEach(async () => {
  await Promise.all(engines.splice(0).map((engine) => engine.dispose()));
});
function fixture() {
  let value = initialAggregate("UTC");
  const set = vi.fn(async (next: typeof value) => {
    value = next;
  });
  const report = vi.fn();
  const engine = new PlannerEngine(
    { get: () => value, set, close: async () => {} },
    "UTC",
    () => new Date("2026-09-07T12:00:00Z"),
  );
  engines.push(engine);
  return { route: plannerRoute(engine, report), report, set, engine };
}
const request = {
  expectedRevision: 0,
  operationId: "operation",
  command: {
    type: "task.add",
    id: "one",
    title: "Buy tea",
    date: "2026-09-07",
  },
};
function post(body: unknown) {
  return new Request("http://localhost/api/dsh-daily-planner", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("planner HTTP adapter", () => {
  it("declares only the exact buffered GET/POST path and direct snapshot responses", async () => {
    const f = fixture();
    expect(f.route.path).toBe("/api/dsh-daily-planner");
    expect(f.route.methods).toEqual(["GET", "POST"]);
    expect(f.route.requestBody).toBe("buffered");
    const get = await f.route.fetch(
      new Request("http://localhost/api/dsh-daily-planner"),
    );
    expect(get.status).toBe(200);
    expect(get.headers.get("cache-control")).toBe("no-store");
    expect(snapshotSchema.parse(await get.json()).state.revision).toBe(0);
    const response = await f.route.fetch(post(request));
    expect(response.status).toBe(200);
    expect(
      snapshotSchema.parse(await response.json()).state.tasks[0]!.title,
    ).toBe("Buy tea");
  });

  it("returns structured 400 errors for malformed, invalid, missing and non-JSON bodies", async () => {
    const f = fixture();
    for (const input of [
      new Request("http://localhost/api/dsh-daily-planner", {
        method: "POST",
        body: "{",
        headers: { "content-type": "application/json" },
      }),
      new Request("http://localhost/api/dsh-daily-planner", {
        method: "POST",
        body: "{}",
      }),
      new Request("http://localhost/api/dsh-daily-planner", {
        method: "POST",
        headers: { "content-type": "application/json" },
      }),
      post({ ...request, command: { ...request.command, title: "" } }),
      post({ ...request, expectedRevision: -1 }),
    ]) {
      const response = await f.route.fetch(input);
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({
        error: { code: "invalid-request", message: expect.any(String) },
      });
    }
    expect(f.set).not.toHaveBeenCalled();
    expect(f.report).not.toHaveBeenCalled();
  });

  it("counts encoded bytes and accepts exactly 64KiB while rejecting the next byte", async () => {
    const f = fixture();
    const base = JSON.stringify(request);
    const exact = base + " ".repeat(64 * 1024 - Buffer.byteLength(base));
    expect(
      (
        await f.route.fetch(
          new Request("http://localhost/api/dsh-daily-planner", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: exact,
          }),
        )
      ).status,
    ).toBe(200);
    const oversized = await f.route.fetch(
      new Request("http://localhost/api/dsh-daily-planner", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: exact + " ",
      }),
    );
    expect(oversized.status).toBe(400);
    expect(await oversized.json()).toMatchObject({
      error: {
        code: "invalid-request",
        message: expect.stringContaining("64 KiB"),
      },
    });
    const unicode = await f.route.fetch(
      new Request("http://localhost/api/dsh-daily-planner", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "界".repeat(24000),
      }),
    );
    expect(unicode.status).toBe(400);
    expect(await unicode.json()).toMatchObject({
      error: { message: expect.stringContaining("64 KiB") },
    });
    expect(f.set).toHaveBeenCalledTimes(1);
  });

  it("returns 409 for stale revision and does not duplicate safe retries", async () => {
    const f = fixture();
    const first = await f.route.fetch(post(request));
    const firstBody = await first.json();
    expect(await (await f.route.fetch(post(request))).json()).toEqual(
      firstBody,
    );
    const stale = await f.route.fetch(
      post({ ...request, operationId: "another" }),
    );
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({ error: { code: "conflict" } });
    const mismatch = await f.route.fetch(
      post({ ...request, command: { ...request.command, title: "Different" } }),
    );
    expect(mismatch.status).toBe(409);
    expect(await mismatch.json()).toMatchObject({
      error: { code: "operation-mismatch" },
    });
    expect(f.set).toHaveBeenCalledTimes(1);
  });

  it("returns duplicate-occurrence confirmation as a 409 without altering tasks", async () => {
    const f = fixture();
    const saved = await f.route.fetch(
      post({
        ...request,
        command: {
          type: "routine.save",
          id: "daily",
          title: "Walk",
          weekdays: [0, 1, 2, 3, 4, 5, 6],
          enabled: true,
        },
      }),
    );
    const state = snapshotSchema.parse(await saved.json()).state;
    const collision = await f.route.fetch(
      post({
        expectedRevision: state.revision,
        operationId: "move",
        command: {
          type: "task.move",
          id: state.tasks[0]!.id,
          date: "2026-09-08",
        },
      }),
    );
    expect(collision.status).toBe(409);
    expect(await collision.json()).toMatchObject({
      error: { code: "duplicate-occurrence" },
    });
    expect((await f.engine.read()).state).toEqual(state);
  });

  it("reports persistence errors privately and returns a generic 500 without committing", async () => {
    const f = fixture();
    f.set.mockRejectedValueOnce(new Error("private disk location"));
    const response = await f.route.fetch(post(request));
    expect(response.status).toBe(500);
    const body = await response.json();
    expect(body).toMatchObject({ error: { code: "internal-error" } });
    expect(JSON.stringify(body)).not.toContain("private disk");
    expect(f.report).toHaveBeenCalledTimes(1);
    expect((await f.engine.read()).state.revision).toBe(0);
    expect((await f.route.fetch(post(request))).status).toBe(200);
  });
});

describe("host plugin declaration", () => {
  it("exports the named plugin with explicit injected services and host-zone defaults", () => {
    expect(name).toBe("dsh-daily-planner");
    expect(inject).toEqual(["storageDomain", "connection"]);
    expect(Config({} as Config)).toEqual({
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      refreshIntervalMs: 60000,
      requestTimeoutMs: 15000,
      sidebarOrder: 5,
    });
  });
  it("rejects invalid zones and fractional or too-small timing configuration", () => {
    for (const patch of [
      { timeZone: "Not/AZone" },
      { refreshIntervalMs: 999 },
      { refreshIntervalMs: 1000.5 },
      { requestTimeoutMs: 999 },
      { requestTimeoutMs: 1000.5 },
    ])
      expect(() => Config(patch as unknown as Config)).toThrow();
    expect(
      Config({
        timeZone: "Asia/Shanghai",
        refreshIntervalMs: 1000,
        requestTimeoutMs: 1000,
        sidebarOrder: 0,
      }),
    ).toMatchObject({
      timeZone: "Asia/Shanghai",
      refreshIntervalMs: 1000,
      sidebarOrder: 0,
    });
  });
});
