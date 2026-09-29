import type {
  EntryRenderer,
  MessageRenderer,
  Theme,
} from "@earendil-works/pi-coding-agent";
import {
  sliceByColumn,
  visibleWidth,
  wrapTextWithAnsi,
  type Component,
} from "@earendil-works/pi-tui";
import { z } from "zod";
import { truncatePath } from "./format.js";

export const ACCEPTED_MESSAGE = "pair-programmer-accepted";
/** Custom entry type: rendered in the transcript, never sent to the model. */
export const REJECTED_ENTRY = "pair-programmer-rejected";

const CardDetails = z.object({
  title: z.string(),
  file: z.string(),
  line: z.number(),
  evidence: z.string(),
  reason: z.string(),
  reviewer: z.string().optional(),
});
export type CardDetails = z.infer<typeof CardDetails>;
export type Verdict = "accepted" | "rejected";

type Painter = Pick<Theme, "fg" | "bold">;
/** The transcript object a card renders; stable across Pi's rebuilds. */
type CardKey = Parameters<MessageRenderer>[0] | Parameters<EntryRenderer>[0];

/**
 * Accepted: bold title plus location; rejected: one dimmed line. Expanding
 * either reveals the location, evidence and the agent's reason.
 */
export function cardLines(
  details: CardDetails,
  verdict: Verdict,
  theme: Painter,
  width: number,
  expanded: boolean,
  pad = 0,
): string[] {
  const indent = " ".repeat(Math.max(0, Math.min(pad, width - 4)));
  const inner = Math.max(1, width - visibleWidth(indent) - 2);
  const accepted = verdict === "accepted";
  const suffix = accepted ? "" : " · rejected";
  const marker = theme.fg("dim", `${suffix}${expanded ? " ▾" : " ▸"}`);
  const title = wrapTextWithAnsi(
    details.title,
    Math.max(1, inner - visibleWidth(suffix) - 2),
  );
  const icon = accepted ? theme.fg("warning", "◆") : theme.fg("muted", "✗");
  const lines = title.map((part, index) => {
    const text = accepted ? theme.bold(part) : theme.fg("muted", part);
    const first = index === 0 ? icon : " ";
    return `${first} ${text}${index === title.length - 1 ? marker : ""}`;
  });
  if (accepted || expanded) {
    const location = `:${String(details.line)}`;
    const by = details.reviewer === undefined ? "" : ` · ${details.reviewer}`;
    const path = truncatePath(
      details.file,
      Math.max(1, inner - visibleWidth(location + by)),
    );
    lines.push(`  ${theme.fg("dim", path + location + by)}`);
  }
  if (expanded)
    lines.push(
      ...wrapTextWithAnsi(details.evidence, inner).map(
        (part) => `  ${theme.fg("muted", part)}`,
      ),
      ...wrapTextWithAnsi(`“${details.reason}”`, inner).map(
        (part) => `  ${theme.fg("dim", part)}`,
      ),
    );
  return lines.map((line) => sliceByColumn(indent + line, 0, width));
}

/**
 * A card's own click toggle, remembered per message or entry because Pi
 * rebuilds the component on every expand or theme change. `base` records the
 * global expand state when clicked, so a later ctrl+o overrides the toggle.
 */
const toggled = new WeakMap<CardKey, { open: boolean; base: boolean }>();

function card(
  key: CardKey,
  payload: unknown,
  verdict: Verdict,
  theme: Painter,
  expanded: boolean,
  pad: number,
): Component | undefined {
  const parsed = CardDetails.safeParse(payload);
  if (!parsed.success) return;
  const open = (): boolean => {
    const state = toggled.get(key);
    return state?.base === expanded ? state.open : expanded;
  };
  return {
    render: (width: number): string[] =>
      cardLines(parsed.data, verdict, theme, width, open(), pad),
    handleMouse(event) {
      if (event.type !== "click" || event.button !== "left") return;
      toggled.set(key, { open: !open(), base: expanded });
      return { handled: true, render: true };
    },
    invalidate(): void {
      return;
    },
  };
}

/** Accepted findings; unknown payloads fall back to Pi's default rendering. */
export const renderAccepted: MessageRenderer = (message, options, theme) =>
  card(
    message,
    message.details,
    "accepted",
    theme,
    options.expanded,
    options.outputPad,
  );

/** Rejected findings, stored as transcript-only entries. */
export const renderRejected: EntryRenderer = (entry, options, theme) =>
  card(entry, entry.data, "rejected", theme, options.expanded, 1);
