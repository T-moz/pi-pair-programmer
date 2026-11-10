import { realpathSync } from "node:fs";
import { z } from "zod";

const REGISTRY_KEY = Symbol.for("pi-subagents.required-child-extensions.v1");
const EXTENSION_ID = "pi-pair-programmer";

type Snapshot = readonly Readonly<{ id: string; path: string }>[];

const RegistrySchema = z.object({
  version: z.literal(1),
  bySession: z.instanceof(Map),
});

export type ChildRegistration =
  | { status: "registered"; dispose: () => void }
  | { status: "conflict" | "unsupported" };

function sessions(): Map<string, Snapshot> | undefined {
  const existing: unknown = Reflect.get(globalThis, REGISTRY_KEY);
  if (existing === undefined) {
    const bySession = new Map<string, Snapshot>();
    Reflect.set(globalThis, REGISTRY_KEY, { version: 1, bySession });
    return bySession;
  }
  const registry = RegistrySchema.safeParse(existing);
  return registry.success
    ? (registry.data.bySession as Map<string, Snapshot>)
    : undefined;
}

export function requireInChildSessions(
  sessionId: string,
  extensionPath: string,
): ChildRegistration {
  const registry = sessions();
  if (registry === undefined) return { status: "unsupported" };
  const canonical = realpathSync(extensionPath);
  const existing = registry.get(sessionId);
  if (existing?.some((entry) => entry.path === canonical) === true)
    return {
      status: "registered",
      dispose: () => {
        return;
      },
    };
  if (existing !== undefined) return { status: "conflict" };
  const snapshot: Snapshot = Object.freeze([
    Object.freeze({ id: EXTENSION_ID, path: canonical }),
  ]);
  registry.set(sessionId, snapshot);
  return {
    status: "registered",
    dispose: () => {
      if (registry.get(sessionId) === snapshot) registry.delete(sessionId);
    },
  };
}
