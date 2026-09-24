/** Root-scoped sidebar toggle and non-modal floating card. */
import type { Context } from "@deepseek-ai/cordis";
import type {} from "@deepseek-ai/dsh-client-ui-renderer/client";
import type {} from "@deepseek-ai/dsh-client-locale/client";
import { en, zh, NS } from "./locales.ts";
import { PlannerEntry, PlannerCard } from "./Planner.tsx";
import { PlannerModel } from "./model.ts";
import { createPlannerViewStore } from "./view-store.ts";
import type { PlannerInjected } from "./contract.ts";
export const inject = ["slots", "locale"];
/** Mount a planner with browser defaults when the loader omits config; unload releases requests and listeners. */
export function apply(
  ctx: Context,
  config: {
    refreshIntervalMs?: number;
    sidebarOrder?: number;
    requestTimeoutMs?: number;
  } = {},
) {
  const channel =
    typeof BroadcastChannel === "undefined"
      ? null
      : new BroadcastChannel("dsh-daily-planner:" + location.origin);
  const model = new PlannerModel(
    (input, init) => fetch(input, init),
    () => channel?.postMessage("changed"),
    config.requestTimeoutMs ?? 15000,
  );
  const handle = createPlannerViewStore();
  const face: PlannerInjected = {
    hooks: { planner: model },
    run: model.run,
    refresh: model.refresh,
    retry: model.retry,
    confirmDuplicate: model.confirmDuplicate,
    dismiss: model.dismiss,
    returnFocus: () => document.getElementById("daily-planner-toggle")?.focus(),
  };
  ctx.effect(
    () => ctx.locale.register(NS, { en, zh }),
    "daily-planner: locales",
  );
  ctx.effect(() => {
    const refresh = () => {
      if (document.visibilityState !== "hidden") void model.refresh();
    };
    channel?.addEventListener("message", refresh);
    window.addEventListener("focus", refresh);
    window.addEventListener("online", refresh);
    document.addEventListener("visibilitychange", refresh);
    const timer = setInterval(refresh, config.refreshIntervalMs ?? 60000);
    refresh();
    return () => {
      clearInterval(timer);
      window.removeEventListener("focus", refresh);
      window.removeEventListener("online", refresh);
      document.removeEventListener("visibilitychange", refresh);
      channel?.removeEventListener("message", refresh);
      channel?.close();
      return model.dispose();
    };
  }, "daily-planner: synchronization");
  ctx.slots.inject("sidebar.footer.action", () =>
    ctx.slots.register(
      {
        name: "sidebar.footer.action",
        id: "daily-planner-toggle",
        order: config.sidebarOrder ?? 5,
        locale: NS,
        store: handle,
        inject: () => face,
      },
      PlannerEntry,
    ),
  );
  ctx.slots.inject("shell.overlay", () =>
    ctx.slots.register(
      {
        name: "shell.overlay",
        id: "daily-planner-card",
        order: 5,
        locale: NS,
        store: handle,
        inject: () => face,
      },
      PlannerCard,
    ),
  );
}
