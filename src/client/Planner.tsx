/** Non-modal planner surface; tasks and draft state arrive through framework-derived props. */
import { useEffect, useRef, type CSSProperties } from "react";
import {
  Button,
  Input,
  Checkbox,
  Tooltip,
} from "@deepseek-ai/dsh-client-ui-primitives";
import { taskId, routineId, type Task, type Routine } from "../shared/model.ts";
import type { PlannerProps, EntryProps } from "./contract.ts";
import type { PlannerKey } from "./locales.ts";
import { TaskRow } from "./TaskRow.tsx";
import css from "./Planner.module.css";
function PlanIcon() {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      aria-hidden="true"
    >
      <rect x="4" y="3" width="16" height="18" rx="4" />
      <path d="m7 9 1.5 1.5L11 8m2 1h4M7 15h2m4 0h4" />
    </svg>
  );
}
/** Persistent footer control immediately above the quota widget (order 10). */
export function PlannerEntry(props: EntryProps) {
  const { t, wide, actions, useStore, usePlanner } = props;
  const open = useStore((s) => s.open);
  const model = usePlanner((s) => s);
  const data = model.data;
  const remaining =
    data?.state.tasks.filter(
      (x) => x.date === data.today && x.status === "open",
    ).length ?? 0;
  const badge = !data
    ? "…"
    : data.state.days[data.today]?.closed
      ? t("closed")
      : !data.state.days[data.today]?.planned
        ? t("pendingPlan")
        : t("remaining", { count: remaining });
  return (
    <Tooltip label={t("title") + " · " + badge} disabled={wide}>
      <button
        id="daily-planner-toggle"
        className={css.entry}
        data-active={open}
        data-wide={wide}
        aria-label={t("title")}
        aria-expanded={open}
        aria-controls="daily-planner-card"
        onClick={(event) => {
          const rect = event.currentTarget.getBoundingClientRect();
          actions.toggle({ right: rect.right + 16, bottom: rect.bottom });
          if (!open) void props.refresh();
        }}
      >
        <PlanIcon />
        {wide && (
          <>
            <span className={css.entryLabel}>{t("title")}</span>
            <span className={css.entryBadge}>{badge}</span>
          </>
        )}
      </button>
    </Tooltip>
  );
}
/** Calendar arithmetic deliberately ignores daylight-saving hour lengths. */
export function nextDate(day: string) {
  const date = new Date(day + "T12:00:00Z");
  date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString().slice(0, 10);
}
function errorKey(code: string): PlannerKey {
  if (code === "network") return "errorNetwork";
  if (code === "conflict") return "errorConflict";
  if (code === "read") return "errorRead";
  if (code === "timezone-mismatch") return "errorTimezone";
  if (code === "open-tasks") return "errorOpen";
  if (code === "not-found") return "errorMissing";
  if (
    code === "invalid-request" ||
    code === "invalid-date" ||
    code === "invalid-command"
  )
    return "errorInvalid";
  return "errorGeneric";
}
/** Render one card across conversation switches without capturing outside clicks or keyboard focus. */
export function PlannerCard(props: PlannerProps) {
  const { t, actions, useStore, usePlanner } = props;
  const view = useStore((s) => s);
  const model = usePlanner((s) => s);
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    if (view.open) ref.current?.focus();
  }, [view.open]);
  if (!view.open) return null;
  const close = () => {
    actions.close();
    props.returnFocus();
  };
  const data = model.data;
  const today = data?.today ?? "";
  const tasks = data?.state.tasks ?? [];
  const busy = model.busy || model.retryable;
  const sorted = (items: Task[]) =>
    [...items].sort(
      (a, b) =>
        a.date.localeCompare(b.date) ||
        a.order - b.order ||
        a.id.localeCompare(b.id),
    );
  const current = sorted(
    tasks.filter((x) => x.date === today && x.status !== "deleted"),
  );
  const done = current.filter((x) => x.status === "done");
  const open = current.filter((x) => x.status === "open");
  const earlier = sorted(
    tasks.filter((x) => x.date < today && x.status === "open"),
  );
  const future = sorted(
    tasks.filter((x) => x.date > today && x.status !== "deleted"),
  );
  const reviewDate = view.reviewDate || today;
  const reviewTasks = sorted(
    tasks.filter((x) => x.date === reviewDate && x.status === "open"),
  );
  const title = view.editor
    ? t(view.editor.kind === "edit" ? "edit" : "move")
    : view.view === "today"
      ? t("title")
      : view.view === "earlier"
        ? t("overdue")
        : view.view === "routines"
          ? t("routines")
          : view.view === "deleted"
            ? t("recovery")
            : t("reviewDay", { date: reviewDate });
  const row = (task: Task, review = false) => (
    <TaskRow
      key={task.id}
      task={task}
      allTasks={tasks}
      today={today}
      review={review}
      busy={busy}
      {...props}
    />
  );
  return (
    <section
      id="daily-planner-card"
      data-testid="planner-card"
      ref={ref}
      tabIndex={-1}
      role="dialog"
      aria-modal="false"
      aria-labelledby="planner-title"
      className={css.card}
      style={
        {
          "--planner-left": view.anchor.right + "px",
          "--planner-bottom":
            Math.max(12, window.innerHeight - view.anchor.bottom) + "px",
        } as CSSProperties
      }
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.stopPropagation();
          if (view.editor) {
            if (!busy) actions.setEditor(null);
          } else close();
        }
      }}
    >
      <header className={css.header}>
        <div className={css.heading}>
          {(view.view !== "today" || view.editor) && (
            <Button
              size="sm"
              aria-label={t("back")}
              onClick={() => {
                if (view.editor) {
                  if (!busy) actions.setEditor(null);
                } else actions.navigate("today");
              }}
            >
              ‹
            </Button>
          )}
          <PlanIcon />
          <h2 id="planner-title">{title}</h2>
        </div>
        <Button size="sm" aria-label={t("close")} onClick={close}>
          ×
        </Button>
      </header>
      <div className={css.subtitle}>
        <span>{today}</span>
        <span aria-live="polite">
          {model.busy
            ? t("saving")
            : model.retryable || model.duplicate
              ? t("pendingSave")
              : model.error
                ? t(
                    model.error === "read" ||
                      model.error === "timezone-mismatch"
                      ? "readFailed"
                      : "saveFailed",
                  )
                : model.loading
                  ? t("loading")
                  : data
                    ? t("saved")
                    : ""}
        </span>
      </div>
      {model.error && !model.duplicate && (
        <div className={css.alert} role="alert">
          <p>{t(errorKey(model.error))}</p>
          <div className={css.inline}>
            {model.retryable ? (
              <Button
                size="sm"
                onClick={() => {
                  const command = model.retryCommand;
                  void props.retry().then((ok) => {
                    if (!ok || !command) return;
                    if (command.type === "task.add") actions.setDraft("");
                    if (
                      command.type === "task.edit" ||
                      command.type === "task.move"
                    )
                      actions.setEditor(null);
                    if (command.type === "routine.save")
                      actions.setRoutineDraft(null);
                    if (command.type === "task.delete")
                      actions.notify("deleted", command.id);
                  });
                }}
                disabled={model.busy}
              >
                {t("retry")}
              </Button>
            ) : (
              <>
                <Button size="sm" onClick={() => void props.refresh()}>
                  {t("refresh")}
                </Button>
                {model.error === "conflict" &&
                  data &&
                  (view.editor || view.routineDraft) && (
                    <Button
                      size="sm"
                      disabled={busy}
                      onClick={() => {
                        if (view.editor) {
                          const task = data.state.tasks.find(
                            (task) =>
                              task.id === view.editor!.id &&
                              task.status !== "deleted",
                          );
                          actions.setEditor(
                            task
                              ? {
                                  ...view.editor,
                                  title: task.title,
                                  date: task.date,
                                  revision: data.state.revision,
                                }
                              : null,
                          );
                        }
                        if (view.routineDraft) {
                          const routine = data.state.routines.find(
                            (routine) => routine.id === view.routineDraft!.id,
                          );
                          actions.setRoutineDraft(
                            routine
                              ? { ...routine, revision: data.state.revision }
                              : null,
                          );
                        }
                        props.dismiss();
                      }}
                    >
                      {t("reloadEditor")}
                    </Button>
                  )}
                <Button size="sm" onClick={props.dismiss}>
                  {t("dismiss")}
                </Button>
              </>
            )}
          </div>
        </div>
      )}
      {model.duplicate && (
        <div className={css.alert} role="alert">
          <p>{t("duplicate")}</p>
          <small>{t("duplicateHint")}</small>
          <div className={css.inline}>
            <Button
              size="sm"
              variant="primary"
              disabled={busy}
              onClick={() => {
                void props.confirmDuplicate().then((ok) => {
                  if (ok) actions.setEditor(null);
                });
              }}
            >
              {t("confirmMove")}
            </Button>
            <Button size="sm" disabled={busy} onClick={props.dismiss}>
              {t("cancel")}
            </Button>
          </div>
        </div>
      )}
      {view.notice && (
        <div className={css.notice} role="status">
          <span>{t(view.notice)}</span>
          {view.undoId && (
            <Button
              size="sm"
              disabled={busy}
              onClick={() => {
                if (view.undoId)
                  void props
                    .run({ type: "task.restore", id: view.undoId })
                    .then((ok) => {
                      if (ok) actions.notify(null);
                    });
              }}
            >
              {t("undo")}
            </Button>
          )}
          <Button
            size="sm"
            aria-label={t("dismiss")}
            onClick={() => actions.notify(null)}
          >
            ×
          </Button>
        </div>
      )}
      <div className={css.body}>
        {!data ? (
          <div className={css.empty}>
            {t(model.loading ? "loading" : "reloadHint")}
          </div>
        ) : view.editor ? (
          <form
            className={css.form}
            onSubmit={(event) => {
              event.preventDefault();
              const editor = view.editor!;
              void props
                .run(
                  editor.kind === "edit"
                    ? { type: "task.edit", id: editor.id, title: editor.title }
                    : { type: "task.move", id: editor.id, date: editor.date },
                  editor.revision,
                )
                .then((ok) => {
                  if (ok) actions.setEditor(null);
                });
            }}
          >
            <label>
              {t(view.editor.kind === "edit" ? "titleLabel" : "date")}
              <Input
                autoFocus
                disabled={busy}
                type={view.editor.kind === "edit" ? "text" : "date"}
                min={view.editor.kind === "move" ? today : undefined}
                required
                maxLength={500}
                value={
                  view.editor.kind === "edit"
                    ? view.editor.title
                    : view.editor.date
                }
                onChange={(e) =>
                  actions.setEditor({
                    ...view.editor!,
                    [view.editor!.kind === "edit" ? "title" : "date"]:
                      e.target.value,
                  })
                }
              />
            </label>
            <div className={css.inline}>
              <Button variant="primary" type="submit" disabled={busy}>
                {t("save")}
              </Button>
              <Button disabled={busy} onClick={() => actions.setEditor(null)}>
                {t("cancel")}
              </Button>
            </div>
          </form>
        ) : view.view === "routines" ? (
          <RoutineView {...props} busy={busy} routines={data.state.routines} />
        ) : view.view === "deleted" ? (
          <>
            {tasks.filter((x) => x.status === "deleted").length === 0 ? (
              <div className={css.empty}>{t("noDeleted")}</div>
            ) : (
              sorted(tasks.filter((x) => x.status === "deleted")).map(
                (task) => (
                  <div key={task.id} className={css.recoveryRow}>
                    <div>
                      <span>{task.title}</span>
                      <small>{task.date}</small>
                    </div>
                    <Button
                      size="sm"
                      disabled={busy}
                      onClick={() =>
                        void props.run({ type: "task.restore", id: task.id })
                      }
                    >
                      {t("restore")}
                    </Button>
                  </div>
                ),
              )
            )}
          </>
        ) : view.view === "earlier" ? (
          <>
            <p className={css.hint}>{t("earlierHint")}</p>
            {earlier.length === 0 ? (
              <div className={css.empty}>{t("noEarlier")}</div>
            ) : (
              Object.entries(Object.groupBy(earlier, (x) => x.date)).map(
                ([date, items]) => (
                  <section key={date} className={css.group}>
                    <div className={css.sectionTitle}>
                      <h3>{date}</h3>
                      <Button
                        size="sm"
                        onClick={() => actions.navigate("review", date)}
                      >
                        {t("handle")}
                      </Button>
                    </div>
                    {items!.map((x) => row(x, true))}
                  </section>
                ),
              )
            )}
          </>
        ) : view.view === "review" ? (
          <>
            <p className={css.hint}>{t("reviewHint")}</p>
            {reviewTasks.length ? (
              reviewTasks.map((x) => row(x, true))
            ) : (
              <div className={css.empty}>
                <PlanIcon />
                <p>{t("reviewReady")}</p>
              </div>
            )}
          </>
        ) : (
          <>
            {earlier.length > 0 && (
              <button
                className={css.earlier}
                onClick={() => actions.navigate("earlier")}
              >
                <span>{t("earlier", { count: earlier.length })}</span>
                <span>{t("handle")} →</span>
              </button>
            )}
            <div className={css.sectionTitle}>
              <h3>{t("today")}</h3>
              <span>{t("taskCount", { count: current.length })}</span>
            </div>
            {current.length === 0 && (
              <div className={css.empty}>
                <PlanIcon />
                <p>{t("empty")}</p>
                <small>{t("emptyHint")}</small>
              </div>
            )}
            {open.map((x) => row(x))}
            <form
              className={css.addForm}
              onSubmit={(event) => {
                event.preventDefault();
                if (!view.draft.trim() || !today) return;
                const draft = view.draft;
                void props
                  .run({
                    type: "task.add",
                    id: taskId(crypto.randomUUID()),
                    title: draft,
                    date: today,
                  })
                  .then((ok) => {
                    if (ok) actions.setDraft("");
                  });
              }}
            >
              <Input
                aria-label={t("titleLabel")}
                placeholder={t("addPlaceholder")}
                value={view.draft}
                maxLength={500}
                required
                onChange={(event) => actions.setDraft(event.target.value)}
                disabled={busy}
              />
              <Button
                type="submit"
                size="sm"
                variant="primary"
                aria-label={t("add")}
                disabled={busy || !view.draft.trim()}
              >
                ＋
              </Button>
            </form>
            {done.length > 0 && (
              <details className={css.details}>
                <summary>{t("completed", { count: done.length })}</summary>
                {done.map((x) => row(x))}
              </details>
            )}
            {future.length > 0 && (
              <details className={css.details}>
                <summary>{t("tomorrowList", { count: future.length })}</summary>
                {future.map((x) => row(x))}
              </details>
            )}
          </>
        )}
      </div>
      {data && !view.editor && (
        <footer className={css.footer}>
          {view.view === "today" ? (
            <>
              <Button size="sm" onClick={() => actions.navigate("routines")}>
                {t("routines")}
              </Button>
              {!data.state.days[today]?.planned ? (
                <Button
                  size="sm"
                  variant="primary"
                  disabled={busy}
                  onClick={() =>
                    void props
                      .run({ type: "day.plan", date: today })
                      .then((ok) => {
                        if (ok) actions.notify("plannedNotice");
                      })
                  }
                >
                  {t("start")}
                </Button>
              ) : (
                <Button
                  size="sm"
                  variant="primary"
                  onClick={() => actions.navigate("review", today)}
                >
                  {t(data.state.days[today]?.closed ? "closed" : "review")}
                </Button>
              )}
            </>
          ) : view.view === "review" ? (
            <>
              <span className={css.hint}>
                {t("taskCount", { count: reviewTasks.length })}
              </span>
              {data.state.days[reviewDate]?.closed ? (
                <Button
                  size="sm"
                  disabled={busy}
                  onClick={() =>
                    void props.run({ type: "day.reopen", date: reviewDate })
                  }
                >
                  {t("reopen")}
                </Button>
              ) : (
                <Button
                  size="sm"
                  variant="primary"
                  disabled={busy || reviewTasks.length > 0}
                  onClick={() =>
                    void props
                      .run({ type: "day.close", date: reviewDate })
                      .then((ok) => {
                        if (ok) {
                          actions.navigate("today");
                          actions.notify("closedNotice");
                        }
                      })
                  }
                >
                  {t("finish")}
                </Button>
              )}
            </>
          ) : (
            <>
              <Button size="sm" onClick={() => actions.navigate("today")}>
                {t("back")}
              </Button>
              <Button
                size="sm"
                onClick={() =>
                  actions.navigate(
                    view.view === "deleted" ? "routines" : "deleted",
                  )
                }
              >
                {t(view.view === "deleted" ? "routines" : "recovery")}
              </Button>
            </>
          )}
        </footer>
      )}
      <div
        className={css.footnote}
        title={data ? t("timezone", { zone: data.state.timeZone }) : undefined}
      >
        {t("noAuto")}
      </div>
    </section>
  );
}
const weekdays = [1, 2, 3, 4, 5, 6, 0];
const weekdayKeys = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;
function RoutineView(
  props: PlannerProps & { busy: boolean; routines: Routine[] },
) {
  const { t, actions, busy, routines } = props;
  const draft = props.useStore((s) => s.routineDraft);
  const deleting = props.useStore((s) => s.deleteRoutineId);
  const revision = props.usePlanner((s) => s.data!.state.revision);
  return (
    <>
      <p className={css.hint}>{t("routinesHint")}</p>
      {deleting && (
        <div className={css.alert}>
          <p>{t("deleteRoutineHint")}</p>
          <div className={css.inline}>
            <Button
              size="sm"
              disabled={busy}
              onClick={() =>
                void props
                  .run({ type: "routine.delete", id: deleting })
                  .then((ok) => {
                    if (ok) {
                      actions.setDeleteRoutine(null);
                      if (draft?.id === deleting) actions.setRoutineDraft(null);
                    }
                  })
              }
            >
              {t("confirmDelete")}
            </Button>
            <Button size="sm" onClick={() => actions.setDeleteRoutine(null)}>
              {t("cancel")}
            </Button>
          </div>
        </div>
      )}
      {routines.length === 0 && !draft && (
        <div className={css.empty}>{t("noRoutines")}</div>
      )}
      {routines.map((r) => (
        <div key={r.id} className={css.routineRow}>
          <div className={css.sectionTitle}>
            <strong>{r.title}</strong>
            <span className={css.badge}>
              {t(r.enabled ? "enabled" : "paused")}
            </span>
          </div>
          <small>
            {weekdays
              .filter((day) => r.weekdays.includes(day))
              .map((day) => t(weekdayKeys[day]))
              .join(" · ")}
          </small>
          <div className={css.inline}>
            <Button
              size="sm"
              disabled={busy}
              onClick={() =>
                actions.setRoutineDraft({
                  id: r.id,
                  title: r.title,
                  weekdays: r.weekdays,
                  enabled: r.enabled,
                  revision,
                })
              }
            >
              {t("edit")}
            </Button>
            <Button
              size="sm"
              disabled={busy}
              onClick={() =>
                void props.run({
                  type: "routine.save",
                  ...r,
                  enabled: !r.enabled,
                })
              }
            >
              {t(r.enabled ? "pause" : "resume")}
            </Button>
            <Button
              size="sm"
              disabled={busy}
              onClick={() => actions.setDeleteRoutine(r.id)}
            >
              {t("deleteRoutine")}
            </Button>
          </div>
        </div>
      ))}
      {!draft ? (
        <Button
          variant="outline"
          className={css.fullWidth}
          disabled={busy}
          onClick={() =>
            actions.setRoutineDraft({
              id: null,
              title: "",
              weekdays: [1, 2, 3, 4, 5],
              enabled: true,
              revision,
            })
          }
        >
          {t("addRoutine")}
        </Button>
      ) : (
        <form
          className={css.form}
          onSubmit={(e) => {
            e.preventDefault();
            if (draft.weekdays.length === 0) return;
            void props
              .run(
                {
                  type: "routine.save",
                  title: draft.title,
                  weekdays: draft.weekdays,
                  enabled: draft.enabled,
                  id: draft.id ?? routineId(crypto.randomUUID()),
                },
                draft.revision,
              )
              .then((ok) => {
                if (ok) {
                  actions.setRoutineDraft(null);
                  actions.notify("routineSaved");
                }
              });
          }}
        >
          <label>
            {t("routineName")}
            <Input
              required
              maxLength={500}
              disabled={busy}
              value={draft.title}
              onChange={(e) =>
                actions.setRoutineDraft({ ...draft, title: e.target.value })
              }
            />
          </label>
          <fieldset className={css.fieldset} disabled={busy}>
            <legend>{t("repeat")}</legend>
            <div className={css.inline}>
              <Button
                size="sm"
                onClick={() =>
                  actions.setRoutineDraft({
                    ...draft,
                    weekdays: [0, 1, 2, 3, 4, 5, 6],
                  })
                }
              >
                {t("daily")}
              </Button>
              <Button
                size="sm"
                onClick={() =>
                  actions.setRoutineDraft({
                    ...draft,
                    weekdays: [1, 2, 3, 4, 5],
                  })
                }
              >
                {t("weekdays")}
              </Button>
            </div>
            <div className={css.weekdays}>
              {weekdays.map((day) => (
                <Checkbox
                  key={day}
                  label={t(weekdayKeys[day])}
                  checked={draft.weekdays.includes(day)}
                  onChange={(checked) =>
                    actions.setRoutineDraft({
                      ...draft,
                      weekdays: checked
                        ? [...draft.weekdays, day]
                        : draft.weekdays.filter((x) => x !== day),
                    })
                  }
                />
              ))}
            </div>
          </fieldset>
          <p className={css.hint}>
            {t(draft.weekdays.length ? "routineChanges" : "selectDays")}
          </p>
          <div className={css.inline}>
            <Button
              variant="primary"
              type="submit"
              disabled={busy || !draft.title.trim() || !draft.weekdays.length}
            >
              {t("save")}
            </Button>
            <Button
              disabled={busy}
              onClick={() => actions.setRoutineDraft(null)}
            >
              {t("cancel")}
            </Button>
          </div>
        </form>
      )}
    </>
  );
}
