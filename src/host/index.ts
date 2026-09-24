/** Host plugin entry; the planner is independent of sessions and agents. */
import type { Context } from "@deepseek-ai/cordis";
import type {} from "@deepseek-ai/dsh-client-connection";
import Schema from "@deepseek-ai/schemastery";
import { timeZoneSchema } from "../shared/model.ts";
import { PlannerEngine } from "./engine.ts";
import { plannerDomainSpec } from "./domain.ts";
import { plannerRoute } from "./route.ts";

export const name = "dsh-daily-planner";
export const inject = ["storageDomain", "connection"];
/** Host zone and public card configuration. */
export interface Config {
  timeZone: string;
  refreshIntervalMs: number;
  requestTimeoutMs: number;
  sidebarOrder: number;
}
export const Config: Schema<Config> = Schema.object({
  timeZone: Schema.transform(Schema.string(), (value) =>
    timeZoneSchema.parse(value),
  ).default(Intl.DateTimeFormat().resolvedOptions().timeZone),
  refreshIntervalMs: Schema.number().min(1000).step(1).default(60000),
  requestTimeoutMs: Schema.number().min(1000).step(1).default(15000),
  sidebarOrder: Schema.number().default(5),
});

/** Open the aggregate and attach the exact route with drain-before-close teardown. @param ctx Injected plugin context. @param config Validated configuration. @returns Setup completion. */
export async function apply(ctx: Context, config: Config): Promise<void> {
  timeZoneSchema.parse(config.timeZone);
  await ctx.effect(async function* () {
    const domain = await ctx.storageDomain.open(
      plannerDomainSpec(config.timeZone),
    );
    let engine: PlannerEngine | undefined;
    yield () => (engine ? engine.dispose() : domain.close());
    engine = new PlannerEngine(
      {
        get: () => domain.global.get(),
        set: (value) => domain.global.set(value),
        close: () => domain.close(),
      },
      config.timeZone,
    );
    yield ctx.connection.fetch.register(
      plannerRoute(engine, (error) =>
        ctx.logger.error("Daily planner request failed: %s", String(error)),
      ),
    );
  }, "daily-planner: aggregate and route");
}
