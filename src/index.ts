import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function pairProgrammer(pi: ExtensionAPI): void {
  pi.registerCommand("pair-programmer", {
    description: "Confirm the Pi Pair Programmer extension is loaded",
    handler: async (_args, ctx) => {
      ctx.ui.notify("Pi Pair Programmer extension is loaded.", "info");
    },
  });
}
