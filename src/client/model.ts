/** Browser task mirror. Only durable Host responses become saved task state. */
import {
  snapshotSchema,
  type PlannerSnapshot,
  type PlannerCommand,
} from "../shared/model.ts";
export interface ModelSnapshot {
  data: PlannerSnapshot | null;
  busy: boolean;
  loading: boolean;
  error: string | null;
  retryable: boolean;
  retryCommand: PlannerCommand | null;
  duplicate: {
    command: Extract<PlannerCommand, { type: "task.move" }>;
    expectedRevision: number;
  } | null;
}
type Pending = {
  expectedRevision: number;
  operationId: string;
  command: PlannerCommand;
};
class ApiError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}
/** Owns request cancellation, retry identities and monotonically published snapshots. */
export class PlannerModel {
  private snapshot: ModelSnapshot = {
    data: null,
    busy: false,
    loading: false,
    error: null,
    retryable: false,
    retryCommand: null,
    duplicate: null,
  };
  private listeners = new Set<() => void>();
  private controllers = new Set<AbortController>();
  private inflight = new Set<Promise<PlannerSnapshot>>();
  private disposed = false;
  private reading: Promise<void> | null = null;
  private pending: Pending | null = null;
  constructor(
    private readonly request: typeof fetch,
    private readonly changed: () => void = () => {},
    private readonly timeoutMs = 15000,
  ) {}
  getSnapshot = () => this.snapshot;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private publish(patch: Partial<ModelSnapshot>) {
    if (this.disposed) return;
    this.snapshot = { ...this.snapshot, ...patch };
    for (const fn of this.listeners) {
      try {
        fn();
      } catch (error) {
        console.error("daily-planner subscriber", error);
      }
    }
  }
  private accept(data: PlannerSnapshot) {
    if (
      !this.snapshot.data ||
      data.state.revision >= this.snapshot.data.state.revision
    )
      this.publish({ data });
  }
  private call(payload?: Pending): Promise<PlannerSnapshot> {
    const job = this.perform(payload);
    this.inflight.add(job);
    void job
      .finally(() => this.inflight.delete(job))
      .catch(() => {
        /* Caller owns the request failure. */
      });
    return job;
  }
  private async perform(payload?: Pending): Promise<PlannerSnapshot> {
    const controller = new AbortController();
    this.controllers.add(controller);
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.request("/api/dsh-daily-planner", {
        method: payload ? "POST" : "GET",
        credentials: "same-origin",
        cache: "no-store",
        signal: controller.signal,
        ...(payload
          ? {
              headers: { "content-type": "application/json" },
              body: JSON.stringify(payload),
            }
          : {}),
      });
      const value: unknown = await response.json();
      if (!response.ok) {
        const code =
          typeof value === "object" &&
          value !== null &&
          "error" in value &&
          (value.error as { code?: unknown })?.code;
        throw new ApiError(typeof code === "string" ? code : "server");
      }
      return snapshotSchema.parse(value);
    } finally {
      clearTimeout(timer);
      this.controllers.delete(controller);
    }
  }
  refresh = (): Promise<void> => {
    if (this.disposed) return Promise.resolve();
    if (this.reading) return this.reading;
    this.publish({ loading: !this.snapshot.data });
    this.reading = this.call()
      .then((data) => {
        this.accept(data);
        if (
          this.snapshot.error === "read" ||
          this.snapshot.error === "timezone-mismatch"
        )
          this.publish({ error: null });
      })
      .catch((error: unknown) => {
        // Network and invalid wire data leave the last confirmed snapshot intact.
        if (!this.disposed && !this.snapshot.error)
          this.publish({
            error:
              error instanceof ApiError && error.code === "timezone-mismatch"
                ? error.code
                : "read",
          });
      })
      .finally(() => {
        this.reading = null;
        this.publish({ loading: false });
      });
    return this.reading;
  };
  /** Submit an action. Editors supply their opening revision; immediate actions use the current snapshot. A rejected edit never advances its draft baseline. */
  run = async (
    command: PlannerCommand,
    expectedRevision?: number,
  ): Promise<boolean> => {
    if (
      this.disposed ||
      this.snapshot.busy ||
      this.pending ||
      !this.snapshot.data
    )
      return false;
    return this.submit({
      expectedRevision: expectedRevision ?? this.snapshot.data.state.revision,
      operationId: crypto.randomUUID(),
      command,
    });
  };
  private async submit(payload: Pending): Promise<boolean> {
    this.pending = payload;
    this.publish({
      busy: true,
      error: null,
      retryable: false,
      retryCommand: null,
      duplicate: null,
    });
    try {
      const data = await this.call(payload);
      if (this.disposed) return false;
      this.accept(data);
      this.pending = null;
      this.publish({ busy: false });
      try {
        this.changed();
      } catch (error) {
        console.error("daily-planner notification", error);
      }
      return true;
    } catch (error) {
      if (this.disposed) return false;
      const code = error instanceof ApiError ? error.code : "network";
      const retryable = !(error instanceof ApiError);
      if (!retryable) this.pending = null;
      this.publish({
        busy: false,
        error: code,
        retryable,
        retryCommand: retryable ? payload.command : null,
        duplicate:
          code === "duplicate-occurrence" &&
          payload.command.type === "task.move"
            ? {
                command: payload.command,
                expectedRevision: payload.expectedRevision,
              }
            : null,
      });
      if (code === "conflict") await this.refresh();
      return false;
    }
  }
  retry = async () =>
    this.pending && !this.snapshot.busy && !this.disposed
      ? this.submit(this.pending)
      : false;
  confirmDuplicate = async () =>
    this.snapshot.duplicate
      ? this.run(
          { ...this.snapshot.duplicate.command, allowDuplicate: true },
          this.snapshot.duplicate.expectedRevision,
        )
      : false;
  dismiss = () => {
    if (!this.pending) this.publish({ error: null, duplicate: null });
  };
  dispose = async () => {
    this.disposed = true;
    this.listeners.clear();
    for (const controller of this.controllers) controller.abort();
    await Promise.allSettled([...this.inflight]);
  };
}
