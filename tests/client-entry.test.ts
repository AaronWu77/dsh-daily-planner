// @vitest-environment jsdom
import { Context } from "@deepseek-ai/cordis";
import { afterEach, expect, it, vi } from "vitest";
import * as plugin from "../src/client/index.ts";

// Component rendering has separate coverage; this fixture exercises Cordis activation.
vi.mock("../src/client/Planner.tsx", () => ({
  PlannerEntry: () => null,
  PlannerCard: () => null,
}));

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

it("activates without loader config and removes its contributions on unload", async () => {
  vi.useFakeTimers();
  vi.stubGlobal("BroadcastChannel", undefined);
  vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 503 })));
  const ctx = new Context();
  const entries = new Set<string>();
  const unregisterLocale = vi.fn();
  const registerLocale = vi.fn(() => unregisterLocale);
  ctx.provide("locale", { register: registerLocale });
  ctx.provide("slots", {
    inject: (_name: string, callback: () => () => void) => ctx.effect(callback),
    register: (options: { id: string }) => {
      entries.add(options.id);
      return () => { entries.delete(options.id); };
    },
  });
  try {
    // Web's client loader creates each entry with only its name, without config.
    const fiber = ctx.plugin(plugin);
    await fiber.await();
    expect([...entries]).toEqual(["daily-planner-toggle", "daily-planner-card"]);
    expect(registerLocale).toHaveBeenCalledOnce();
  } finally {
    await ctx.fiber.dispose();
  }
  expect(entries.size).toBe(0);
  expect(unregisterLocale).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});
