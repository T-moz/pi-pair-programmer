import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import {
  sliceByColumn,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import type { FeedEntry } from "./review-feed.js";
import type { FindingView } from "./review-store.js";

type Painter = Pick<Theme, "fg" | "bold">;
type Color = Parameters<Theme["fg"]>[0];
export type Lookup = (id: string) => FindingView | undefined;

const SPINNER = "◐◓◑◒";
export const MIN_COLUMNS = 90;
// Rows kept clear under the card for the editor and footer.
const EDITOR_RESERVE = 8;

/** Keeps the end of a path: drop whole leading directories first, then characters. */
export function truncatePath(file: string, width: number): string {
  if (visibleWidth(file) <= width) return file;
  const parts = file.split("/");
  for (let index = 1; index < parts.length; index += 1) {
    const tail = `…/${parts.slice(index).join("/")}`;
    if (visibleWidth(tail) <= width) return tail;
  }
  const graphemes = Array.from(
    new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(file),
    ({ segment }) => segment,
  );
  const start = graphemes.findIndex(
    (_, index) => visibleWidth(`…${graphemes.slice(index).join("")}`) <= width,
  );
  return start === -1 ? "…" : `…${graphemes.slice(start).join("")}`;
}

/** Joins left and right text on one row, shrinking the right side first. */
function spread(left: string, right: string, width: number): string {
  const room = Math.max(0, width - visibleWidth(left) - 1);
  let shown = right;
  if (visibleWidth(right) > room)
    shown = room === 0 ? "" : `${sliceByColumn(right, 0, room - 1).trimEnd()}…`;
  const gap = Math.max(1, width - visibleWidth(left) - visibleWidth(shown));
  return `${left}${" ".repeat(gap)}${shown}`;
}

function seconds(ms: number): string {
  return ms < 10_000
    ? `${(ms / 1000).toFixed(1)}s`
    : `${String(Math.round(ms / 1000))}s`;
}

function outcome(
  entry: FeedEntry,
  findings: number,
  now: number,
): { icon: string; color: Color; text: string } {
  switch (entry.phase) {
    case "running": {
      const frame = SPINNER.charAt(Math.floor(now / 250) % SPINNER.length);
      return { icon: frame, color: "accent", text: "reviewing…" };
    }
    case "success": {
      if (findings === 0)
        return { icon: "✓", color: "success", text: "no findings" };
      const noun = findings === 1 ? "finding" : "findings";
      return {
        icon: "◆",
        color: "warning",
        text: `${String(findings)} ${noun}`,
      };
    }
    case "failed":
      return { icon: "✗", color: "error", text: "review failed" };
    case "timeout":
      return { icon: "✗", color: "error", text: "timed out" };
    case "obsolete":
      return { icon: "○", color: "dim", text: "superseded by a newer edit" };
    case "cancelled":
      return { icon: "○", color: "dim", text: "cancelled" };
  }
}

const FINDING: Record<
  FindingView["status"],
  { icon: string; color: Color; label: string }
> = {
  queued: { icon: "·", color: "accent", label: "queued" },
  awaiting: { icon: "?", color: "warning", label: "awaiting decision" },
  accepted: { icon: "✓", color: "success", label: "accepted" },
  rejected: { icon: "✗", color: "muted", label: "rejected" },
  discarded: { icon: "○", color: "dim", label: "discarded" },
};

function entryLines(
  entry: FeedEntry,
  lookup: Lookup,
  theme: Painter,
  width: number,
  now: number,
): string[] {
  const findings = entry.findingIds.flatMap((id) => {
    const view = lookup(id);
    return view === undefined ? [] : [view];
  });
  const state = outcome(entry, findings.length, now);
  const time = theme.fg(
    "dim",
    seconds(entry.durationMs ?? Math.max(0, now - entry.startedAt)),
  );
  const file = truncatePath(
    entry.file,
    Math.max(1, width - visibleWidth(time) - 3),
  );
  const lines = [
    spread(
      `${theme.fg(state.color, state.icon)} ${theme.bold(file)}`,
      time,
      width,
    ),
    spread(
      `  ${theme.fg(state.color, state.text)}`,
      theme.fg("dim", entry.model),
      width,
    ),
  ];
  for (const finding of findings) {
    const style = FINDING[finding.status];
    lines.push(
      `  ${theme.fg(style.color, style.icon)} ${finding.title}${theme.fg("dim", " :" + String(finding.line))}`,
      `    ${theme.fg(style.color, style.label)}`,
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

/** Renders the framed sidebar at an exact width, at most `height` rows. */
export function renderSidebar(
  entries: readonly FeedEntry[],
  lookup: Lookup,
  theme: Painter,
  width: number,
  height: number,
  now = Date.now(),
): string[] {
  const inner = Math.max(1, width - 4);
  const row = (text: string): string => {
    const clipped = truncateToWidth(text, inner, "…");
    const pad = " ".repeat(Math.max(0, inner - visibleWidth(clipped)));
    return `${theme.fg("borderMuted", "│")} ${clipped}${pad} ${theme.fg("borderMuted", "│")}`;
  };
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
  const footer = ["", theme.fg("dim", "alt+r hide · /pair-stats totals")];
  const room = Math.max(0, height - 2 - header.length - footer.length);
  const body: string[] = [];
  if (entries.length === 0)
    body.push(
      theme.fg("muted", "No reviews yet."),
      theme.fg("dim", "They appear after each edit."),
    );
  let shown = 0;
  for (const entry of entries) {
    const block = [
      ...(shown === 0 ? [] : [""]),
      ...entryLines(entry, lookup, theme, inner, now),
    ];
    const reserve = shown + 1 < entries.length ? 1 : 0;
    if (body.length + block.length + reserve > room) break;
    body.push(...block);
    shown += 1;
  }
  if (shown < entries.length) {
    const hidden = entries.length - shown;
    body.push(
      theme.fg(
        "dim",
        `+${String(hidden)} earlier review${hidden === 1 ? "" : "s"}`,
      ),
    );
  }
  const content = [...header, ...body].slice(0, room + header.length);
  return [
    theme.fg("borderMuted", `╭${"─".repeat(Math.max(0, width - 2))}╮`),
    ...[...content, ...footer].map(row),
    theme.fg("borderMuted", `╰${"─".repeat(Math.max(0, width - 2))}╯`),
  ];
}

/** Togglable, non-capturing right-hand overlay showing the live review feed. */
export class ReviewSidebar {
  private readonly entries: () => readonly FeedEntry[];
  private readonly lookup: Lookup;
  private ctx: ExtensionContext | undefined;
  private close: (() => void) | undefined;
  private requestRender: (() => void) | undefined;
  private ticker: NodeJS.Timeout | undefined;

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
          return {
            render: (width: number): string[] =>
              renderSidebar(
                this.entries(),
                this.lookup,
                theme,
                width,
                Math.max(8, tui.terminal.rows - EDITOR_RESERVE),
              ),
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
