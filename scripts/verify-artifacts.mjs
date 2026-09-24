#!/usr/bin/env node
/** Verify existing lib artifacts without building, serving, or touching user data.
 * Run: node scripts/verify-artifacts.mjs
 * Optional: CHROMIUM_PATH overrides the local Playwright executable.
 */
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Context } from "@deepseek-ai/cordis";
import Storage from "@deepseek-ai/dsh-storage";
import { DomainFacility } from "@deepseek-ai/dsh-storage-domain";
import { JsonStorageBackend } from "@deepseek-ai/dsh-storage-json";
import { HostConnectionService } from "@deepseek-ai/dsh-client-connection";
import * as plugin from "../lib/index.js";
import { verifyBrowserArtifact } from "../tests/artifact-browser.mjs";

// Builds are an explicit prerequisite; this verifier never repairs stale artifacts.
const sourceRoot = new URL("../src/", import.meta.url);
const sources = (await readdir(sourceRoot, { recursive: true, withFileTypes: true }))
  .filter((entry) => entry.isFile())
  .map((entry) => join(entry.parentPath, entry.name));
sources.push(new URL("../tsdown.config.ts", import.meta.url), new URL("../package.json", import.meta.url));
const newestSource = Math.max(...await Promise.all(sources.map(async (path) => (await stat(path)).mtimeMs)));
for (const artifact of ["index.js", "client.js", "client.js.map"]) {
  const info = await stat(new URL("../lib/" + artifact, import.meta.url));
  assert.ok(info.mtimeMs >= newestSource, artifact + " is older than source/configuration; run pnpm run build first");
}
console.log("PASS artifact freshness: outputs are newer than source/configuration");

const root = await mkdtemp(join(tmpdir(), "daily-planner-artifacts-"));
const ctx = new Context();
const backend = new JsonStorageBackend(root);
let facility;
try {
  await ctx.plugin(Storage);
  ctx.storage.backend.register("json", backend);
  facility = new DomainFacility(ctx, { backend: "json" });
  ctx.storage.mount("domain", facility);
  ctx.provide("storageDomain", facility);
  await assert.rejects(
    facility.open({ name: "daily-planner", version: 1, layout: "single", tables: {} }),
    /name|domain/i,
    "real domain validator must reject the old hyphenated name",
  );
  await ctx.plugin((connectionCtx) => {
    // The transport owns authentication; this test exercises its shared dispatcher.
    new HostConnectionService(connectionCtx, [], {});
  });
  const connection = ctx.get("connection");
  const shared = connection.createSharedFetchHandler("/api");
  const fetchRoute = (path = "/api/dsh-daily-planner", init) =>
    shared.fetch(new Request("http://localhost" + path, init));
  const mount = async () => {
    const fiber = ctx.plugin(plugin, plugin.Config({ timeZone: "UTC" }));
    await fiber;
    assert.ok(facility.get("daily_planner"), "built plugin must open daily_planner using the real domain validator");
    return { fiber };
  };
  const { fiber } = await mount();
  const initialResponse = await fetchRoute();
  assert.equal(initialResponse.status, 200);
  const initial = await initialResponse.json();
  assert.equal(initial.state.revision, 0);
  for (const [path, method] of [
    ["/dsh-daily-planner", "GET"],
    ["/api/dsh-daily-planner/extra", "GET"],
    ["/api/dsh-daily-planner", "DELETE"],
    ["/api/dsh-daily-planner", "HEAD"],
  ]) assert.equal((await fetchRoute(path, { method })).status, 404);
  const request = {
    expectedRevision: 0,
    operationId: "artifact-add",
    command: { type: "task.add", id: "artifact-task", title: "Durable artifact task", date: initial.today },
  };
  const post = () => fetchRoute(undefined, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(request),
  });
  const response = await post();
  assert.equal(response.status, 200);
  const saved = await response.json();
  assert.equal(saved.state.tasks[0].title, "Durable artifact task");
  await fiber.dispose();
  assert.equal((await fetchRoute()).status, 404, "unload must remove route");
  assert.equal(facility.get("daily_planner"), undefined, "unload must close domain");
  const bytes = JSON.parse(await readFile(join(root, "daily_planner.json"), "utf8"));
  assert.deepEqual(bytes.unit, { name: "daily_planner", version: 1 });
  assert.deepEqual(bytes.global.state, saved.state);
  assert.equal(bytes.global.receipts.length, 1);
  const { fiber: reopened } = await mount();
  assert.deepEqual((await (await fetchRoute()).json()).state, saved.state);
  const retry = await post();
  assert.equal(retry.status, 200);
  assert.deepEqual(await retry.json(), saved, "retry receipts survive reopening");
  await reopened.dispose();
  assert.equal((await fetchRoute()).status, 404);
  assert.equal(facility.get("daily_planner"), undefined);

  // Failed setup must release its newly opened domain as well.
  const unregister = connection.fetch.register({ path: "/api/dsh-daily-planner", methods: ["GET"], requestBody: "buffered", fetch: async () => new Response("occupied") });
  try {
    const failed = ctx.plugin(plugin, plugin.Config({ timeZone: "UTC" }));
    await assert.rejects(failed.await(), /already registered/);
    assert.equal(facility.get("daily_planner"), undefined);
  } finally { unregister(); }
  console.log("PASS built host: real domain name, route dispatch, durable reopen/retry, disposal and failed-setup cleanup");
} finally {
  try { await ctx.fiber.dispose(); }
  finally {
    try { await facility?.closeAll(); }
    finally {
      try { await backend.close(); }
      finally { await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
    }
  }
}
await verifyBrowserArtifact();
