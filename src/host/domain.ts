/** Storage-domain declaration: a single schema-validated authoritative aggregate. */
import { defineDomain } from "@deepseek-ai/dsh-storage-domain";
import { aggregateSchema, initialAggregate } from "./engine.ts";

/** Declare the global planner record. @param timeZone Zone for a never-written planner. @returns Storage-domain specification. */
export function plannerDomainSpec(timeZone: string) {
  return defineDomain({
    name: "daily_planner",
    version: 1,
    layout: "single",
    tables: {},
    global: { schema: aggregateSchema, initial: initialAggregate(timeZone) },
  });
}
