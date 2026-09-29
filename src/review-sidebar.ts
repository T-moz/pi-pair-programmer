import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import {
  sliceByColumn,
  visibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { frame, truncatePath } from "./format.js";
import type { FeedEntry } from "./review-feed.js";
import type { FindingView } from "./review-store.js";

type Painter = Pick<Theme, "fg" | "bold">;
type Color = Parameters<Theme["fg"]>[0];
export type Lookup = (id: string) => FindingView | undefined;

const SPINNER = "◐◓◑◒";
export const MIN_COLUMNS = 90;
// Rows kept clear under the card for the editor and footer.
const EDITOR_RESERVE = 8;

/** Cuts text to `width` columns with a plain ellipsis (no stray reset codes). */
function clip(text: string, width: number): string {
  if (visibleWidth(text) <= width) return text;
  return width <= 0 ? "" : `${sliceByColumn(text, 0, width - 1).trimEnd()}…`;
}

/** Joins left and right text on one row, shrinking the right side first. */
function spread(left: string, right: string, width: number): string {
  const shown = clip(right, Math.max(0, width - visibleWidth(left) - 1));
  const gap = Math.max(1, width - visibleWidth(left) - visibleWidth(shown));
  return `${left}${" ".repeat(gap)}${shown}`;
}

function seconds(ms: number): string {
  return ms < 10_000
    ? `${(ms / 1000).toFixed(1)}s`
    : `${String(Math.round(ms / 1000))}s`;
}

type Decided = FindingView & { status: "accepted" | "rejected" };

const FINDING: Record<Decided["status"], { icon: string; color: Color }> = {
  accepted: { icon: "✓", color: "success" },
  rejected: { icon: "✗", color: "muted" },
};

/** Only accepted and rejected findings are worth surfacing. */
function decided(entry: FeedEntry, lookup: Lookup): Decided[] {
  return entry.findingIds.flatMap((id) => {
    const view = lookup(id);
    return view?.status === "accepted" || view?.status === "rejected"
      ? [view as Decided]
      : [];
  });
}

function summary(findings: readonly Decided[]): {
  icon: string;
  color: Color;
  text: string;
  accepted: number;
  rejected: number;
} {
  const accepted = findings.filter((f) => f.status === "accepted").length;
  const rejected = findings.length - accepted;
  const text = [
    accepted > 0 ? `${String(accepted)} accepted` : "",
    rejected > 0 ? `${String(rejected)} rejected` : "",
  ]
    .filter(Boolean)
    .join(" · ");
  return accepted > 0
    ? { icon: "◆", color: "warning", text, accepted, rejected }
    : { icon: "✗", color: "muted", text, accepted, rejected };
}

/** Compact verdict counts for the collapsed row, e.g. `1✓ 2✗`. */
function counts(theme: Painter, accepted: number, rejected: number): string {
  return [
    accepted > 0 ? theme.fg("success", `${String(accepted)}✓`) : "",
    rejected > 0 ? theme.fg("muted", `${String(rejected)}✗`) : "",
  ]
    .filter(Boolean)
    .join(" ");
}

function entryLines(
  entry: FeedEntry,
  findings: readonly Decided[],
  open: boolean,
  theme: Painter,
  width: number,
  now: number,
): string[] {
  const running = entry.phase === "running";
  const state = summary(findings);
  const icon = running
    ? theme.fg("accent", SPINNER.charAt(Math.floor(now / 250) % SPINNER.length))
    : theme.fg(state.color, state.icon);
  const time = theme.fg(
    "dim",
    seconds(entry.durationMs ?? Math.max(0, now - entry.startedAt)),
  );
  const marker = theme.fg("dim", open ? "▾" : "▸");
  const tail = running
    ? time
    : `${counts(theme, state.accepted, state.rejected)} ${marker}`;
  const name = clip(entry.reviewer, Math.max(1, Math.floor(width / 3)));
  const right = `${theme.fg("dim", name)}  ${tail}`;
  const file = truncatePath(
    entry.file,
    Math.max(1, width - visibleWidth(right) - 3),
  );
  const lines = [spread(`${icon} ${theme.bold(file)}`, right, width)];
  if (running || !open) return lines;
  lines.push(spread(`  ${theme.fg(state.color, state.text)}`, time, width));
  for (const finding of findings) {
    const style = FINDING[finding.status];
    lines.push(
      `  ${theme.fg(style.color, style.icon)} ${finding.title}${theme.fg("dim", " :" + String(finding.line))}`,
    );
    if (finding.reason !== undefined)
      lines.push(
        ...wrapTextWithAnsi(`“${finding.reason}”`, Math.max(1, width - 4))
          .slice(0, 2)
          .map((part) => `    ${theme.fg("dim", part)}`),
      );
  }
  return lines;
}

export interface SidebarLayout {
  lines: string[];
  /** Review id owning each rendered row, for click targeting. */
  rows: (string | undefined)[];
}

/** Lays out the framed sidebar at an exact width, at most `height` rows. */
export function layoutSidebar(
  entries: readonly FeedEntry[],
  lookup: Lookup,
  theme: Painter,
  width: number,
  height: number,
  now = Date.now(),
  expanded: ReadonlySet<string> = new Set(),
): SidebarLayout {
  const visible = entries.flatMap((entry) => {
    const findings = decided(entry, lookup);
    return entry.phase === "running" || findings.length > 0
      ? [{ entry, findings }]
      : [];
  });
  const box = frame(theme, width, 1);
  const inner = box.inner;
  const running = entries.filter((entry) => entry.phase === "running").length;
  const header = [
    theme.bold(theme.fg("accent", "Pair Programmer")),
    theme.fg(
      "dim",
      running > 0
        ? `Live reviews · ${String(running)} running`
        : "Live reviews",
    ),
    "",
  ];
  const footer = ["", theme.fg("dim", "click to expand · alt+r hide")];
  const room = Math.max(0, height - 2 - header.length - footer.length);
  const body: string[] = [];
  const owners: (string | undefined)[] = [];
  if (visible.length === 0) {
    body.push(
      theme.fg("muted", "Nothing to show yet."),
      theme.fg("dim", "Running reviews and decided"),
      theme.fg("dim", "findings appear here."),
    );
    owners.push(undefined, undefined, undefined);
  }
  let shown = 0;
  for (const { entry, findings } of visible) {
    const gap = shown === 0 ? [] : [""];
    const reserve = shown + 1 < visible.length ? 1 : 0;
    const fits = (lines: readonly string[]): boolean =>
      body.length + gap.length + lines.length + reserve <= room;
    const open = expanded.has(entry.id);
    let lines = entryLines(entry, findings, open, theme, inner, now);
    // An expanded review that no longer fits falls back to its collapsed row.
    if (open && !fits(lines))
      lines = entryLines(entry, findings, false, theme, inner, now);
    if (!fits(lines)) break;
    body.push(...gap, ...lines);
    owners.push(...gap.map(() => ""), ...lines.map(() => entry.id));
    shown += 1;
  }
  if (shown < visible.length) {
    const hidden = visible.length - shown;
    body.push(
      theme.fg(
        "dim",
        `+${String(hidden)} earlier review${hidden === 1 ? "" : "s"}`,
      ),
    );
    owners.push(undefined);
  }
  const content = [...header, ...body].slice(0, room + header.length);
  return {
    lines: box.render([...content, ...footer]),
    rows: [
      ...Array.from<undefined>({ length: 1 + header.length }),
      ...owners.slice(0, content.length - header.length),
      ...Array.from<undefined>({ length: footer.length + 1 }),
    ],
  };
}

/** Renders the framed sidebar at an exact width, at most `height` rows. */
export function renderSidebar(
  ...args: Parameters<typeof layoutSidebar>
): string[] {
  return layoutSidebar(...args).lines;
}

/** Togglable, non-capturing right-hand overlay showing the live review feed. */
export class ReviewSidebar {
  private readonly entries: () => readonly FeedEntry[];
  private readonly lookup: Lookup;
  private ctx: ExtensionContext | undefined;
  private close: (() => void) | undefined;
  private requestRender: (() => void) | undefined;
  private ticker: NodeJS.Timeout | undefined;
  /** Reviews the user expanded by click; ids are unique per review. */
  private readonly expanded = new Set<string>();

  constructor(entries: () => readonly FeedEntry[], lookup: Lookup) {
    this.entries = entries;
    this.lookup = lookup;
  }

  get open(): boolean {
    return this.ctx !== undefined;
  }

  toggle(ctx: ExtensionContext): void {
    if (this.open) {
      this.dispose();
      return;
    }
    if (!ctx.hasUI || (ctx as Partial<ExtensionContext>).mode !== "tui") {
      ctx.ui.notify("The review sidebar requires Pi's terminal UI.", "warning");
      return;
    }
    this.mount(ctx);
  }

  /** Re-render after feed or verdict changes; follows session replacement. */
  refresh(ctx?: ExtensionContext): void {
    if (ctx !== undefined && this.open && ctx !== this.ctx) this.mount(ctx);
    this.requestRender?.();
  }

  dispose(): void {
    clearInterval(this.ticker);
    this.ticker = undefined;
    this.close?.();
    this.close = undefined;
    this.requestRender = undefined;
    this.ctx = undefined;
  }

  private mount(ctx: ExtensionContext): void {
    this.dispose();
    this.ctx = ctx;
    let active = true;
    this.close = () => {
      active = false;
    };
    const release = (): void => {
      if (this.ctx === ctx) this.dispose();
    };
    void Promise.resolve(
      ctx.ui.custom<undefined>(
        (tui, theme, _keys, done) => {
          const finish = (): void => {
            active = false;
            done(undefined);
          };
          if (active) this.close = finish;
          else queueMicrotask(finish);
          this.requestRender = () => {
            tui.requestRender();
          };
          this.ticker = setInterval(() => {
            if (this.entries().some((entry) => entry.phase === "running"))
              tui.requestRender();
          }, 250);
          this.ticker.unref();
          let rows: SidebarLayout["rows"] = [];
          return {
            render: (width: number): string[] => {
              const layout = layoutSidebar(
                this.entries(),
                this.lookup,
                theme,
                width,
                Math.max(8, tui.terminal.rows - EDITOR_RESERVE),
                Date.now(),
                this.expanded,
              );
              rows = layout.rows;
              return layout.lines;
            },
            handleMouse: (event) => {
              if (event.type !== "click" || event.button !== "left") return;
              const id = rows[event.y];
              const entry = this.entries().find(
                (candidate) => candidate.id === id,
              );
              if (entry === undefined || entry.phase === "running") return;
              if (!this.expanded.delete(entry.id)) this.expanded.add(entry.id);
              return { handled: true, render: true };
            },
            invalidate(): void {
              return;
            },
          };
        },
        {
          overlay: true,
          overlayOptions: {
            anchor: "top-right",
            width: "34%",
            minWidth: 38,
            margin: { top: 1, right: 1 },
            nonCapturing: true,
            visible: (columns: number) => columns >= MIN_COLUMNS,
          },
        },
      ),
    ).then(release, release);
  }
}
