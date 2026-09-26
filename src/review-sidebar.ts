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
    ? { icon: "◆", color: "warning", text }
    : { icon: "✗", color: "muted", text };
}

function entryLines(
  entry: FeedEntry,
  findings: readonly Decided[],
  theme: Painter,
  width: number,
  now: number,
): string[] {
  const state =
    entry.phase === "running"
      ? {
          icon: SPINNER.charAt(Math.floor(now / 250) % SPINNER.length),
          color: "accent" as const,
          text: "reviewing…",
        }
      : summary(findings);
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
  const visible = entries.flatMap((entry) => {
    const findings = decided(entry, lookup);
    return entry.phase === "running" || findings.length > 0
      ? [{ entry, findings }]
      : [];
  });
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
  if (visible.length === 0)
    body.push(
      theme.fg("muted", "Nothing to show yet."),
      theme.fg("dim", "Running reviews and decided"),
      theme.fg("dim", "findings appear here."),
    );
  let shown = 0;
  for (const { entry, findings } of visible) {
    const block = [
      ...(shown === 0 ? [] : [""]),
      ...entryLines(entry, findings, theme, inner, now),
    ];
    const reserve = shown + 1 < visible.length ? 1 : 0;
    if (body.length + block.length + reserve > room) break;
    body.push(...block);
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
