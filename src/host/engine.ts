/** Serialized personal planner; every committed update replaces one aggregate. */
import { createHash } from "node:crypto";
import { z } from "zod";
import {
  mutationSchema,
  stateSchema,
  taskId,
  timeZoneSchema,
  type PlannerCommand,
  type PlannerSnapshot,
  type PlannerState,
  type Task,
  type TaskId,
} from "../shared/model.ts";

/** Protocol retry window: the latest 256 successful operation identities. */
export const receiptLimit = 256;
export const aggregateSchema = z
  .object({
    state: stateSchema,
    receipts: z
      .array(
        z
          .object({
            operationId: z.string().min(1).max(200),
            fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
            revision: z.number().int().nonnegative(),
          })
          .strict(),
      )
      .max(receiptLimit),
  })
  .strict()
  .superRefine((value, ctx) => {
    const distinct = (values: string[], label: string) => {
      if (new Set(values).size !== values.length)
        ctx.addIssue({ code: "custom", message: "Duplicate " + label });
    };
    distinct(
      value.state.tasks.map((task) => task.id),
      "task identity",
    );
    distinct(
      value.state.routines.map((routine) => routine.id),
      "routine identity",
    );
    distinct(
      value.receipts.map((receipt) => receipt.operationId),
      "operation identity",
    );
    distinct(
      value.state.tasks
        .filter((task) => task.routineId !== undefined)
        .map((task) => task.routineId + "/" + task.originalDate),
      "routine occurrence",
    );
    if (
      value.receipts.some((receipt) => receipt.revision > value.state.revision)
    )
      ctx.addIssue({
        code: "custom",
        message: "Receipt revision exceeds state revision",
      });
    if (
      value.state.tasks.some(
        (task) => task.status === "open" && value.state.days[task.date]?.closed,
      )
    )
      ctx.addIssue({ code: "custom", message: "Closed day has open tasks" });
  });
export type PlannerAggregate = z.infer<typeof aggregateSchema>;

/** Adapter over the storage-domain singleton; tests may supply a private in-memory unit. */
export interface PlannerPersistence {
  get(): PlannerAggregate;
  set(value: PlannerAggregate): Promise<void>;
  close(): Promise<void>;
}

/** User-facing rejection; unexpected persistence failures are not exposed verbatim. */
export class PlannerError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: 400 | 409 | 500 = 400,
  ) {
    super(message);
  }
}

/** Create the never-written singleton. @param timeZone Validated host zone. @returns Empty aggregate. */
export function initialAggregate(timeZone: string): PlannerAggregate {
  return {
    state: {
      revision: 0,
      timeZone: timeZoneSchema.parse(timeZone),
      tasks: [],
      routines: [],
      days: {},
    },
    receipts: [],
  };
}

/** Calendar date in the configured zone. @param now Current instant. @param timeZone Host zone. @returns ISO calendar date. */
export function dateInZone(now: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const part = (type: string) =>
    parts.find((value) => value.type === type)!.value;
  return part("year") + "-" + part("month") + "-" + part("day");
}

/** Owns one queue across generation, reads, mutations, and disposal. */
export class PlannerEngine {
  private tail: Promise<void> = Promise.resolve();
  private disposal?: Promise<void>;
  constructor(
    private readonly persistence: PlannerPersistence,
    private readonly timeZone: string,
    private readonly now: () => Date = () => new Date(),
  ) {
    timeZoneSchema.parse(timeZone);
    this.current();
  }

  /** Read after generating today's missing occurrences only. @returns A detached committed snapshot. */
  read(): Promise<PlannerSnapshot> {
    return this.enqueue(async () => {
      const today = dateInZone(this.now(), this.timeZone);
      const current = this.current();
      const draft = structuredClone(current);
      if (ensureToday(draft.state, today)) await this.commit(draft);
      return this.snapshot(today);
    });
  }

  /** Validate and serialize one wire mutation. @param input Untrusted request JSON. @returns The latest committed snapshot, including safe retries. */
  mutate(input: unknown): Promise<PlannerSnapshot> {
    const parsed = mutationSchema.safeParse(input);
    if (!parsed.success)
      return Promise.reject(
        new PlannerError("invalid-request", "Invalid planner request."),
      );
    const request = parsed.data;
    return this.enqueue(async () => {
      const instant = this.now();
      const today = dateInZone(instant, this.timeZone);
      const current = this.current();
      const fingerprint = createHash("sha256")
        .update(JSON.stringify(request.command))
        .digest("hex");
      const receipt = current.receipts.find(
        (item) => item.operationId === request.operationId,
      );
      if (receipt) {
        if (receipt.fingerprint !== fingerprint)
          throw new PlannerError(
            "operation-mismatch",
            "This operation identity was already used for another command.",
            409,
          );
        const draft = structuredClone(current);
        if (ensureToday(draft.state, today)) await this.commit(draft);
        return this.snapshot(today);
      }
      if (request.expectedRevision !== current.state.revision)
        throw new PlannerError(
          "conflict",
          "The planner changed. Reload before trying again.",
          409,
        );
      const draft = structuredClone(current);
      ensureToday(draft.state, today);
      applyCommand(draft.state, request.command, today, instant.toISOString());
      ensureToday(draft.state, today);
      draft.receipts.push({
        operationId: request.operationId,
        fingerprint,
        revision: draft.state.revision + 1,
      });
      draft.receipts = draft.receipts.slice(-receiptLimit);
      await this.commit(draft);
      return this.snapshot(today);
    });
  }

  /** Stop admission, drain all accepted work, then close storage. @returns Shared disposal completion. */
  dispose(): Promise<void> {
    this.disposal ??= this.tail.then(() => this.persistence.close());
    return this.disposal;
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    if (this.disposal)
      return Promise.reject(
        new PlannerError("unavailable", "The planner is shutting down.", 500),
      );
    const result = this.tail.then(operation);
    this.tail = result.then(
      () => {},
      () => {},
    );
    return result;
  }

  private current(): PlannerAggregate {
    const current = this.persistence.get();
    if (current.state.timeZone !== this.timeZone)
      throw new PlannerError(
        "timezone-mismatch",
        "The configured time zone differs from the saved planner time zone.",
        409,
      );
    return current;
  }

  private async commit(draft: PlannerAggregate): Promise<void> {
    draft.state.revision += 1;
    const validated = aggregateSchema.parse(draft);
    await this.persistence.set(validated);
  }

  private snapshot(today: string): PlannerSnapshot {
    return { state: structuredClone(this.persistence.get().state), today };
  }
}

function day(state: PlannerState, date: string) {
  return (state.days[date] ??= { planned: false, closed: false });
}
function nextOrder(state: PlannerState, date: string): number {
  return state.tasks
    .filter((task) => task.date === date)
    .reduce((max, task) => Math.max(max, task.order + 1), 0);
}
function weekday(date: string): number {
  return new Date(date + "T12:00:00Z").getUTCDay();
}
function ensureToday(state: PlannerState, today: string): boolean {
  let changed = false;
  for (const routine of state.routines) {
    if (!routine.enabled || !routine.weekdays.includes(weekday(today)))
      continue;
    if (
      state.tasks.some(
        (task) => task.routineId === routine.id && task.originalDate === today,
      )
    )
      continue;
    const baseId = taskId(
      "occurrence:" +
        createHash("sha256").update(routine.id).digest("hex") +
        ":" +
        today,
    );
    let id = baseId;
    for (let suffix = 1; state.tasks.some((task) => task.id === id); suffix++)
      id = taskId(baseId + ":" + suffix);
    state.tasks.push({
      id,
      title: routine.title,
      date: today,
      originalDate: today,
      routineId: routine.id,
      status: "open",
      order: nextOrder(state, today),
    });
    day(state, today).closed = false;
    changed = true;
  }
  return changed;
}
function findTask(state: PlannerState, id: TaskId): Task {
  const task = state.tasks.find((item) => item.id === id);
  if (!task) throw new PlannerError("not-found", "The task no longer exists.");
  return task;
}
function active(task: Task): void {
  if (task.status === "deleted")
    throw new PlannerError("invalid-state", "Restore the deleted task first.");
}
function future(date: string, today: string): void {
  if (date < today)
    throw new PlannerError("invalid-date", "Choose today or a future date.");
}
function collision(state: PlannerState, task: Task, date: string): boolean {
  if (!task.routineId) return false;
  if (
    state.tasks.some(
      (item) =>
        item.id !== task.id &&
        item.routineId === task.routineId &&
        item.date === date &&
        item.status !== "deleted",
    )
  )
    return true;
  const routine = state.routines.find((item) => item.id === task.routineId);
  return (
    !!routine?.enabled &&
    routine.weekdays.includes(weekday(date)) &&
    !state.tasks.some(
      (item) => item.routineId === task.routineId && item.originalDate === date,
    )
  );
}
function applyCommand(
  state: PlannerState,
  command: PlannerCommand,
  today: string,
  instant: string,
): void {
  switch (command.type) {
    case "task.add": {
      if (command.id.startsWith("occurrence:"))
        throw new PlannerError(
          "reserved-id",
          "Task identities starting with occurrence: are reserved for routines.",
        );
      future(command.date, today);
      if (state.tasks.some((task) => task.id === command.id))
        throw new PlannerError(
          "duplicate-id",
          "This task identity already exists.",
        );
      state.tasks.push({
        id: command.id,
        title: command.title,
        date: command.date,
        originalDate: command.date,
        status: "open",
        order: nextOrder(state, command.date),
      });
      day(state, command.date).closed = false;
      return;
    }
    case "task.edit": {
      const task = findTask(state, command.id);
      active(task);
      task.title = command.title;
      return;
    }
    case "task.complete": {
      const task = findTask(state, command.id);
      active(task);
      task.status = command.completed ? "done" : "open";
      if (!command.completed) day(state, task.date).closed = false;
      return;
    }
    case "task.move": {
      const task = findTask(state, command.id);
      if (task.status !== "open")
        throw new PlannerError(
          "invalid-state",
          "Only open tasks can be moved.",
        );
      future(command.date, today);
      if (task.date === command.date) return;
      if (collision(state, task, command.date) && !command.allowDuplicate)
        throw new PlannerError(
          "duplicate-occurrence",
          "This date already has or schedules another occurrence. Confirm keeping both.",
          409,
        );
      (task.dateChanges ??= []).push({
        from: task.date,
        to: command.date,
        at: instant,
      });
      task.order = nextOrder(state, command.date);
      task.date = command.date;
      day(state, command.date).closed = false;
      return;
    }
    case "task.delete": {
      const task = findTask(state, command.id);
      if (task.status !== "deleted") {
        task.deletedStatus = task.status;
        task.status = "deleted";
      }
      return;
    }
    case "task.restore": {
      const task = findTask(state, command.id);
      if (task.status === "deleted") {
        task.status = task.deletedStatus ?? "open";
        delete task.deletedStatus;
      }
      if (task.status === "open") day(state, task.date).closed = false;
      return;
    }
    case "task.reorder": {
      const tasks = state.tasks.filter(
        (task) => task.date === command.date && task.status !== "deleted",
      );
      if (
        new Set(command.ids).size !== command.ids.length ||
        tasks.length !== command.ids.length ||
        tasks.some((task) => !command.ids.includes(task.id))
      )
        throw new PlannerError(
          "invalid-order",
          "Reorder must include every visible task on the selected date exactly once.",
        );
      command.ids.forEach((id, index) => {
        findTask(state, id).order = index;
      });
      return;
    }
    case "routine.save": {
      const routine = {
        id: command.id,
        title: command.title,
        weekdays: command.weekdays,
        enabled: command.enabled,
      };
      const index = state.routines.findIndex((item) => item.id === command.id);
      if (index < 0) state.routines.push(routine);
      else state.routines[index] = routine;
      return;
    }
    case "routine.delete": {
      const index = state.routines.findIndex((item) => item.id === command.id);
      if (index < 0)
        throw new PlannerError("not-found", "The routine no longer exists.");
      state.routines.splice(index, 1);
      return;
    }
    case "day.plan":
      day(state, command.date).planned = true;
      return;
    case "day.close": {
      if (
        state.tasks.some(
          (task) => task.date === command.date && task.status === "open",
        )
      )
        throw new PlannerError(
          "open-tasks",
          "Finish, delete, or explicitly move every open task before closing this day.",
        );
      day(state, command.date).closed = true;
      return;
    }
    case "day.reopen":
      day(state, command.date).closed = false;
      return;
    default: {
      const exhaustive: never = command;
      throw new Error("Unknown planner command: " + String(exhaustive));
    }
  }
}
