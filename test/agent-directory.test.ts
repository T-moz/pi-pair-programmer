import { homedir } from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { agentDirectory } from "../src/agent-directory.js";

afterEach(() => {
  vi.unstubAllEnvs();
});

it("uses PI_CODING_AGENT_DIR when set", () => {
  vi.stubEnv("PI_CODING_AGENT_DIR", "/custom/agent");
  expect(agentDirectory()).toBe("/custom/agent");
});

it("falls back to ~/.pi/agent", () => {
  vi.stubEnv("PI_CODING_AGENT_DIR", undefined);
  expect(agentDirectory()).toBe(path.join(homedir(), ".pi", "agent"));
});
