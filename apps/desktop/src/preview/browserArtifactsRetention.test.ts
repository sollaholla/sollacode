import { describe, expect, it } from "vite-plus/test";

import {
  planBrowserArtifactSweep,
  type BrowserArtifactEntry,
} from "./browserArtifactsRetention.ts";

const DAY = 24 * 60 * 60 * 1_000;
const MB = 1024 * 1024;
const NOW = 100 * DAY;
const policy = { nowMs: NOW, maxAgeMs: 7 * DAY, maxTotalBytes: 100 * MB, minAgeMs: DAY };

const file = (name: string, ageMs: number, sizeMb: number): BrowserArtifactEntry => ({
  path: name,
  sizeBytes: sizeMb * MB,
  modifiedAtMs: NOW - ageMs,
});

const names = (entries: ReadonlyArray<BrowserArtifactEntry>) => entries.map((entry) => entry.path);

describe("planBrowserArtifactSweep", () => {
  it("removes anything past the maximum age and keeps the rest", () => {
    const plan = planBrowserArtifactSweep(
      [file("old", 8 * DAY, 1), file("recent", 2 * DAY, 1)],
      policy,
    );
    expect(names(plan)).toEqual(["old"]);
  });

  it("removes the oldest first until the folder fits under the cap", () => {
    const plan = planBrowserArtifactSweep(
      [file("a", 6 * DAY, 60), file("b", 4 * DAY, 60), file("c", 2 * DAY, 60)],
      policy,
    );
    expect(names(plan)).toEqual(["a", "b"]);
  });

  it("never touches a file younger than the minimum age, even over the cap", () => {
    const plan = planBrowserArtifactSweep(
      [file("just-written", DAY / 2, 500), file("older", 3 * DAY, 10)],
      policy,
    );
    expect(names(plan)).toEqual(["older"]);
  });

  it("does not count expired files twice when deciding how much to trim", () => {
    const plan = planBrowserArtifactSweep(
      [file("expired", 9 * DAY, 90), file("keep-1", 3 * DAY, 60), file("keep-2", 2 * DAY, 30)],
      policy,
    );
    expect(names(plan)).toEqual(["expired"]);
  });
});
