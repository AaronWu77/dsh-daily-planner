/** Shared viewing state only; business tasks belong to PlannerModel. */
import { defineStore } from "@deepseek-ai/dsh-client-store";
import type { RoutineId, TaskId } from "../shared/model.ts";
export type View = "today" | "earlier" | "routines" | "review" | "deleted";
export interface Editor {
  kind: "edit" | "move";
  id: TaskId;
  title: string;
  date: string;
  /** Revision captured when this draft opens, never advanced by a background refresh. */
  revision: number;
}
export interface RoutineDraft {
  id: RoutineId | null;
  title: string;
  weekdays: number[];
  enabled: boolean;
  /** Revision captured when this draft opens, never advanced by a background refresh. */
  revision: number;
}
interface State {
  open: boolean;
  view: View;
  reviewDate: string;
  draft: string;
  editor: Editor | null;
  routineDraft: RoutineDraft | null;
  deleteRoutineId: RoutineId | null;
  anchor: { right: number; bottom: number };
  notice: "deleted" | "plannedNotice" | "closedNotice" | "routineSaved" | null;
  undoId: TaskId | null;
}
/** Creates the registration-owned view store. */
export function createPlannerViewStore() {
  return defineStore({
    init: (): State => ({
      open: false,
      view: "today",
      reviewDate: "",
      draft: "",
      editor: null,
      routineDraft: null,
      deleteRoutineId: null,
      anchor: { right: 288, bottom: 560 },
      notice: null,
      undoId: null,
    }),
    actions: {
      toggle: (d, anchor: State["anchor"]) => {
        d.open = !d.open;
        d.anchor = anchor;
      },
      close: (d) => {
        d.open = false;
      },
      navigate: (d, view: View, date = "") => {
        d.view = view;
        d.reviewDate = date;
        d.notice = null;
      },
      setDraft: (d, text: string) => {
        d.draft = text;
      },
      setEditor: (d, editor: Editor | null) => {
        d.editor = editor;
      },
      setRoutineDraft: (d, draft: RoutineDraft | null) => {
        d.routineDraft = draft;
      },
      setDeleteRoutine: (d, id: RoutineId | null) => {
        d.deleteRoutineId = id;
      },
      notify: (d, notice: State["notice"], undoId: TaskId | null = null) => {
        d.notice = notice;
        d.undoId = undoId;
      },
    },
  });
}
