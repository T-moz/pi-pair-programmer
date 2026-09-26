import { describe, expect, it } from "vitest";
import { ReviewFeed } from "../src/review-feed.js";

const job = {
  file: "src/a.ts",
  model: "openai/gpt-5",
};

describe("ReviewFeed", () => {
  it("records reviews newest first with short model names", () => {
    const feed = new ReviewFeed();
    feed.start("one", job, 1);
    feed.start("two", { ...job, model: "local" }, 2);
    expect(feed.list().map((entry) => entry.id)).toEqual(["two", "one"]);
    expect(feed.list()[1]).toMatchObject({
      model: "gpt-5",
      phase: "running",
      startedAt: 1,
    });
    expect(feed.list()[0]).toMatchObject({ model: "local" });
    expect(new ReviewFeed().list()).toEqual([]);
    const defaulted = new ReviewFeed();
    defaulted.start("now", job);
    expect(defaulted.list()[0]?.startedAt).toBeGreaterThan(0);
  });

  it("settles each review once and attributes findings without duplicates", () => {
    const feed = new ReviewFeed();
    feed.start("one", job, 1);
    feed.finish("one", "success", 40);
    feed.finish("one", "failed", 90);
    feed.finish("missing", "failed", 1);
    feed.attach("one", ["a", "b"]);
    feed.attach("one", ["b", "c"]);
    feed.attach("missing", ["z"]);
    expect(feed.list()[0]).toMatchObject({
      phase: "success",
      durationMs: 40,
      findingIds: ["a", "b", "c"],
    });
    feed.clear();
    expect(feed.list()).toEqual([]);
  });

  it("keeps only the latest hundred reviews", () => {
    const feed = new ReviewFeed();
    for (let index = 0; index < 105; index += 1)
      feed.start(String(index), job, index);
    expect(feed.list()).toHaveLength(100);
    expect(feed.list()[0]?.id).toBe("104");
    expect(feed.list().at(-1)?.id).toBe("5");
  });
});
