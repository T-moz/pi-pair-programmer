import type { MessageRenderer } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { acceptedLines, renderAccepted } from "../src/accepted-card.js";

const theme = {
  fg: (color: string, text: string) => `<${color}>${text}`,
  bold: (text: string) => `*${text}`,
};
const plain = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
};
const details = {
  title: "Imperative loop used to construct collection",
  file: "apps/hush/lib/pages/chat_detail/widgets/message_bubble/linkified_message_text.dart",
  line: 91,
  evidence: "The changed code builds TextSpan children with a collection-for.",
  reason: "Reworking it for the unsafe-index warning.",
};
type Args = Parameters<MessageRenderer>;
const render = (
  message: Partial<Args[0]>,
  expanded: boolean,
  width = 120,
): string[] | undefined =>
  renderAccepted(
    message as Args[0],
    { expanded, outputPad: 1 },
    theme as unknown as Args[2],
  )?.render(width);

describe("accepted finding card", () => {
  it("collapses to the title and a file-name-first location", () => {
    expect(render({ details }, false)).toEqual([
      " <warning>◆ *Imperative loop used to construct collection",
      `   <dim>${details.file}:91`,
    ]);
    expect(acceptedLines(details, plain, 70, false, 1)).toEqual([
      " ◆ Imperative loop used to construct collection",
      "   …/chat_detail/widgets/message_bubble/linkified_message_text.dart:91",
    ]);
  });

  it("reveals the evidence and quoted reason when expanded", () => {
    const lines = render({ details }, true) ?? [];
    expect(lines).toHaveLength(4);
    expect(lines[2]).toBe(
      "   <muted>The changed code builds TextSpan children with a collection-for.",
    );
    expect(lines[3]).toBe(
      "   <dim>“Reworking it for the unsafe-index warning.”",
    );
  });

  it("wraps within narrow widths and keeps the file name", () => {
    for (const width of [3, 12, 24, 40]) {
      const lines = acceptedLines(details, plain, width, true, 4);
      for (const line of lines)
        expect(visibleWidth(line)).toBeLessThanOrEqual(width);
    }
    const narrow = acceptedLines(details, plain, 24, false);
    expect(narrow.at(-1)).toContain("…");
    expect(narrow.at(-1)).toContain(":91");
    expect(narrow.slice(1, -1).every((line) => line.startsWith("  "))).toBe(
      true,
    );
  });

  it("falls back to Pi's default rendering for older or malformed messages", () => {
    expect(render({}, false)).toBeUndefined();
    expect(
      render({ details: { ...details, line: "91" } }, true),
    ).toBeUndefined();
    const component = renderAccepted(
      { details } as Args[0],
      { expanded: false, outputPad: 0 },
      theme as unknown as Args[2],
    );
    expect(() => component?.invalidate()).not.toThrow();
  });
});
