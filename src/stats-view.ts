import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import type { MeasuredTotal, StatsSnapshot } from "./pair-stats.js";
import type { ReviewStore } from "./review-store.js";
import { truncatePath } from "./review-sidebar.js";

function measured(
  total: MeasuredTotal,
  calls: number,
  cost = false,
  accountingComplete = true,
): string {
  if (total.measured === 0) return "unavailable";
  const value = cost ? `$${total.value.toFixed(6)}` : String(total.value);
  const coverage =
    accountingComplete && total.measured === calls ? "complete" : "partial";
  return `${value} (${coverage} ${String(total.measured)}/${String(calls)})`;
}

function terminalLabel(value: string): string {
  let label = "";
  for (const character of value)
    label += character >= " " && character <= "~" ? character : "?";
  return label;
}

export function statsLines(
  stats: StatsSnapshot,
  store: Pick<ReviewStore, "enabled" | "summary">,
): string[] {
  const review = stats.reviews;
  const findings = store.summary();
  const lines = [
    `Background review: ${store.enabled ? "on" : "off"}`,
    "",
    "Review activity: incurred in this session, across all branches",
    `Running ${String(review.running)} | completed ${String(review.success)} | failed ${String(review.failed)}`,
    `Cancelled ${String(review.cancelled)} | timed out ${String(review.timeout)} | obsolete ${String(review.obsolete)}`,
    `Interrupted on reload ${String(review.interrupted)} (final outcome unknown)`,
    stats.finished === 0
      ? "Review latency: unavailable (no finalized jobs)"
      : `Review latency: average ${String(Math.round(stats.durationMs / stats.finished))} ms | max ${String(Math.round(stats.maxDurationMs))} ms`,
    "",
    "Findings: selected branch only (authoritative review state)",
    `Pending ${String(findings.pending)} | awaiting decision ${String(findings.outstanding)}`,
    `Accepted ${String(findings.accepted)} | rejected ${String(findings.rejected)} | discarded ${String(findings.discarded)}`,
    "",
    "Extension model usage: separate from main-agent host totals",
    ...(stats.incompleteJobs === 0
      ? []
      : [
          `INCOMPLETE accounting: ${String(stats.incompleteJobs)} review job(s) may have unreported calls or usage.`,
        ]),
    "Per-field measured subtotals of recorded calls; missing usage is not zero.",
    "Cost is an estimate in USD, not a billing total.",
  ];
  if (stats.persistenceFailures > 0)
    lines.push(
      `Storage unavailable for ${String(stats.persistenceFailures)} record(s); current process snapshot retained.`,
    );
  if (stats.pendingWrites > 0)
    lines.push(
      `${String(stats.pendingWrites)} unsaved record(s); reopen this session before exiting to retry persistence.`,
    );
  if (stats.usage.length === 0)
    lines.push("No finalized extension model calls recorded.");
  for (const group of stats.usage) {
    const prefix = group.provider === undefined ? "" : `${group.provider}/`;
    const model =
      group.model === undefined
        ? `unobserved (requested ${group.requestedModel})`
        : `${prefix}${group.model}`;
    lines.push(
      "",
      `${group.stage}: ${terminalLabel(model)}`,
      `Calls ${String(group.calls)} | success ${String(group.outcomes.success)} | failed ${String(group.outcomes.failed)} | cancelled ${String(group.outcomes.cancelled)} | timed out ${String(group.outcomes.timeout)}`,
      `Call latency average ${String(Math.round(group.durationMs / group.calls))} ms`,
      `Input ${measured(group.inputTokens, group.calls, false, stats.incompleteJobs === 0)} | output ${measured(group.outputTokens, group.calls, false, stats.incompleteJobs === 0)}`,
      `Cache read ${measured(group.cacheReadTokens, group.calls, false, stats.incompleteJobs === 0)} | cache write ${measured(group.cacheWriteTokens, group.calls, false, stats.incompleteJobs === 0)}`,
      `Total tokens ${measured(group.totalTokens, group.calls, false, stats.incompleteJobs === 0)} | estimated cost ${measured(group.costUsd, group.calls, true, stats.incompleteJobs === 0)}`,
    );
  }
  return lines;
}

export function statsSummary(
  stats: StatsSnapshot,
  store: Pick<ReviewStore, "enabled" | "summary">,
): string[] {
  const review = stats.reviews;
  const findings = store.summary();
  const cost = stats.usage.reduce(
    (total, group) => ({
      value: total.value + group.costUsd.value,
      measured: total.measured + group.costUsd.measured,
    }),
    { value: 0, measured: 0 },
  );
  const calls = stats.usage.reduce((total, group) => total + group.calls, 0);
  return [
    store.enabled ? "Watching your changes" : "Background review is paused",
    "",
    "REVIEWS  /  this session, all branches",
    `${String(review.success)} completed   ·   ${String(review.running)} running`,
    `${String(review.failed + review.timeout)} failed or timed out   ·   ${String(review.interrupted)} interrupted`,
    "",
    "FINDINGS  /  selected branch",
    `${String(findings.accepted)} accepted   ·   ${String(findings.rejected)} rejected`,
    `${String(findings.outstanding)} awaiting decision   ·   ${String(findings.pending)} queued`,
    "",
    "USAGE  /  extension only",
    `Estimated cost  ${measured(cost, calls, true, stats.incompleteJobs === 0)}`,
    `${String(calls)} recorded model calls · USD estimate, not a bill`,
    ...(stats.incompleteJobs > 0
      ? ["! Accounting is incomplete; missing usage is not zero."]
      : []),
    ...(stats.persistenceFailures > 0 || stats.pendingWrites > 0
      ? ["! Some records could not be saved. See details."]
      : []),
  ];
}

/** Files ranked by accepted findings, with bars scaled to `width` columns. */
export function statsHotspots(
  store: Pick<ReviewStore, "hotspots">,
  width: number,
): string[] {
  const files = store.hotspots();
  if (files.length === 0)
    return [
      "No decided findings on this branch yet.",
      "Files with accepted findings will rank here.",
    ];
  const most = Math.max(1, ...files.map(({ accepted }) => accepted));
  const count = String(most).length;
  const bar = Math.max(4, Math.min(12, Math.floor(width / 6)));
  const path = Math.max(8, width - bar - count - 16);
  return [
    "ACCEPTED  /  by file, selected branch",
    ...files.map(({ file, accepted, rejected }) => {
      const name = truncatePath(file, path).padEnd(path);
      const filled = "█".repeat(Math.ceil((accepted / most) * bar));
      const extra = rejected > 0 ? `  · ${String(rejected)} rejected` : "";
      return `${name}  ${filled.padEnd(bar)}  ${String(accepted).padStart(count)}${extra}`;
    }),
  ];
}

export interface StatsReport {
  summary: readonly string[];
  details: readonly string[];
  hotspots: (width: number) => readonly string[];
}

type Tab = "overview" | "details" | "hotspots";
type TabSpec = readonly [key: string, tab: Tab, subtitle: string];
const OVERVIEW: TabSpec = ["o", "overview", "Session overview"];
/** Tabs in hint order. */
const TABS: readonly TabSpec[] = [
  OVERVIEW,
  ["d", "details", "Detailed accounting"],
  ["h", "hotspots", "Hotspots · accepted findings by file"],
];
const TAB_BY_KEY = new Map(TABS.map((spec) => [spec[0], spec]));

export class StatsView {
  private closeCurrent: (() => void) | undefined;

  close(): void {
    this.closeCurrent?.();
    this.closeCurrent = undefined;
  }

  async open(ctx: ExtensionContext, read: () => StatsReport): Promise<void> {
    this.close();
    const unavailable = "/pair-stats requires an interactive terminal (TUI).";
    if (!ctx.hasUI) throw new Error(unavailable);

    const mode = (ctx as Partial<ExtensionContext>).mode;
    if (mode !== undefined && mode !== "tui") {
      ctx.ui.notify(unavailable, "warning");
      return;
    }
    const state = { mounted: false };
    let close: (() => void) | undefined;
    try {
      await ctx.ui.custom<undefined>(
        (tui, theme, keys, done) => {
          state.mounted = true;
          let report = read();
          let spec = OVERVIEW;
          let offset = 0;
          let pageSize = 1;
          let disposed = false;
          close = (): void => {
            if (disposed) return;
            disposed = true;
            done(undefined);
          };
          this.closeCurrent = close;
          return {
            render(width: number): string[] {
              const columns = Math.max(1, width);
              const framed = columns >= 12;
              const inner = Math.max(1, columns - (framed ? 6 : 0));
              const tab = spec[1];
              let lines = report.summary;
              if (tab === "details") lines = report.details;
              else if (tab === "hotspots") lines = report.hotspots(inner);
              const wrapped = lines.flatMap((line) => {
                let tone: "warning" | "accent" | "text" = "text";
                if (line.startsWith("!")) tone = "warning";
                else if (/^[A-Z]+ {2}\//u.test(line)) tone = "accent";
                return wrapTextWithAnsi(line, inner).map((part) =>
                  theme.fg(tone, part),
                );
              });
              const compact = tui.terminal.rows < 8;
              pageSize = Math.max(
                1,
                compact
                  ? tui.terminal.rows
                  : Math.floor(tui.terminal.rows * 0.8) - 7,
              );
              offset = Math.min(offset, Math.max(0, wrapped.length - pageSize));
              if (compact) return wrapped.slice(offset, offset + pageSize);
              const row = (text: string): string => {
                const clipped = truncateToWidth(text, inner, "…");
                return framed
                  ? theme.fg("borderMuted", "│") +
                      "  " +
                      clipped +
                      " ".repeat(Math.max(0, inner - visibleWidth(clipped))) +
                      "  " +
                      theme.fg("borderMuted", "│")
                  : clipped;
              };
              const title = theme.bold(theme.fg("accent", "Pair Programmer"));
              const position = `${String(offset + 1)}–${String(Math.min(offset + pageSize, wrapped.length))}/${String(wrapped.length)}`;
              const others = TABS.filter(([, name]) => name !== tab);
              const tabs = others
                .map(([key, name]) => `${key} ${name}`)
                .join("  ");
              const hint =
                inner >= 64
                  ? `↑↓ scroll  ${tabs}  r refresh  esc  ${position}`
                  : `↑↓  ${others.map(([key]) => key).join(" ")}  r  q close`;
              const body = [
                row(title),
                row(theme.fg("dim", spec[2])),
                row(""),
                ...wrapped.slice(offset, offset + pageSize).map(row),
                row(""),
                row(theme.fg("dim", hint)),
              ];
              return framed
                ? [
                    theme.fg("borderMuted", `╭${"─".repeat(columns - 2)}╮`),
                    ...body,
                    theme.fg("borderMuted", `╰${"─".repeat(columns - 2)}╯`),
                  ]
                : body;
            },
            handleInput(data: string): void {
              if (
                data === "q" ||
                keys.matches(data, "tui.select.confirm") ||
                keys.matches(data, "tui.select.cancel") ||
                keys.matches(data, "app.clear")
              )
                close?.();
              else {
                const next = TAB_BY_KEY.get(data);
                if (next !== undefined) {
                  spec = next === spec ? OVERVIEW : next;
                  offset = 0;
                } else if (data === "r") {
                  report = read();
                  offset = 0;
                } else if (keys.matches(data, "tui.select.up"))
                  offset = Math.max(0, offset - 1);
                else if (keys.matches(data, "tui.select.down")) offset += 1;
                else if (keys.matches(data, "tui.select.pageUp"))
                  offset = Math.max(0, offset - pageSize);
                else if (keys.matches(data, "tui.select.pageDown"))
                  offset += pageSize;
                tui.requestRender();
              }
            },
            invalidate(): void {
              return;
            },
            dispose(): void {
              disposed = true;
            },
          };
        },
        { overlay: true, overlayOptions: { width: 78 } },
      );
      if (!state.mounted) throw new Error(unavailable);
    } finally {
      if (this.closeCurrent === close) this.closeCurrent = undefined;
    }
  }
}
