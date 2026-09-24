/** Validated shared planner wire models. */
import { z } from "zod";

const idText = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9_.:-]+$/);
/** Task identity remains stable when manually rescheduled. */
export const taskIdSchema = idText.brand<"TaskId">();
/** Routine identity is independent of its title and schedule. */
export const routineIdSchema = idText.brand<"RoutineId">();
export type TaskId = z.infer<typeof taskIdSchema>;
export type RoutineId = z.infer<typeof routineIdSchema>;
/** Parse a task identifier. @param value Wire identifier. @returns Validated identity. */
export function taskId(value: string): TaskId {
  return taskIdSchema.parse(value);
}
/** Parse a routine identifier. @param value Wire identifier. @returns Validated identity. */
export function routineId(value: string): RoutineId {
  return routineIdSchema.parse(value);
}
/** Gregorian calendar date without a time or offset. */
export const dateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((value) => {
    const date = new Date(value + "T12:00:00Z");
    return (
      Number.isFinite(date.getTime()) &&
      date.toISOString().slice(0, 10) === value
    );
  }, "Invalid calendar date");
/** Time zone accepted by the host Intl implementation. */
export const timeZoneSchema = z
  .string()
  .min(1)
  .refine((value) => {
    try {
      new Intl.DateTimeFormat("en", { timeZone: value }).format(0);
      return true;
    } catch {
      return false;
    }
  }, "Invalid time zone");
const titleSchema = z.string().trim().min(1).max(500);
const weekdaysSchema = z
  .array(z.number().int().min(0).max(6))
  .min(1)
  .max(7)
  .refine(
    (values) => new Set(values).size === values.length,
    "Duplicate weekday",
  );
/** History records only explicit user date changes. */
export const dateChangeSchema = z
  .object({ from: dateSchema, to: dateSchema, at: z.string().datetime() })
  .strict();
export const taskSchema = z
  .object({
    id: taskIdSchema,
    title: titleSchema,
    date: dateSchema,
    originalDate: dateSchema,
    routineId: routineIdSchema.optional(),
    status: z.enum(["open", "done", "deleted"]),
    order: z.number().int().nonnegative(),
    dateChanges: z.array(dateChangeSchema).optional(),
    deletedStatus: z.enum(["open", "done"]).optional(),
  })
  .strict();
export type Task = z.infer<typeof taskSchema>;
export const routineSchema = z
  .object({
    id: routineIdSchema,
    title: titleSchema,
    weekdays: weekdaysSchema,
    enabled: z.boolean(),
  })
  .strict();
export type Routine = z.infer<typeof routineSchema>;
export const dayPlanSchema = z
  .object({ planned: z.boolean(), closed: z.boolean() })
  .strict();
export type DayPlan = z.infer<typeof dayPlanSchema>;
export const stateSchema = z
  .object({
    revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    timeZone: timeZoneSchema,
    tasks: z.array(taskSchema),
    routines: z.array(routineSchema),
    days: z.record(dateSchema, dayPlanSchema),
  })
  .strict();
export type PlannerState = z.infer<typeof stateSchema>;
/** GET and successful POST return this object directly. */
export const snapshotSchema = z
  .object({ state: stateSchema, today: dateSchema })
  .strict();
export type PlannerSnapshot = z.infer<typeof snapshotSchema>;
export const commandSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("task.add"),
      id: taskIdSchema,
      title: titleSchema,
      date: dateSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("task.edit"),
      id: taskIdSchema,
      title: titleSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("task.complete"),
      id: taskIdSchema,
      completed: z.boolean(),
    })
    .strict(),
  z
    .object({
      type: z.literal("task.move"),
      id: taskIdSchema,
      date: dateSchema,
      allowDuplicate: z.boolean().optional(),
    })
    .strict(),
  z.object({ type: z.literal("task.delete"), id: taskIdSchema }).strict(),
  z.object({ type: z.literal("task.restore"), id: taskIdSchema }).strict(),
  z
    .object({
      type: z.literal("task.reorder"),
      date: dateSchema,
      ids: z.array(taskIdSchema),
    })
    .strict(),
  z
    .object({
      type: z.literal("routine.save"),
      id: routineIdSchema,
      title: titleSchema,
      weekdays: weekdaysSchema,
      enabled: z.boolean(),
    })
    .strict(),
  z.object({ type: z.literal("routine.delete"), id: routineIdSchema }).strict(),
  z.object({ type: z.literal("day.plan"), date: dateSchema }).strict(),
  z.object({ type: z.literal("day.close"), date: dateSchema }).strict(),
  z.object({ type: z.literal("day.reopen"), date: dateSchema }).strict(),
]);
export type PlannerCommand = z.infer<typeof commandSchema>;
export const mutationSchema = z
  .object({
    expectedRevision: z
      .number()
      .int()
      .nonnegative()
      .max(Number.MAX_SAFE_INTEGER),
    operationId: idText,
    command: commandSchema,
  })
  .strict();
export type PlannerMutation = z.infer<typeof mutationSchema>;
