import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function pairProgrammer(pi: ExtensionAPI): void {
  pi.registerCommand("pair-programmer", {
    description: "Confirm the Pi Pair Programmer extension is loaded",
    // Pi requires a Promise-returning handler even for synchronous notifications.
    // eslint-disable-next-line @typescript-eslint/require-await
    handler: async (_args, ctx) => {
      ctx.ui.notify("Pi Pair Programmer extension is loaded.", "info");
    },
  });
}
