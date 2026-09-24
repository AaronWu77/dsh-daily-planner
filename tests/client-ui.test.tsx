// @vitest-environment jsdom
import React, { useSyncExternalStore } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { PlannerCard, PlannerEntry, nextDate } from "../src/client/Planner.tsx";
import { createPlannerViewStore } from "../src/client/view-store.ts";
import { PlannerModel } from "../src/client/model.ts";
import { PlannerEngine, initialAggregate } from "../src/host/engine.ts";
import { routineId, taskId, type PlannerCommand } from "../src/shared/model.ts";
import { en, zh, type PlannerKey } from "../src/client/locales.ts";
import type { EntryProps } from "../src/client/contract.ts";
// Shared primitives are exercised in the assembled browser; this fixture isolates planner interactions.
vi.mock("@deepseek-ai/dsh-client-ui-primitives", () => ({
  Button: ({
    children,
    variant,
    size,
    icon,
    ...props
  }: React.ButtonHTMLAttributes<HTMLButtonElement> & {
    variant?: string;
    size?: string;
    icon?: React.ReactNode;
  }) => (
    <button type="button" {...props}>
      {children}
    </button>
  ),
  Input: (props: React.InputHTMLAttributes<HTMLInputElement>) => (
    <input {...props} />
  ),
  Checkbox: ({
    label,
    checked,
    onChange,
    disabled,
    className,
    title,
  }: {
    label: string;
    checked: boolean;
    onChange: (value: boolean) => void;
    disabled?: boolean;
    className?: string;
    title?: string;
  }) => (
    <label className={className} title={title}>
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span>{label}</span>
    </label>
  ),
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
const disposers: Array<() => Promise<void>> = [];
afterEach(async () => {
  cleanup();
  for (const dispose of disposers.splice(0)) await dispose();
});
async function fixture(locale: Record<PlannerKey, string> = zh) {
  let aggregate = initialAggregate("UTC");
  let now = new Date("2026-09-21T10:00:00Z");
  const engine = new PlannerEngine(
    {
      get: () => aggregate,
      set: async (value) => {
        aggregate = structuredClone(value);
      },
      close: async () => {},
    },
    "UTC",
    () => now,
  );
  const request = vi
    .fn<typeof fetch>()
    .mockImplementation(async (_url, init) => {
      try {
        return Response.json(
          init?.method === "POST"
            ? await engine.mutate(JSON.parse(String(init.body)))
            : await engine.read(),
        );
      } catch (error) {
        const e = error as { code: string; status: number };
        return Response.json({ error: { code: e.code } }, { status: e.status });
      }
    });
  const model = new PlannerModel(request);
  await model.refresh();
  const store = createPlannerViewStore().create();
  const props = {
    actions: store.actions,
    useStore: <T,>(sel: (s: ReturnType<typeof store.getSnapshot>) => T) =>
      sel(useSyncExternalStore(store.subscribe, store.getSnapshot)),
    usePlanner: <T,>(sel: (s: ReturnType<typeof model.getSnapshot>) => T) =>
      sel(useSyncExternalStore(model.subscribe, model.getSnapshot)),
    t: (key: PlannerKey, params: Record<string, string | number> = {}) =>
      Object.entries(params).reduce(
        (text, [name, value]) =>
          text.replaceAll("{" + name + "}", String(value)),
        locale[key],
      ),
    run: model.run,
    refresh: model.refresh,
    retry: model.retry,
    confirmDuplicate: model.confirmDuplicate,
    dismiss: model.dismiss,
    returnFocus: () => document.getElementById("daily-planner-toggle")?.focus(),
    wide: true,
  } as EntryProps;
  disposers.push(async () => {
    await model.dispose();
    await engine.dispose();
  });
  return {
    model,
    request,
    store,
    engine,
    advance: async (value: string) => {
      now = new Date(value);
      await act(() => model.refresh());
    },
    command: async (command: PlannerCommand) => {
      await act(() => model.run(command));
    },
    mount: () =>
      render(
        <>
          <PlannerEntry {...props} />
          <PlannerCard {...props} />
          <button>Outside</button>
        </>,
      ),
  };
}
function open() {
  fireEvent.click(screen.getByRole("button", { name: "今日计划" }));
}
describe("daily planning card", () => {
  it("opens only on request, toggles closed, keeps drafts, and allows outside interaction", async () => {
    const app = await fixture();
    app.mount();
    expect(screen.queryByRole("dialog")).toBeNull();
    open();
    fireEvent.change(screen.getByRole("textbox", { name: "任务名称" }), {
      target: { value: "我的草稿" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Outside" }));
    expect(screen.getByRole("dialog")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "关闭今日计划" }));
    expect(document.activeElement?.id).toBe("daily-planner-toggle");
    open();
    expect(
      (screen.getByRole("textbox", { name: "任务名称" }) as HTMLInputElement)
        .value,
    ).toBe("我的草稿");
    open();
    expect(screen.queryByRole("dialog")).toBeNull();
  });
  it("adds, completes and uncompletes a task through the durable mirror", async () => {
    const app = await fixture();
    app.mount();
    open();
    fireEvent.change(screen.getByRole("textbox", { name: "任务名称" }), {
      target: { value: "完成设计" },
    });
    fireEvent.click(screen.getByRole("button", { name: "添加任务" }));
    await screen.findByRole("checkbox", { name: "完成设计" });
    fireEvent.click(screen.getByRole("checkbox", { name: "完成设计" }));
    await waitFor(() =>
      expect(app.model.getSnapshot().data?.state.tasks[0]?.status).toBe("done"),
    );
    fireEvent.click(screen.getByText("已完成（1）"));
    fireEvent.click(screen.getByRole("checkbox", { name: "完成设计" }));
    await waitFor(() =>
      expect(app.model.getSnapshot().data?.state.tasks[0]?.status).toBe("open"),
    );
  });
  it("keeps yesterday unfinished separately and never posts a move while opening or crossing midnight", async () => {
    const app = await fixture();
    await app.command({
      type: "task.add",
      id: taskId("yesterday"),
      title: "昨天未完成",
      date: "2026-09-21",
    });
    await app.advance("2026-09-22T10:00:00Z");
    app.mount();
    open();
    expect(screen.queryByRole("checkbox", { name: "昨天未完成" })).toBeNull();
    fireEvent.click(screen.getByText("之前有 1 项等待处理"));
    expect(screen.getByRole("checkbox", { name: "昨天未完成" })).toBeTruthy();
    expect(app.model.getSnapshot().data?.state.tasks[0]?.date).toBe(
      "2026-09-21",
    );
    const posted = app.request.mock.calls
      .filter(([, init]) => init?.method === "POST")
      .map(([, init]) => JSON.parse(String(init?.body)).command.type);
    expect(posted).toEqual(["task.add"]);
    fireEvent.click(screen.getByRole("button", { name: "安排到今天" }));
    await waitFor(() =>
      expect(app.model.getSnapshot().data?.state.tasks[0]?.date).toBe(
        "2026-09-22",
      ),
    );
  });
  it("requires deletion or explicit movement before closing a day, and supports undo deletion", async () => {
    const app = await fixture();
    await app.command({
      type: "task.add",
      id: taskId("review"),
      title: "尚未完成",
      date: "2026-09-21",
    });
    await app.command({ type: "day.plan", date: "2026-09-21" });
    app.mount();
    open();
    fireEvent.click(screen.getByRole("button", { name: "整理今天" }));
    expect(
      (screen.getByRole("button", { name: "完成整理" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "删除" }));
    await screen.findByText("任务已删除。");
    fireEvent.click(screen.getByRole("button", { name: "撤销" }));
    await screen.findByRole("checkbox", { name: "尚未完成" });
    fireEvent.click(screen.getByRole("button", { name: "顺延到明天" }));
    await waitFor(() =>
      expect(
        (screen.getByRole("button", { name: "完成整理" }) as HTMLButtonElement)
          .disabled,
      ).toBe(false),
    );
    fireEvent.click(screen.getByRole("button", { name: "完成整理" }));
    await screen.findByText("整理已保存。");
    expect(app.model.getSnapshot().data?.state.tasks[0]?.date).toBe(
      "2026-09-22",
    );
  });
  it("shows a confirmation for recurring collisions and does not delete either occurrence", async () => {
    const app = await fixture();
    await app.command({
      type: "routine.save",
      id: routineId("daily"),
      title: "每日阅读",
      weekdays: [0, 1, 2, 3, 4, 5, 6],
      enabled: true,
    });
    await app.advance("2026-09-22T10:00:00Z");
    app.mount();
    open();
    fireEvent.click(screen.getByText("之前有 1 项等待处理"));
    fireEvent.click(screen.getByRole("button", { name: "安排到今天" }));
    await screen.findByText(
      "目标日期已有同一例行任务，是否保留为额外补做任务？",
    );
    expect(
      app.model.getSnapshot().data?.state.tasks.map((x) => x.date),
    ).toEqual(["2026-09-21", "2026-09-22"]);
    fireEvent.click(screen.getByRole("button", { name: "保留两项并顺延" }));
    await waitFor(() =>
      expect(
        app.model
          .getSnapshot()
          .data?.state.tasks.every((x) => x.date === "2026-09-22"),
      ).toBe(true),
    );
    expect(app.model.getSnapshot().data?.state.tasks).toHaveLength(2);
  });
  it("creates a routine and edits only its future template", async () => {
    const app = await fixture();
    app.mount();
    open();
    fireEvent.click(screen.getByRole("button", { name: "例行任务设置" }));
    fireEvent.click(screen.getByRole("button", { name: "添加例行任务" }));
    fireEvent.change(screen.getByRole("textbox", { name: "例行任务名称" }), {
      target: { value: "整理工作记录" },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await screen.findByText("例行任务已保存。");
    expect(app.model.getSnapshot().data?.state.tasks[0]?.title).toBe(
      "整理工作记录",
    );
    fireEvent.click(screen.getByRole("button", { name: "编辑" }));
    fireEvent.change(screen.getByRole("textbox", { name: "例行任务名称" }), {
      target: { value: "未来的名称" },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() =>
      expect(app.model.getSnapshot().data?.state.routines[0]?.title).toBe(
        "未来的名称",
      ),
    );
    expect(app.model.getSnapshot().data?.state.tasks[0]?.title).toBe(
      "整理工作记录",
    );
  });

  it("rejects stale task drafts after another window refresh and keeps the draft until explicit reload", async () => {
    const app = await fixture();
    const id = taskId("stale-task");
    await app.command({
      type: "task.add",
      id,
      title: "Original",
      date: "2026-09-21",
    });
    app.mount();
    open();
    await act(() => app.model.refresh());
    fireEvent.click(
      screen.getByRole("button", { name: "任务操作 · Original" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "编辑" }));
    fireEvent.change(screen.getByRole("textbox", { name: "任务名称" }), {
      target: { value: "Local draft" },
    });
    await app.engine.mutate({
      operationId: "remote-task",
      expectedRevision: app.model.getSnapshot().data!.state.revision,
      command: { type: "task.edit", id, title: "Remote title" },
    });
    await act(() => app.model.refresh());
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() => expect(app.model.getSnapshot().error).toBe("conflict"));
    expect(
      (screen.getByRole("textbox", { name: "任务名称" }) as HTMLInputElement)
        .value,
    ).toBe("Local draft");
    expect(app.model.getSnapshot().data!.state.tasks[0].title).toBe(
      "Remote title",
    );
    fireEvent.click(
      screen.getByRole("button", { name: "读取最新内容并放弃本次草稿" }),
    );
    expect(
      (screen.getByRole("textbox", { name: "任务名称" }) as HTMLInputElement)
        .value,
    ).toBe("Remote title");
    fireEvent.change(screen.getByRole("textbox", { name: "任务名称" }), {
      target: { value: "Reviewed edit" },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() =>
      expect(app.model.getSnapshot().data!.state.tasks[0].title).toBe(
        "Reviewed edit",
      ),
    );
  });
  it("rejects stale routine drafts without overwriting another window", async () => {
    const app = await fixture();
    const id = routineId("stale-routine");
    await app.command({
      type: "routine.save",
      id,
      title: "Original routine",
      weekdays: [1, 2, 3, 4, 5],
      enabled: true,
    });
    app.mount();
    open();
    await act(() => app.model.refresh());
    fireEvent.click(screen.getByRole("button", { name: "例行任务设置" }));
    fireEvent.click(screen.getByRole("button", { name: "编辑" }));
    fireEvent.change(screen.getByRole("textbox", { name: "例行任务名称" }), {
      target: { value: "My routine draft" },
    });
    await app.engine.mutate({
      operationId: "remote-routine",
      expectedRevision: app.model.getSnapshot().data!.state.revision,
      command: {
        type: "routine.save",
        id,
        title: "Remote routine",
        weekdays: [1, 3, 5],
        enabled: true,
      },
    });
    await act(() => app.model.refresh());
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() => expect(app.model.getSnapshot().error).toBe("conflict"));
    expect(app.model.getSnapshot().data!.state.routines[0].title).toBe(
      "Remote routine",
    );
    expect(app.store.getSnapshot().routineDraft!.title).toBe(
      "My routine draft",
    );
    fireEvent.click(
      screen.getByRole("button", { name: "读取最新内容并放弃本次草稿" }),
    );
    expect(app.store.getSnapshot().routineDraft!.weekdays).toEqual([1, 3, 5]);
  });
  it("locks task input and cancellation during a pending save, while allowing close and reopen", async () => {
    const app = await fixture();
    const id = taskId("slow-task");
    await app.command({
      type: "task.add",
      id,
      title: "Original",
      date: "2026-09-21",
    });
    app.mount();
    open();
    await act(() => app.model.refresh());
    fireEvent.click(
      screen.getByRole("button", { name: "任务操作 · Original" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "编辑" }));
    fireEvent.change(screen.getByRole("textbox", { name: "任务名称" }), {
      target: { value: "Submitted" },
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const impl = app.request.getMockImplementation()!;
    app.request.mockImplementationOnce(async (...args) => {
      await gate;
      return impl(...args);
    });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    try {
      expect(
        (screen.getByRole("textbox", { name: "任务名称" }) as HTMLInputElement)
          .disabled,
      ).toBe(true);
      expect(
        (screen.getByRole("button", { name: "取消" }) as HTMLButtonElement)
          .disabled,
      ).toBe(true);
      fireEvent.click(screen.getByRole("button", { name: "关闭今日计划" }));
      open();
      expect(
        (screen.getByRole("textbox", { name: "任务名称" }) as HTMLInputElement)
          .disabled,
      ).toBe(true);
    } finally {
      await act(async () => {
        release();
      });
    }
    await waitFor(() => expect(app.store.getSnapshot().editor).toBeNull());
    expect(app.model.getSnapshot().data!.state.tasks[0].title).toBe(
      "Submitted",
    );
  });
  it("locks routine title and repeat controls until its save settles", async () => {
    const app = await fixture();
    app.mount();
    open();
    await act(() => app.model.refresh());
    fireEvent.click(screen.getByRole("button", { name: "例行任务设置" }));
    fireEvent.click(screen.getByRole("button", { name: "添加例行任务" }));
    fireEvent.change(screen.getByRole("textbox", { name: "例行任务名称" }), {
      target: { value: "New routine" },
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const impl = app.request.getMockImplementation()!;
    app.request.mockImplementationOnce(async (...args) => {
      await gate;
      return impl(...args);
    });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    try {
      expect(
        (
          screen.getByRole("textbox", {
            name: "例行任务名称",
          }) as HTMLInputElement
        ).disabled,
      ).toBe(true);
      expect(
        screen.getByRole("button", { name: "每天" }).closest("fieldset")
          ?.disabled,
      ).toBe(true);
      expect(
        (screen.getByRole("button", { name: "取消" }) as HTMLButtonElement)
          .disabled,
      ).toBe(true);
    } finally {
      await act(async () => {
        release();
      });
    }
    await waitFor(() =>
      expect(app.store.getSnapshot().routineDraft).toBeNull(),
    );
    expect(app.model.getSnapshot().data!.state.routines[0].title).toBe(
      "New routine",
    );
  });

  it("rejects stale duplicate confirmation after another window moves the task", async () => {
    const app = await fixture();
    await app.command({
      type: "routine.save",
      id: routineId("r"),
      title: "Recurring",
      weekdays: [0, 1, 2, 3, 4, 5, 6],
      enabled: true,
    });
    const original = app.model.getSnapshot().data!.state.tasks[0].id;
    await app.advance("2026-09-22T10:00:00Z");
    await app.command({ type: "task.move", id: original, date: "2026-09-22" });
    expect(app.model.getSnapshot().error).toBe("duplicate-occurrence");
    await app.engine.mutate({
      operationId: "remote-move",
      expectedRevision: app.model.getSnapshot().data!.state.revision,
      command: {
        type: "task.move",
        id: original,
        date: "2026-09-25",
        allowDuplicate: true,
      },
    });
    await app.model.refresh();
    expect(await app.model.confirmDuplicate()).toBe(false);
    expect(app.model.getSnapshot().error).toBe("conflict");
    expect(
      app.model.getSnapshot().data!.state.tasks.find((x) => x.id === original)!
        .date,
    ).toBe("2026-09-25");
    expect(app.model.getSnapshot().duplicate).toBeNull();
  });
  it("moves past completed tasks in one click and leaves visible boundary actions unchanged", async () => {
    const app = await fixture();
    for (const id of ["a", "b", "c"])
      await app.command({
        type: "task.add",
        id: taskId(id),
        title: id,
        date: "2026-09-21",
      });
    await app.command({
      type: "task.complete",
      id: taskId("b"),
      completed: true,
    });
    app.mount();
    open();
    await act(() => app.model.refresh());
    const visibleOrder = () =>
      app.model
        .getSnapshot()
        .data!.state.tasks.filter((t) => t.status === "open")
        .sort((a, b) => a.order - b.order)
        .map((t) => t.id);
    fireEvent.click(screen.getByRole("button", { name: "任务操作 · a" }));
    fireEvent.click(screen.getByRole("button", { name: "下移 · a" }));
    await waitFor(() => expect(visibleOrder()).toEqual(["c", "a"]));
    const revision = app.model.getSnapshot().data!.state.revision;
    fireEvent.click(screen.getByRole("button", { name: "下移 · a" }));
    expect(app.model.getSnapshot().data!.state.revision).toBe(revision);
    fireEvent.click(screen.getByRole("button", { name: "上移 · a" }));
    await waitFor(() => expect(visibleOrder()).toEqual(["a", "c"]));
    expect(
      app.model.getSnapshot().data!.state.tasks.find((t) => t.id === "b")!
        .status,
    ).toBe("done");
  });
  for (const [language, locale] of [
    ["zh", zh],
    ["en", en],
  ] as const) {
    it(
      "keeps an uncertain save distinct from saved state and recovers after retry (" +
        language +
        ")",
      async () => {
        const app = await fixture(locale);
        app.mount();
        fireEvent.click(screen.getByRole("button", { name: locale.title }));
        await act(() => app.model.refresh());
        app.request.mockRejectedValueOnce(new TypeError("offline"));
        fireEvent.change(
          screen.getByRole("textbox", { name: locale.titleLabel }),
          { target: { value: "New task" } },
        );
        fireEvent.click(screen.getByRole("button", { name: locale.add }));
        await waitFor(() =>
          expect(app.model.getSnapshot().retryable).toBe(true),
        );
        expect(screen.queryByText(locale.saved)).toBeNull();
        expect(screen.getByText(locale.pendingSave)).toBeTruthy();
        expect(app.model.getSnapshot().data!.state.tasks).toHaveLength(0);
        expect(screen.getByRole("alert").textContent).toMatchSnapshot(
          "uncertain-save-" + language,
        );
        fireEvent.click(screen.getByRole("button", { name: locale.retry }));
        await waitFor(() =>
          expect(screen.getByText(locale.saved)).toBeTruthy(),
        );
        expect(app.model.getSnapshot().data!.state.tasks).toHaveLength(1);
      },
    );
    it(
      "shows rejected writes and read failures without claiming success (" +
        language +
        ")",
      async () => {
        const app = await fixture(locale);
        app.mount();
        fireEvent.click(screen.getByRole("button", { name: locale.title }));
        await act(() => app.model.refresh());
        app.request.mockResolvedValueOnce(
          Response.json({ error: { code: "internal-error" } }, { status: 500 }),
        );
        fireEvent.change(
          screen.getByRole("textbox", { name: locale.titleLabel }),
          { target: { value: "Rejected" } },
        );
        fireEvent.click(screen.getByRole("button", { name: locale.add }));
        await waitFor(() =>
          expect(screen.getByText(locale.saveFailed)).toBeTruthy(),
        );
        expect(screen.queryByText(locale.saved)).toBeNull();
        act(() => app.model.dismiss());
        app.request.mockResolvedValueOnce(
          Response.json(
            { error: { code: "timezone-mismatch" } },
            { status: 409 },
          ),
        );
        await act(() => app.model.refresh());
        expect(screen.getByText(locale.readFailed)).toBeTruthy();
        expect(screen.getByText(locale.errorTimezone)).toBeTruthy();
        expect(screen.queryByText(locale.saved)).toBeNull();
        await act(() => app.model.refresh());
        expect(screen.getByText(locale.saved)).toBeTruthy();
      },
    );
  }

  it("records stable Chinese first-use output", async () => {
    const app = await fixture();
    app.mount();
    open();
    expect(screen.getByRole("dialog").textContent).toMatchSnapshot();
  });
  it("uses calendar arithmetic across leap dates", () => {
    expect(nextDate("2028-02-28")).toBe("2028-02-29");
    expect(nextDate("2026-12-31")).toBe("2027-01-01");
  });
});
