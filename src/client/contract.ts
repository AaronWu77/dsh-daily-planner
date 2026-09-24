/** Derived slot props for both root-scoped planner entries. */
import type {
  InjectFace,
  PropsLocale,
  PropsRuntime,
  PropsStore,
} from "@deepseek-ai/dsh-client-ui-slots";
import type {} from "@deepseek-ai/dsh-client-ui-sidebar/client";
import type {} from "@deepseek-ai/dsh-client-ui-layout/client";
import type { PlannerModel } from "./model.ts";
import type { createPlannerViewStore } from "./view-store.ts";
import type { NS } from "./locales.ts";
export interface PlannerInjected {
  hooks: { planner: PlannerModel };
  run: PlannerModel["run"];
  refresh: PlannerModel["refresh"];
  retry: PlannerModel["retry"];
  confirmDuplicate: PlannerModel["confirmDuplicate"];
  dismiss: PlannerModel["dismiss"];
  returnFocus: () => void;
}
export type PlannerProps = PropsStore<
  ReturnType<typeof createPlannerViewStore>
> &
  PropsLocale<typeof NS> &
  InjectFace<PlannerInjected>;
export type EntryProps = PlannerProps & PropsRuntime<"sidebar.footer.action">;
