import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { minimatch } from "minimatch";
import { z } from "zod";

/** Tools a reviewer may be granted. Each one must be read-only. */
export const REVIEWER_TOOLS = ["web_search"] as const;
export type ReviewerTool = (typeof REVIEWER_TOOLS)[number];

export interface ReviewerConfig {
  model: string;
  prompt: string;
  include: readonly string[];
  exclude: readonly string[];
  tools?: readonly ReviewerTool[] | undefined;
}

export const DEFAULT_REVIEWERS: readonly ReviewerConfig[] = [
  {
    model: "current",
    prompt: "Does it add entropy ?",
    include: ["**/*"],
    exclude: [],
  },
];

const matchOptions = { dot: true, nonegate: true, nocomment: true } as const;

function validGlobSyntax(pattern: string): boolean {
  const closing: string[] = [];
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern.charAt(index);
    if (character === "[" || character === "{") {
      closing.push(character === "[" ? "]" : "}");
      continue;
    }
    if (
      character === "(" &&
      ["@", "?", "+", "*", "!"].includes(pattern.charAt(index - 1))
    ) {
      closing.push(")");
      continue;
    }
    if (
      (character === "]" ||
        character === "}" ||
        (character === ")" && closing.at(-1) === ")")) &&
      closing.pop() !== character
    ) {
      return false;
    }
  }
  return closing.length === 0;
}

function validPattern(value: string): boolean {
  return (
    value.trim().length > 0 &&
    value.trim() === value &&
    !value.includes("\\") &&
    !/\p{Cc}/u.test(value) &&
    !path.posix.isAbsolute(value) &&
    !path.win32.isAbsolute(value) &&
    !/^[a-z]:/iu.test(value) &&
    value
      .split("/")
      .every((part) => part !== "" && part !== "." && part !== "..") &&
    validGlobSyntax(value)
  );
}

const PatternSchema = z.string().refine(validPattern, {
  message:
    "must be a nonempty project-relative POSIX glob with balanced syntax",
});
const ReviewerSchema = z.strictObject({
  model: z.string().refine((value) => value.trim().length > 0),
  prompt: z.string().refine((value) => value.trim().length > 0),
  include: z.array(PatternSchema).min(1),
  exclude: z.array(PatternSchema),
  tools: z
    .array(z.enum(REVIEWER_TOOLS))
    .refine((tools) => new Set(tools).size === tools.length, {
      message: "must not repeat a tool",
    })
    .optional(),
});
const ConfigSchema = z.strictObject({ reviewers: z.array(ReviewerSchema) });
const MissingConfigErrorSchema = z.object({ code: z.literal("ENOENT") });

export async function loadReviewers(
  cwd: string,
): Promise<readonly ReviewerConfig[]> {
  const file = path.join(cwd, "pair-programmer.reviewers.json");
  let contents: string;
  try {
    contents = await readFile(file, "utf8");
  } catch (error) {
    if (MissingConfigErrorSchema.safeParse(error).success) {
      return DEFAULT_REVIEWERS;
    }
    throw new Error(`${file}: could not read reviewer configuration`, {
      cause: error,
    });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(contents) as unknown;
  } catch (error) {
    throw new Error(`${file}: invalid JSON`, { cause: error });
  }
  const result = ConfigSchema.safeParse(parsed);
  if (!result.success) {
    const descriptions = result.error.issues.map((issue) => {
      const segments = [
        ...issue.path,
        ...(issue.code === "unrecognized_keys" ? [issue.keys[0]] : []),
      ];
      const location =
        segments.length === 0
          ? "configuration"
          : segments.reduce<string>((text, segment) => {
              if (typeof segment === "number")
                return `${text}[${String(segment)}]`;
              const separator = text.length === 0 ? "" : ".";
              return `${text}${separator}${String(segment)}`;
            }, "");
      return `${location} ${issue.message}`;
    });
    throw new Error(`${file}: ${descriptions.join("; ")}`);
  }
  return result.data.reviewers;
}

export function matchingReviewers(
  file: string,
  reviewers: readonly ReviewerConfig[],
): ReviewerConfig[] {
  if (
    file.length === 0 ||
    path.posix.isAbsolute(file) ||
    path.win32.isAbsolute(file) ||
    /^[a-z]:/iu.test(file) ||
    /\p{Cc}/u.test(file)
  ) {
    return [];
  }
  const normalized = path.posix.normalize(file.replaceAll("\\", "/"));
  return normalized === "." ||
    normalized === ".." ||
    normalized.startsWith("../")
    ? []
    : reviewers.filter(
        (reviewer) =>
          reviewer.include.some((pattern) =>
            minimatch(normalized, pattern, matchOptions),
          ) &&
          reviewer.exclude.every(
            (pattern) => !minimatch(normalized, pattern, matchOptions),
          ),
      );
}

export function reviewerKey(reviewer: ReviewerConfig): string {
  const sorted = (values: readonly string[]): string[] =>
    values.toSorted((left, right) => left.localeCompare(right));
  const identity: unknown[] = [
    reviewer.model,
    reviewer.prompt,
    sorted(reviewer.include),
    sorted(reviewer.exclude),
  ];
  // Reviewers without tools keep the identity they had before tools existed.
  const tools = reviewer.tools ?? [];
  if (tools.length > 0) identity.push(sorted(tools));
  return createHash("sha256").update(JSON.stringify(identity)).digest("hex");
}
