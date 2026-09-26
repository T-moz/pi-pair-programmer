import type { MessageRenderer } from "@earendil-works/pi-coding-agent";
import {
  visibleWidth,
  type Component,
  type TuiMouseEvent,
} from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import {
  cardLines,
  renderAccepted,
  renderRejected,
} from "../src/finding-card.js";

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

describe("rejected finding card", () => {
  const render = (
    expanded: boolean,
    data: unknown = details,
  ): string[] | undefined =>
    renderRejected(
      { data } as Parameters<typeof renderRejected>[0],
      { expanded },
      plain as unknown as Args[2],
    )?.render(120);

  it("folds to one dimmed line and expands to location, evidence and reason", () => {
    expect(render(false)).toEqual([
      " ✗ Imperative loop used to construct collection · rejected ▸",
    ]);
    const open = render(true) ?? [];
    expect(open[0]).toMatch(/· rejected ▾$/u);
    expect(open[1]).toContain(`${details.file}:91`);
    expect(open.at(-1)).toBe("   “Reworking it for the unsafe-index warning.”");
  });

  it("toggles by click and ignores malformed entries", () => {
    const entry = { data: details } as Parameters<typeof renderRejected>[0];
    const card = renderRejected(
      entry,
      { expanded: false },
      plain as unknown as Args[2],
    );
    card?.handleMouse?.({ type: "click", button: "left" } as TuiMouseEvent);
    expect(card?.render(120).length).toBeGreaterThan(1);
    expect(render(false, { title: "only" })).toBeUndefined();
  });
});

describe("accepted finding card", () => {
  it("collapses to the title and a file-name-first location", () => {
    expect(render({ details }, false)).toEqual([
      " <warning>◆ *Imperative loop used to construct collection<dim> ▸",
      `   <dim>${details.file}:91`,
    ]);
    expect(cardLines(details, "accepted", plain, 70, false, 1)).toEqual([
      " ◆ Imperative loop used to construct collection ▸",
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
    expect(
      cardLines(
        { ...details, reviewer: "entropy" },
        "accepted",
        plain,
        60,
        false,
      )[1],
    ).toBe("  …/message_bubble/linkified_message_text.dart:91 · entropy");
  });

  it("wraps within narrow widths and keeps the file name", () => {
    for (const width of [3, 12, 24, 40]) {
      const lines = cardLines(details, "accepted", plain, width, true, 4);
      for (const line of lines)
        expect(visibleWidth(line)).toBeLessThanOrEqual(width);
    }
    const narrow = cardLines(details, "accepted", plain, 24, false);
    expect(narrow.at(-1)).toContain("…");
    expect(narrow.at(-1)).toContain(":91");
    expect(narrow.slice(1, -1).every((line) => line.startsWith("  "))).toBe(
      true,
    );
  });

  it("toggles by left click, survives rebuilds, and yields to the global expand", () => {
    const message = { details } as Args[0];
    const card = (expanded: boolean): Component | undefined =>
      renderAccepted(
        message,
        { expanded, outputPad: 0 },
        plain as unknown as Args[2],
      );
    const click = { type: "click", button: "left" } as TuiMouseEvent;
    const collapsed = card(false);
    expect(collapsed?.render(120)).toHaveLength(2);
    const ignored: TuiMouseEvent[] = [
      { ...click, button: "right" },
      { ...click, type: "press" },
      { ...click, type: "wheel" },
    ];
    for (const event of ignored)
      expect(collapsed?.handleMouse?.(event)).toBeUndefined();
    expect(collapsed?.handleMouse?.(click)).toEqual({
      handled: true,
      render: true,
    });
    expect(collapsed?.render(120)).toHaveLength(4);
    expect(collapsed?.render(120)[0]).toContain("▾");
    expect(card(false)?.render(120)).toHaveLength(4);
    card(false)?.handleMouse?.(click);
    expect(card(false)?.render(120)).toHaveLength(2);
    card(false)?.handleMouse?.(click);
    expect(card(true)?.render(120)).toHaveLength(4);
    card(true)?.handleMouse?.(click);
    expect(card(true)?.render(120)).toHaveLength(2);
    expect(card(false)?.render(120)).toHaveLength(2);
    expect(
      renderAccepted(
        { details } as Args[0],
        { expanded: true, outputPad: 0 },
        plain as unknown as Args[2],
      )?.render(120),
    ).toHaveLength(4);
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
