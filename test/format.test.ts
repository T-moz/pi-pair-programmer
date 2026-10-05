import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { frame, truncatePath } from "../src/format.js";

describe("truncatePath", () => {
  it("keeps file names and drops leading directories first", () => {
    const file = "apps/hush/lib/pages/chat_detail/widgets/bubble.dart";
    expect(truncatePath(file, 80)).toBe(file);
    expect(truncatePath(file, 28)).toBe("…/widgets/bubble.dart");
    expect(truncatePath(file, 16)).toBe("…/bubble.dart");
    expect(truncatePath(file, 8)).toBe("…le.dart");
    expect(truncatePath("變更變更變更.ts", 6)).toBe("…更.ts");
    expect(truncatePath("x.ts", 0)).toBe("…");
  });
});

describe("frame", () => {
  const theme = { fg: (_color: string, text: string) => text };

  it("pads and truncates rows inside a border of the exact width", () => {
    const box = frame(theme, 12, 2);
    expect(box.inner).toBe(6);
    expect(box.render(["ab", "abcdefghij"])).toEqual([
      "╭──────────╮",
      "│  ab      │",
      "│  abcde\u{1B}[0m…\u{1B}[0m  │",
      "╰──────────╯",
    ]);
    for (const line of frame(theme, 3, 1).render(["x"]))
      expect(visibleWidth(line)).toBeLessThanOrEqual(5);
  });
});
