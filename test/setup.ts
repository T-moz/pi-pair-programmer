import { tmpdir } from "node:os";
import path from "node:path";

// Keep tests from reading the developer's real Pi state directory, such as a
// global `pair-programmer.reviewers.json`.
process.env["PI_CODING_AGENT_DIR"] = path.join(
  tmpdir(),
  `pair-programmer-missing-agent-dir-${String(process.pid)}`,
);
