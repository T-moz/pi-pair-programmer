import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { visibleWidth, type TuiMouseEvent } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it, vi, type Mock } from "vitest";
import { ReviewFeed } from "../src/review-feed.js";
import {
  MIN_COLUMNS,
  renderSidebar,
  ReviewSidebar,
} from "../src/review-sidebar.js";
import type { FindingView } from "../src/review-store.js";

const plain = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
} as unknown as Parameters<typeof renderSidebar>[2];
const job = {
  file: "src/a.ts",
  reviewer: "entropy",
  model: "openai/gpt-5",
};
const views: Record<string, FindingView> = {
  accepted: {
    title: "Duplicate helper",
    line: 42,
    status: "accepted",
    reason: "Reuse the existing padding helper instead of adding another one.",
  },
  awaiting: { title: "Magic interval", line: 7, status: "awaiting" },
  queued: { title: "Queued", line: 1, status: "queued" },
  rejected: { title: "Rejected", line: 2, status: "rejected", reason: "No" },
  discarded: { title: "Discarded", line: 3, status: "discarded" },
  bare: { title: "Bare accept", line: 4, status: "accepted" },
};
const viewMap = new Map(Object.entries(views));
const lookup = (id: string): FindingView | undefined => viewMap.get(id);
const text = (
  feed: ReviewFeed,
  width = 48,
  height = 60,
  now = 20_000,
  expanded: ReadonlySet<string> = new Set(feed.list().map(({ id }) => id)),
): string[] =>
  renderSidebar(feed.list(), lookup, plain, width, height, now, expanded);

describe("renderSidebar", () => {
  it("frames an empty feed at its natural height", () => {
    const lines = text(new ReviewFeed(), 40, 12);
    expect(lines).toHaveLength(10);
    expect(lines[0]).toBe(`╭${"─".repeat(38)}╮`);
    expect(lines.at(-1)).toBe(`╰${"─".repeat(38)}╯`);
    expect(lines.join("\n")).toContain("Nothing to show yet.");
    expect(lines.at(-2)).toContain("alt+r hide");
    for (const line of lines) expect(visibleWidth(line)).toBe(40);
  });

  it("shows only running reviews and those with accepted or rejected findings", () => {
    const feed = new ReviewFeed();
    const outcomes = [
      "failed",
      "timeout",
      "obsolete",
      "cancelled",
      "success",
    ] as const;
    for (const outcome of outcomes) {
      feed.start(outcome, { ...job, file: `${outcome}.ts` }, 0);
      feed.finish(outcome, outcome, 1500);
    }
    feed.start("undecided", { ...job, file: "undecided.ts" }, 0);
    feed.finish("undecided", "success", 1);
    feed.attach("undecided", ["awaiting", "queued", "discarded", "missing"]);
    feed.start("rejected", { ...job, file: "rejected.ts" }, 0);
    feed.finish("rejected", "success", 12_400);
    feed.attach("rejected", ["rejected"]);
    feed.start("mixed", { ...job, file: "mixed.ts" }, 0);
    feed.finish("mixed", "success", 900);
    feed.attach("mixed", Object.keys(views));
    feed.start("live", { ...job, file: "live.ts", model: "" }, 19_000);
    const rendered = text(feed, 60, 80).join("\n");
    for (const expected of [
      "Live reviews · 1 running",
      "live.ts",
      "1.0s",
      "rejected.ts",
      "12s",
      "1 rejected",
      "mixed.ts",
      "2 accepted · 1 rejected",
      "Bare accept :4",
      "Duplicate helper :42",
      "“Reuse the existing padding helper",
      "Rejected :2",
      "“No”",
      "entropy",
    ])
      expect(rendered).toContain(expected);
    for (const hidden of [
      ...outcomes.map((outcome) => `${outcome}.ts`),
      "undecided.ts",
      "Magic interval",
      "Queued :1",
      "Discarded",
      "no findings",
    ])
      expect(rendered).not.toContain(hidden);
    expect(renderSidebar([], lookup, plain, 40, 10).join("")).toContain(
      "Live reviews",
    );
  });

  it("keeps the newest reviews that fit and counts the rest", () => {
    const feed = new ReviewFeed();
    for (let index = 0; index < 6; index += 1) {
      feed.start(String(index), { ...job, file: `f${String(index)}.ts` }, 0);
      feed.finish(String(index), "success", 1);
      feed.attach(String(index), ["accepted"]);
    }
    const lines = text(feed, 40, 16);
    const joined = lines.join("\n");
    expect(lines.length).toBeLessThanOrEqual(16);
    expect(joined).toContain("f5.ts");
    expect(joined).not.toContain("f0.ts");
    expect(joined).toMatch(/\+\d earlier reviews/u);
    const single = new ReviewFeed();
    single.start("a", job, 0);
    single.start("b", job, 0);
    expect(text(single, 40, 9).join("\n")).toContain("+1 earlier review\u{20}");
    for (const line of text(feed, 38, 5)) expect(visibleWidth(line)).toBe(38);
  });

  it("collapses each review to one row of file, reviewer and verdict counts", () => {
    const feed = new ReviewFeed();
    feed.start("done", { ...job, file: "src/deep/done.ts" }, 0);
    feed.finish("done", "success", 8400);
    feed.attach("done", ["accepted", "rejected"]);
    feed.start(
      "live",
      {
        ...job,
        file: "src/live.ts",
        reviewer: "a-very-long-reviewer-name-that-cannot-fit-beside-it",
      },
      19_000,
    );
    const collapsed = text(feed, 44, 40, 20_000, new Set()).map((line) =>
      line.slice(2, -2),
    );
    expect(collapsed[4]).toMatch(/^◐ src\/live\.ts +a-very-long-… {2}1\.0s$/u);
    expect(collapsed[6]).toMatch(
      /^◆ src\/deep\/done\.ts +entropy {2}1✓ 1✗ ▸$/u,
    );
    expect(collapsed[7]?.trim()).toBe("");
    const open = text(feed, 44, 40).map((line) => line.slice(2, -2));
    expect(open[4]).toContain("1.0s");
    expect(open[5]?.trim()).toBe("");
    expect(open[6]).toMatch(/1✓ 1✗ ▾$/u);
    expect(open[7]).toMatch(/^ {2}1 accepted · 1 rejected +8\.4s$/u);
    const rejectedOnly = new ReviewFeed();
    rejectedOnly.start("r", job, 0);
    rejectedOnly.finish("r", "success", 1);
    rejectedOnly.attach("r", ["rejected"]);
    expect(text(rejectedOnly, 44, 40, 0, new Set())[4]).toMatch(/✗ ▸/u);
    for (const width of [38, 12])
      for (const line of text(feed, width, 40))
        expect(visibleWidth(line)).toBe(width);
  });

  it("truncates long paths and animates running reviews", () => {
    const feed = new ReviewFeed();
    feed.start("a", { ...job, file: `${"deep/".repeat(20)}file.ts` }, 0);
    const lines = text(feed, 40, 20, 0);
    for (const line of lines) expect(visibleWidth(line)).toBe(40);
    expect(lines.join("\n")).toContain("…");
    const frames = [0, 250, 500, 750].map((now) => text(feed, 40, 20, now)[4]);
    expect(new Set(frames).size).toBe(4);
  });
});

type Factory = Parameters<ExtensionContext["ui"]["custom"]>[0];
interface Host {
  ctx: ExtensionContext;
  custom: Mock;
  notify: Mock;
  requestRender: Mock;
  closed: Mock;
  options: () => {
    anchor: string;
    nonCapturing: boolean;
    visible: (columns: number) => boolean;
  };
  render: (width: number) => string[] | undefined;
  click: (y: number, button?: string, type?: string) => unknown;
}

function host(mode = "tui", rows = 20): Host {
  const requestRender = vi.fn();
  const notify = vi.fn();
  const closed = vi.fn();
  let options: ReturnType<Host["options"]> | undefined;
  let render: ((width: number) => string[]) | undefined;
  let mouse: ((event: TuiMouseEvent) => unknown) | undefined;
  const custom = vi.fn(
    async (
      factory: Factory,
      opts: { overlayOptions: ReturnType<Host["options"]> },
    ): Promise<undefined> => {
      options = opts.overlayOptions;
      const done = Promise.withResolvers<undefined>();
      const component = await factory(
        {
          requestRender,
          terminal: { rows },
        } as unknown as Parameters<Factory>[0],
        plain as unknown as Parameters<Factory>[1],
        {} as Parameters<Factory>[2],
        () => {
          closed();
          done.resolve(undefined);
        },
      );
      component.invalidate();
      render = (width) => component.render(width);
      mouse = (event) => component.handleMouse?.(event);
      return done.promise;
    },
  );
  return {
    ctx: {
      hasUI: true,
      mode,
      ui: { custom, notify },
    } as unknown as ExtensionContext,
    custom,
    notify,
    requestRender,
    closed,
    options: () => {
      if (options === undefined) throw new Error("not mounted");
      return options;
    },
    render: (width) => render?.(width),
    click: (y, button = "left", type = "click") =>
      mouse?.({ type, button, y } as TuiMouseEvent),
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("ReviewSidebar", () => {
  it("toggles a non-capturing right-hand overlay that renders the live feed", async () => {
    vi.useFakeTimers();
    const feed = new ReviewFeed();
    const tui = host();
    const sidebar = new ReviewSidebar(() => feed.list(), lookup);
    sidebar.refresh(tui.ctx);
    expect(tui.custom).not.toHaveBeenCalled();
    sidebar.toggle(tui.ctx);
    await Promise.resolve();
    expect(sidebar.open).toBe(true);
    expect(tui.options()).toMatchObject({
      anchor: "top-right",
      nonCapturing: true,
    });
    expect(tui.options().visible(MIN_COLUMNS - 1)).toBe(false);
    expect(tui.options().visible(MIN_COLUMNS)).toBe(true);
    expect(tui.render(40)).toHaveLength(10);
    vi.advanceTimersByTime(250);
    expect(tui.requestRender).not.toHaveBeenCalled();
    feed.start("a", job, Date.now());
    vi.advanceTimersByTime(250);
    expect(tui.requestRender).toHaveBeenCalledTimes(1);
    sidebar.refresh();
    expect(tui.requestRender).toHaveBeenCalledTimes(2);
    sidebar.toggle(tui.ctx);
    expect(sidebar.open).toBe(false);
    await Promise.resolve();
    expect(tui.closed).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1000);
    expect(tui.requestRender).toHaveBeenCalledTimes(2);
  });

  it("expands and collapses a finished review by left click on any of its rows", async () => {
    const feed = new ReviewFeed();
    feed.start("done", { ...job, file: "done.ts" }, 0);
    feed.finish("done", "success", 1);
    feed.attach("done", ["accepted"]);
    feed.start("live", { ...job, file: "live.ts" }, Date.now());
    const tui = host("tui", 40);
    const sidebar = new ReviewSidebar(() => feed.list(), lookup);
    sidebar.toggle(tui.ctx);
    await Promise.resolve();
    const rows = (): string[] => tui.render(40) ?? [];
    const at = (name: string): number =>
      rows().findIndex((line) => line.includes(name));
    expect(rows().join("\n")).not.toContain("Duplicate helper");
    for (const ignored of [
      tui.click(0),
      tui.click(at("live.ts")),
      tui.click(at("done.ts"), "right"),
      tui.click(at("done.ts"), "left", "press"),
      tui.click(99),
    ])
      expect(ignored).toBeUndefined();
    expect(tui.click(at("done.ts"))).toEqual({ handled: true, render: true });
    expect(rows().join("\n")).toContain("Duplicate helper :42");
    expect(tui.click(at("Duplicate helper"))).toMatchObject({ handled: true });
    expect(rows().join("\n")).not.toContain("Duplicate helper");
    sidebar.dispose();
  });

  it("follows session replacement while open", async () => {
    const first = host();
    const second = host();
    const sidebar = new ReviewSidebar(() => [], lookup);
    sidebar.toggle(first.ctx);
    sidebar.refresh(first.ctx);
    expect(first.custom).toHaveBeenCalledTimes(1);
    sidebar.refresh(second.ctx);
    await Promise.resolve();
    expect(first.closed).toHaveBeenCalledTimes(1);
    expect(second.custom).toHaveBeenCalledTimes(1);
    expect(sidebar.open).toBe(true);
    sidebar.dispose();
  });

  it("explains that the sidebar needs Pi's terminal UI", () => {
    const headless = host();
    headless.ctx.hasUI = false;
    for (const unsupported of [host("rpc"), headless]) {
      const sidebar = new ReviewSidebar(() => [], lookup);
      sidebar.toggle(unsupported.ctx);
      expect(sidebar.open).toBe(false);
      expect(unsupported.custom).not.toHaveBeenCalled();
      expect(unsupported.notify).toHaveBeenCalledWith(
        expect.stringContaining("terminal UI"),
        "warning",
      );
    }
  });

  it("closes when the host ends the overlay or disposes it before mounting", async () => {
    const ended = host();
    ended.custom.mockReturnValueOnce(Promise.resolve(undefined));
    const sidebar = new ReviewSidebar(() => [], lookup);
    sidebar.toggle(ended.ctx);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(sidebar.open).toBe(false);

    const failed = host();
    failed.custom.mockReturnValueOnce(Promise.reject(new Error("no")));
    sidebar.toggle(failed.ctx);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(sidebar.open).toBe(false);

    const late = host();
    let mount: (() => void) | undefined;
    late.custom.mockImplementationOnce(
      (factory: Factory): Promise<undefined> => {
        return new Promise<undefined>((resolve) => {
          mount = () => {
            const component = factory(
              {
                requestRender: vi.fn(),
                terminal: { rows: 20 },
              } as unknown as Parameters<Factory>[0],
              plain as unknown as Parameters<Factory>[1],
              {} as Parameters<Factory>[2],
              () => {
                resolve(undefined);
              },
            );
            expect(component).toBeDefined();
          };
        });
      },
    );
    sidebar.toggle(late.ctx);
    sidebar.toggle(late.ctx);
    mount?.();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(sidebar.open).toBe(false);
    sidebar.toggle(late.ctx);
    expect(sidebar.open).toBe(true);
    sidebar.dispose();
  });
});
