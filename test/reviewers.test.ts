import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import {
  DEFAULT_REVIEWERS,
  loadReviewers,
  matchingReviewers,
  reviewerKey,
  type ReviewerConfig,
} from "../src/reviewers.js";

const directories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(
    path.join(tmpdir(), "pair-programmer-reviewers-"),
  );
  directories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

it("uses one current-model reviewer when the optional config does not exist", async () => {
  const directory = await temporaryDirectory();
  const reviewers = await loadReviewers(directory);
  expect(reviewers).toHaveLength(1);
  expect(reviewers[0]?.model).toBe("current");
});

it("reports a non-missing unreadable config instead of falling back", async () => {
  const directory = await temporaryDirectory();
  const file = path.join(directory, "pair-programmer.reviewers.json");
  await mkdir(file);
  await expect(loadReviewers(directory)).rejects.toThrow(file);
});

it("loads exactly the configured reviewers and honors an explicitly empty list", async () => {
  const directory = await temporaryDirectory();
  const file = path.join(directory, "pair-programmer.reviewers.json");
  await writeFile(file, JSON.stringify({ reviewers: [] }));
  expect(await loadReviewers(directory)).toEqual([]);

  const configured: ReviewerConfig = {
    model: "provider/model",
    prompt: "Find material errors with file and line evidence",
    include: ["src/**/*.ts"],
    exclude: ["**/*.test.ts"],
  };
  await writeFile(file, JSON.stringify({ reviewers: [configured] }));
  expect(await loadReviewers(directory)).toEqual([configured]);
  const firstLoad = await loadReviewers(directory);
  const secondLoad = await loadReviewers(directory);
  expect(firstLoad.map(reviewerKey)).toEqual(secondLoad.map(reviewerKey));
});

it("rejects invalid JSON with the configuration path", async () => {
  const directory = await temporaryDirectory();
  const file = path.join(directory, "pair-programmer.reviewers.json");
  await writeFile(file, "not JSON");
  await expect(loadReviewers(directory)).rejects.toThrow(file);
});

it.each([
  ["null", "configuration"],
  ["[]", "configuration"],
  ["{}", "reviewers"],
  ['{"reviewers":{}}', "reviewers"],
  ['{"reviewers":[],"retry":1}', "retry"],
  ['{"reviewers":[null]}', "reviewers[0]"],
  [
    '{"reviewers":[{"model":"current","prompt":"review","include":["*.ts"],"exclude":[],"timeout":1}]}',
    "reviewers[0].timeout",
  ],
  [
    '{"reviewers":[{"model":"","prompt":"review","include":["*.ts"],"exclude":[]}]}',
    "reviewers[0].model",
  ],
  [
    '{"reviewers":[{"model":"  ","prompt":"review","include":["*.ts"],"exclude":[]}]}',
    "reviewers[0].model",
  ],
  [
    '{"reviewers":[{"model":"current","prompt":"  ","include":["*.ts"],"exclude":[]}]}',
    "reviewers[0].prompt",
  ],
  [
    '{"reviewers":[{"model":"current","prompt":3,"include":["*.ts"],"exclude":[]}]}',
    "reviewers[0].prompt",
  ],
  [
    '{"reviewers":[{"model":"current","prompt":"review","include":null,"exclude":[]}]}',
    "reviewers[0].include",
  ],
  [
    '{"reviewers":[{"model":"current","prompt":"review","include":[],"exclude":[]}]}',
    "reviewers[0].include",
  ],
  [
    '{"reviewers":[{"model":"current","prompt":"review","include":["*.ts"],"exclude":null}]}',
    "reviewers[0].exclude",
  ],
  [
    '{"reviewers":[{"model":"current","prompt":"review","include":[null],"exclude":[]}]}',
    "reviewers[0].include[0]",
  ],
  [
    '{"reviewers":[{"model":"current","prompt":"review","include":[""],"exclude":[]}]}',
    "reviewers[0].include[0]",
  ],
  [
    '{"reviewers":[{"model":"current","prompt":"review","include":["   "],"exclude":[]}]}',
    "reviewers[0].include[0]",
  ],
  [
    '{"reviewers":[{"model":"current","prompt":"review","include":[" *.ts"],"exclude":[]}]}',
    "reviewers[0].include[0]",
  ],
  [
    '{"reviewers":[{"model":"current","prompt":"review","include":["/src/*.ts"],"exclude":[]}]}',
    "reviewers[0].include[0]",
  ],
  [
    '{"reviewers":[{"model":"current","prompt":"review","include":["../*.ts"],"exclude":[]}]}',
    "reviewers[0].include[0]",
  ],
  [
    String.raw`{"reviewers":[{"model":"current","prompt":"review","include":["*.ts"],"exclude":["src\\*.ts"]}]}`,
    "reviewers[0].exclude[0]",
  ],
  [
    '{"reviewers":[{"model":"current","prompt":"review","include":["C:secret.ts"],"exclude":[]}]}',
    "reviewers[0].include[0]",
  ],
  [
    '{"reviewers":[{"model":"current","prompt":"review","include":["src/[bad"],"exclude":[]}]}',
    "reviewers[0].include[0]",
  ],
  [
    '{"reviewers":[{"model":"current","prompt":"review","include":["src/bad]"],"exclude":[]}]}',
    "reviewers[0].include[0]",
  ],
  [
    '{"reviewers":[{"model":"current","prompt":"review","include":["src//*.ts"],"exclude":[]}]}',
    "reviewers[0].include[0]",
  ],
  [
    '{"reviewers":[{"model":"current","prompt":"review","include":["src/./*.ts"],"exclude":[]}]}',
    "reviewers[0].include[0]",
  ],
  [
    '{"reviewers":[{"model":"current","prompt":"review","include":["*.ts"],"exclude":["../private/**"]}]}',
    "reviewers[0].exclude[0]",
  ],
  [
    '{"reviewers":[{"model":"current","prompt":"review","include":["*.ts"],"exclude":["src/{bad"]}]}',
    "reviewers[0].exclude[0]",
  ],
  [
    '{"reviewers":[{"model":"current","prompt":"review","include":["src/@(foo|bar}.ts"],"exclude":[]}]}',
    "reviewers[0].include[0]",
  ],
  [
    '{"reviewers":[{"model":"current","prompt":"review","include":["src/@(foo|bar.ts"],"exclude":[]}]}',
    "reviewers[0].include[0]",
  ],
])(
  "rejects malformed config at the relevant field: %s",
  async (contents, field) => {
    const directory = await temporaryDirectory();
    const file = path.join(directory, "pair-programmer.reviewers.json");
    await writeFile(file, contents);
    const loading = loadReviewers(directory);
    await expect(loading).rejects.toThrow(file);
    await expect(loading).rejects.toThrow(field);
  },
);

it("matches normalized root and nested files, applying exclusions after inclusions", () => {
  const source: ReviewerConfig = {
    model: "current",
    prompt: "source",
    include: ["**/*.ts"],
    exclude: ["**/*.test.ts", "generated/**"],
  };
  const docs: ReviewerConfig = {
    model: "current",
    prompt: "docs",
    include: ["docs/**/*.md"],
    exclude: [],
  };
  const reviewers = [source, docs];
  expect(matchingReviewers("index.ts", reviewers)).toEqual([source]);
  expect(matchingReviewers("src/nested/file.ts", reviewers)).toEqual([source]);
  expect(matchingReviewers(String.raw`src\nested\file.ts`, reviewers)).toEqual([
    source,
  ]);
  expect(matchingReviewers("src/./nested/../file.ts", reviewers)).toEqual([
    source,
  ]);
  expect(matchingReviewers("docs/guide.md", reviewers)).toEqual([docs]);
  expect(matchingReviewers("src/file.test.ts", reviewers)).toEqual([]);
  expect(matchingReviewers("generated/file.ts", reviewers)).toEqual([]);
  expect(matchingReviewers("images/logo.png", reviewers)).toEqual([]);
});

it("matches valid brace globs and hidden files without letting exclusions escape", async () => {
  const directory = await temporaryDirectory();
  const configured: ReviewerConfig = {
    model: "current",
    prompt: "Check changes",
    include: ["src/**/*.{ts,tsx}", "src/@(README|CONTRIBUTING).md"],
    exclude: ["src/**/generated/**"],
  };
  await writeFile(
    path.join(directory, "pair-programmer.reviewers.json"),
    JSON.stringify({ reviewers: [configured] }),
  );
  const reviewers = await loadReviewers(directory);
  expect(matchingReviewers("src/.hidden/file.tsx", reviewers)).toEqual([
    configured,
  ]);
  expect(matchingReviewers("src/README.md", reviewers)).toEqual([configured]);
  expect(matchingReviewers("src/OTHER.md", reviewers)).toEqual([]);
  expect(matchingReviewers("src/generated/file.ts", reviewers)).toEqual([]);
  expect(matchingReviewers("src/.hidden/generated/file.ts", reviewers)).toEqual(
    [],
  );
  expect(matchingReviewers("../src/file.ts", reviewers)).toEqual([]);
});

it.each([
  "",
  ".",
  "..",
  "../outside.ts",
  String.raw`..\outside.ts`,
  "src/../../outside.ts",
  "/outside/file.ts",
  "C:outside.ts",
  String.raw`C:\private\file.ts`,
  String.raw`\\server\share\file.ts`,
  `src/${String.fromCodePoint(0)}file.ts`,
])(
  "never matches a path outside the project or an invalid file: %s",
  (file) => {
    expect(matchingReviewers(file, DEFAULT_REVIEWERS)).toEqual([]);
  },
);

it("uses semantic reviewer identity regardless of pattern order", () => {
  const first: ReviewerConfig = {
    model: "current",
    prompt: "Check correctness",
    include: ["src/**/*.ts", "test/**/*.ts"],
    exclude: ["src/generated/**", "**/*.snap.ts"],
  };
  const same: ReviewerConfig = {
    ...first,
    include: first.include.toReversed(),
    exclude: first.exclude.toReversed(),
  };
  const changed: ReviewerConfig = { ...first, prompt: "Check security" };
  const key = reviewerKey(first);
  expect(key).toBe(reviewerKey(same));
  expect(key).not.toBe(reviewerKey(changed));
  expect(key).not.toBe(reviewerKey({ ...first, model: "other/model" }));
  expect(key).not.toBe(reviewerKey({ ...first, include: ["src/**/*.ts"] }));
  expect(key).not.toBe(reviewerKey({ ...first, exclude: [] }));
});
