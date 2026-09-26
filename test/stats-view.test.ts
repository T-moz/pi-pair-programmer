import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import { PairStats } from "../src/pair-stats.js";
import { ReviewStore } from "../src/review-store.js";
import {
  StatsView,
  statsLines,
  statsSummary,
  type StatsReport,
} from "../src/stats-view.js";

const report =
  (lines: readonly string[]): (() => StatsReport) =>
  () => ({
    summary: lines,
    details: [`detail ${lines.join(" ")}`],
  });

type Factory = Parameters<ExtensionContext["ui"]["custom"]>[0];
interface ViewComponent {
  render(width: number): string[];
  handleInput?(data: string): void;
  invalidate(): void;
  dispose?(): void;
}
function ui(
  rows = 20,
  fg = (_color: string, text: string): string => text,
): {
  ctx: ExtensionContext;
  component: () => ViewComponent;
  mounted: Promise<void>;
  renderRequests: () => number;
  notify: ReturnType<typeof vi.fn>;
} {
  const mounted = Promise.withResolvers<undefined>();
  const closed = Promise.withResolvers<undefined>();
  const requestRender = vi.fn();
  const notify = vi.fn();
  let component: ViewComponent | undefined;
  const custom = async (factory: Factory): Promise<void> => {
    component = await factory(
      {
        terminal: { rows },
        requestRender,
      } as unknown as Parameters<Factory>[0],
      {
        fg,
        bold: (text: string) => text,
      } as unknown as Parameters<Factory>[1],
      {
        matches(data: string, action: string): boolean {
          const bindings: Record<string, readonly string[]> = {
            "tui.select.confirm": ["\r", "\u{1B}[13u"],
            "tui.select.cancel": ["\u{1B}", "\u{1B}[27u"],
            "app.clear": ["\u{3}", "\u{1B}[99;5u"],
            "tui.select.up": ["\u{1B}[A"],
            "tui.select.down": ["\u{1B}[B"],
            "tui.select.pageUp": ["\u{1B}[5~"],
            "tui.select.pageDown": ["\u{1B}[6~"],
          };
          const candidates = Reflect.get(bindings, action) as
            readonly string[] | undefined;
          return candidates?.includes(data) === true;
        },
      } as unknown as Parameters<Factory>[2],
      () => {
        closed.resolve(undefined);
      },
    );
    mounted.resolve(undefined);
    await closed.promise;
  };
  return {
    ctx: {
      hasUI: true,
      mode: "tui",
      ui: { custom, notify },
    } as unknown as ExtensionContext,
    component: () => {
      if (component === undefined) throw new Error("view not mounted");
      return component;
    },
    mounted: mounted.promise,
    renderRequests: () => requestRender.mock.calls.length,
    notify,
  };
}

const emptyStore = new ReviewStore(vi.fn());

describe("statistics presentation", () => {
  it("summarizes branch findings and measured session cost without hiding incomplete accounting", () => {
    const stats = new PairStats("session", () => {
      throw new Error("disk full");
    });
    expect(statsSummary(stats.snapshot(), emptyStore).join("\n")).toContain(
      "Estimated cost  unavailable",
    );
    stats.start("job");
    stats.observe("job", {
      stage: "review",
      requestedModel: "model",
      outcome: "success",
      durationMs: 1,
      usage: { costUsd: 0.002 },
    });
    const store = new ReviewStore(vi.fn());
    store.setEnabled(false);
    const text = statsSummary(stats.snapshot(), store).join("\n");
    expect(text).toContain("Background review is paused");
    expect(text).toContain("$0.002000 (partial 1/1)");
    expect(text).toContain("! Accounting is incomplete");
    expect(text).toContain("! Some records could not be saved");
    const snapshot = stats.snapshot();
    snapshot.persistenceFailures = 0;
    expect(statsSummary(snapshot, store).join("\n")).toContain(
      "! Some records could not be saved",
    );
  });
  it("labels unknown identity, complete and partial subtotals without combining main-agent costs", () => {
    const stats = new PairStats("session", vi.fn());
    stats.start("job");
    stats.finish("job", "success", 20);
    stats.observe("job", {
      stage: "review",
      requestedModel: "requested",
      model: "actual\u{1B}[31m",
      provider: "provider",
      outcome: "success",
      durationMs: 10,
      usage: { inputTokens: 12, outputTokens: 0, costUsd: 0.002 },
    });
    stats.observe("job", {
      stage: "review",
      requestedModel: "requested",
      model: "actual\u{1B}[31m",
      provider: "provider",
      outcome: "failed",
      durationMs: 30,
      usage: { inputTokens: 8 },
    });
    stats.observe("job", {
      stage: "attribution",
      requestedModel: "judge",
      outcome: "timeout",
      durationMs: 20,
    });
    stats.observe("job", {
      stage: "dedup",
      requestedModel: "judge",
      model: "judge-actual",
      outcome: "success",
      durationMs: 0,
    });
    const rendered = statsLines(stats.snapshot(), emptyStore).join("\n");
    expect(rendered).toContain("20 (complete 2/2)");
    expect(rendered).toContain("0 (partial 1/2)");
    expect(rendered).toContain("$0.002000 (partial 1/2)");
    expect(rendered).toContain("Cache read unavailable");
    expect(rendered).toContain("attribution: unobserved (requested judge)");
    expect(rendered).toContain("dedup: judge-actual");
    expect(rendered).toContain("separate from main-agent host totals");
    expect(rendered).not.toContain("\u{1B}");
  });

  it("never labels recorded subtotals complete while interrupted jobs may have missing usage", () => {
    const stats = new PairStats("session", vi.fn());
    stats.start("job");
    stats.observe("job", {
      stage: "review",
      requestedModel: "model",
      outcome: "success",
      durationMs: 5,
      usage: { inputTokens: 10, costUsd: 0.001 },
    });
    stats.finish("job", "cancelled", 6, false);
    const rendered = statsLines(stats.snapshot(), emptyStore).join("\n");
    expect(rendered).toContain("INCOMPLETE accounting: 1 review job(s)");
    expect(rendered).toContain("10 (partial 1/1)");
    expect(rendered).toContain("$0.001000 (partial 1/1)");
    expect(rendered).not.toContain("(complete");
  });

  it("shows empty, disabled and incomplete-persistence states explicitly", () => {
    const stats = new PairStats("session", () => {
      throw new Error("disk full");
    });
    stats.start("job");
    const store = new ReviewStore(vi.fn());
    store.setEnabled(false);
    const rendered = statsLines(stats.snapshot(), store).join("\n");
    expect(rendered).toContain("Background review: off");
    expect(rendered).toContain("Review latency: unavailable");
    expect(rendered).toContain("No finalized extension model calls");
    expect(rendered).toContain("Storage unavailable for 1 record(s)");
  });
});

describe("StatsView", () => {
  it.each([
    "q",
    "\u{1B}",
    "\r",
    "\u{3}",
    "\u{1B}[13u",
    "\u{1B}[27u",
    "\u{1B}[99;5u",
  ])("closes explicitly on %j without retaining resources", async (key) => {
    const host = ui();
    const view = new StatsView();
    const opened = view.open(
      host.ctx,
      report(["Review counts", "extension usage", "! Warning", "USAGE  / now"]),
    );
    await host.mounted;
    const component = host.component();
    expect(component.render(11)).toEqual([
      "Pair Progr\u{1B}[0m…\u{1B}[0m",
      "Session ov\u{1B}[0m…\u{1B}[0m",
      "",
      "Review",
      "counts",
      "extension",
      "usage",
      "! Warning",
      "USAGE  /",
      "now",
      "",
      "↑↓  d deta\u{1B}[0m…\u{1B}[0m",
    ]);
    const framed = component.render(24);
    expect(framed[0]).toBe(`╭${"─".repeat(22)}╮`);
    expect(framed[4]).toBe(`│  Review counts${" ".repeat(5)}  │`);
    expect(framed.at(-2)).toContain("↑↓  d details  r ");
    expect(framed.at(-1)).toBe(`╰${"─".repeat(22)}╯`);
    component.invalidate();
    component.handleInput?.(key);
    component.handleInput?.(key);
    await opened;
    view.close();
    component.dispose?.();
  });

  it("scrolls within snapshot bounds and closes on session disposal", async () => {
    const host = ui();
    const view = new StatsView();
    const lines = Array.from(
      { length: 12 },
      (_, index) => `Row ${String(index)}`,
    );
    const opened = view.open(host.ctx, report(lines));
    await host.mounted;
    const component = host.component();
    const first = (): string | undefined => component.render(80)[4];
    expect(first()).toContain("Row 0");
    expect(component.render(80).at(-2)).toContain("esc close  1–9/12");
    component.handleInput?.("\u{1B}[B");
    expect(first()).toContain("Row 1");
    component.handleInput?.("\u{1B}[A");
    expect(first()).toContain("Row 0");
    component.handleInput?.("\u{1B}[6~");
    expect(first()).toContain("Row 3");
    component.handleInput?.("\u{1B}[5~");
    expect(first()).toContain("Row 0");
    component.handleInput?.("d");
    expect(component.render(80)[2]).toContain("Detailed accounting");
    expect(first()).toContain("detail Row 0");
    expect(component.render(80).at(-2)).toContain("d overview");
    component.handleInput?.("\u{1B}[B");
    component.handleInput?.("r");
    expect(first()).toContain("detail Row 0");
    component.handleInput?.("d");
    expect(first()).toContain("Row 0");
    component.handleInput?.("ignored");
    expect(host.renderRequests()).toBe(9);
    view.close();
    await opened;
  });

  it("refreshes snapshots and recomputes themed, Unicode-safe layout on resize", async () => {
    let color = "31";
    let value = "変更 e\u{301} 👩‍💻 " + "long-model-name".repeat(10);
    const host = ui(40, (_tone, text) => `\u{1B}[${color}m${text}\u{1B}[0m`);
    const read = vi.fn(() => ({ summary: [value], details: [value] }));
    const view = new StatsView();
    const opened = view.open(host.ctx, read);
    await host.mounted;
    const component = host.component();
    for (const width of [1, 11, 12, 24, 78, 160])
      for (const line of component.render(width))
        expect(visibleWidth(line)).toBeLessThanOrEqual(width);
    expect(component.render(78).join("\n")).toContain("変更");
    value = "Refreshed";
    color = "32";
    component.invalidate();
    expect(component.render(78).join("\n")).toContain("\u{1B}[32m変更");
    expect(read).toHaveBeenCalledTimes(1);
    component.handleInput?.("r");
    expect(component.render(78).join("\n")).toContain("Refreshed");
    expect(read).toHaveBeenCalledTimes(2);
    view.close();
    await opened;
  });

  it("keeps tiny terminals to the scrollable report body", async () => {
    const host = ui(3);
    const view = new StatsView();
    const opened = view.open(host.ctx, report(["one", "two", "three", "four"]));
    await host.mounted;
    const component = host.component();
    expect(component.render(80)).toEqual(["one", "two", "three"]);
    component.handleInput?.("\u{1B}[6~");
    expect(component.render(80)).toEqual(["two", "three", "four"]);
    view.close();
    await opened;
  });

  it("replaces the prior view without an older completion clearing the current close handler", async () => {
    const first = ui();
    const second = ui();
    const view = new StatsView();
    const previous = view.open(first.ctx, report(["old"]));
    await first.mounted;
    const current = view.open(second.ctx, report(["current"]));
    await second.mounted;
    await previous;
    expect(second.component().render(80)[4]).toContain("current");
    view.close();
    await current;
  });

  it("rejects headless commands and uses explicit supported RPC notifications instead of mounting a terminal view", async () => {
    const host = ui();
    const view = new StatsView();
    host.ctx.hasUI = false;
    await expect(view.open(host.ctx, report([]))).rejects.toThrow(
      "interactive terminal",
    );
    host.ctx.hasUI = true;
    host.ctx.mode = "rpc";
    await view.open(host.ctx, report([]));
    expect(host.notify).toHaveBeenCalledWith(
      expect.stringContaining("interactive terminal"),
      "warning",
    );
  });

  it("detects unsupported OMP custom views without confusing hasUI with terminal support", async () => {
    const view = new StatsView();
    const ctx = {
      hasUI: true,
      ui: { custom: () => Promise.resolve() },
    } as unknown as ExtensionContext;
    await expect(view.open(ctx, report([]))).rejects.toThrow(
      "interactive terminal",
    );
    const interactive = ui();
    Reflect.deleteProperty(interactive.ctx, "mode");
    const opened = view.open(interactive.ctx, report(["OMP view"]));
    await interactive.mounted;
    view.close();
    await opened;
  });
});
