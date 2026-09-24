/** Task actions remain explicit and keyboard accessible; deletion is recoverable. */
import { useState } from "react";
import { Button, Checkbox } from "@deepseek-ai/dsh-client-ui-primitives";
import type { Task } from "../shared/model.ts";
import type { PlannerProps } from "./contract.ts";
import { nextDate } from "./Planner.tsx";
import css from "./Planner.module.css";
export function TaskRow(
  props: PlannerProps & {
    task: Task;
    allTasks: Task[];
    today: string;
    review: boolean;
    busy: boolean;
  },
) {
  const { task, t, actions, today, busy, review } = props;
  const [expanded, setExpanded] = useState(false);
  const done = task.status === "done";
  const revision = props.usePlanner((s) => s.data!.state.revision);
  const move = (date: string) => {
    void props.run({ type: "task.move", id: task.id, date });
  };
  const reorder = (direction: number) => {
    const same = props.allTasks
      .filter((x) => x.date === task.date && x.status !== "deleted")
      .sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
    const at = same.findIndex((x) => x.id === task.id);
    let next = at + direction;
    while (
      next >= 0 &&
      next < same.length &&
      same[next]!.status !== task.status
    )
      next += direction;
    if (next < 0 || next >= same.length) return;
    [same[at], same[next]] = [same[next]!, same[at]!];
    void props.run({
      type: "task.reorder",
      date: task.date,
      ids: same.map((x) => x.id),
    });
  };
  const remove = () => {
    void props.run({ type: "task.delete", id: task.id }).then((ok) => {
      if (ok) actions.notify("deleted", task.id);
    });
  };
  return (
    <article
      className={css.task}
      data-status={task.status}
      data-task-id={task.id}
    >
      <div className={css.taskMain}>
        <Checkbox
          checked={done}
          onChange={(completed) =>
            void props.run({ type: "task.complete", id: task.id, completed })
          }
          disabled={busy}
          label={task.title}
          title={t(done ? "undoDone" : "done")}
          className={css.taskCheck}
        />
        <Button
          size="sm"
          aria-label={t("more") + " · " + task.title}
          aria-expanded={expanded}
          onClick={() => setExpanded(!expanded)}
        >
          ···
        </Button>
      </div>
      {(task.routineId ||
        task.originalDate !== task.date ||
        task.date !== today) && (
        <div className={css.taskMeta}>
          {task.routineId && <span className={css.badge}>{t("routine")}</span>}
          {task.date !== today && <span>{task.date}</span>}
          {task.originalDate !== task.date && (
            <span>{t("from", { date: task.originalDate })}</span>
          )}
        </div>
      )}
      {expanded && (
        <div className={css.taskActions}>
          <Button
            size="sm"
            disabled={busy}
            onClick={() =>
              actions.setEditor({
                kind: "edit",
                revision,
                id: task.id,
                title: task.title,
                date: task.date,
              })
            }
          >
            {t("edit")}
          </Button>
          {!done && (
            <>
              <Button
                size="sm"
                disabled={busy}
                onClick={() => reorder(-1)}
                aria-label={t("up") + " · " + task.title}
              >
                ↑
              </Button>
              <Button
                size="sm"
                disabled={busy}
                onClick={() => reorder(1)}
                aria-label={t("down") + " · " + task.title}
              >
                ↓
              </Button>
            </>
          )}
          <Button size="sm" disabled={busy} onClick={remove}>
            {t(task.routineId ? "removeOnce" : "remove")}
          </Button>
        </div>
      )}
      {!done && (expanded || review) && (
        <div className={css.taskActions}>
          {task.date < today ? (
            <Button size="sm" disabled={busy} onClick={() => move(today)}>
              {t("moveToday")}
            </Button>
          ) : task.date === today ? (
            <Button
              size="sm"
              disabled={busy}
              onClick={() => move(nextDate(today))}
            >
              {t("tomorrow")}
            </Button>
          ) : null}
          <Button
            size="sm"
            disabled={busy}
            onClick={() =>
              actions.setEditor({
                kind: "move",
                revision,
                id: task.id,
                title: task.title,
                date: nextDate(today),
              })
            }
          >
            {t("chooseDate")}
          </Button>
          {review && !expanded && (
            <Button size="sm" disabled={busy} onClick={remove}>
              {t(task.routineId ? "removeOnce" : "remove")}
            </Button>
          )}
        </div>
      )}
    </article>
  );
}
