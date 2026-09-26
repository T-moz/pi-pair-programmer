import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { MeasuredTotal, StatsSnapshot } from "./pair-stats.js";
import type { ReviewStore } from "./review-store.js";

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
    `Pair Programmer statistics - ${store.enabled ? "on" : "off"}`,
    "Snapshot on open; close and run /pair-stats again to refresh.",
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

export class StatsView {
  private closeCurrent: (() => void) | undefined;

  close(): void {
    this.closeCurrent?.();
    this.closeCurrent = undefined;
  }

  async open(ctx: ExtensionContext, lines: readonly string[]): Promise<void> {
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
        (tui, _theme, keys, done) => {
          state.mounted = true;
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
              const wrapped: string[] = [];
              const columns = Math.max(1, width);
              for (const line of lines) {
                if (line.length === 0) wrapped.push("");
                for (let index = 0; index < line.length; index += columns)
                  wrapped.push(line.slice(index, index + columns));
              }
              pageSize = Math.max(1, tui.terminal.rows - 4);
              offset = Math.min(offset, Math.max(0, wrapped.length - pageSize));
              return [
                ...wrapped.slice(offset, offset + pageSize),
                "",
                "Up/Down/PgUp/PgDn scroll | Enter/Esc/q close".slice(
                  0,
                  columns,
                ),
              ];
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
                if (keys.matches(data, "tui.select.up"))
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
        { overlay: true },
      );
      if (!state.mounted) throw new Error(unavailable);
    } finally {
      if (this.closeCurrent === close) this.closeCurrent = undefined;
    }
  }
}
