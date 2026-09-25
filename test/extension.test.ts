import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { expect, it, vi } from "vitest";
import pairProgrammer from "../src/index.js";

it("confirms the extension loaded when its command runs", async () => {
  const commands = new Map<
    string,
    Parameters<ExtensionAPI["registerCommand"]>[1]
  >();

  pairProgrammer({
    registerCommand(name, command) {
      commands.set(name, command);
    },
  } as ExtensionAPI);

  const command = commands.get("pair-programmer");
  if (!command) {
    throw new Error("The pair-programmer command was not registered");
  }

  const notify = vi.fn<ExtensionCommandContext["ui"]["notify"]>();
  await command.handler("", {
    ui: { notify },
  } as unknown as ExtensionCommandContext);

  expect(notify).toHaveBeenCalledOnce();
  expect(notify).toHaveBeenCalledWith(
    expect.stringContaining("loaded"),
    "info",
  );
});
