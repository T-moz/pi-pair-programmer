import { tmpdir } from "node:os";
import path from "node:path";

process.env["PI_CODING_AGENT_DIR"] = path.join(
  tmpdir(),
  `pair-programmer-missing-agent-dir-${String(process.pid)}`,
);
