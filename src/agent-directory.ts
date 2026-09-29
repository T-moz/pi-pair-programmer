import { homedir } from "node:os";
import path from "node:path";

export function agentDirectory(): string {
  return (
    process.env["PI_CODING_AGENT_DIR"] ?? path.join(homedir(), ".pi", "agent")
  );
}
