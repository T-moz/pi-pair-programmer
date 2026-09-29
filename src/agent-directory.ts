import { homedir } from "node:os";
import path from "node:path";

/** Pi's per-user state directory: `$PI_CODING_AGENT_DIR` or `~/.pi/agent`. */
export function agentDirectory(): string {
  return (
    process.env["PI_CODING_AGENT_DIR"] ?? path.join(homedir(), ".pi", "agent")
  );
}
