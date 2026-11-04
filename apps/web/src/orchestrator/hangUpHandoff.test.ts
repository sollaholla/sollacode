import { describe, expect, it } from "vite-plus/test";

import { buildHangUpHandoff, promisesFollowUp } from "./hangUpHandoff";

const now = 1_800_000_000_000;
const base = {
  awaited: [],
  workingAtHangUp: false,
  lastAssistantLine: "Bye for now.",
  spokeThisCall: true,
  nowMs: now,
};

describe("buildHangUpHandoff", () => {
  it("stays quiet when nothing was left open", () => {
    expect(buildHangUpHandoff(base)).toBeNull();
  });

  it("stays quiet when nothing was said on the call", () => {
    expect(buildHangUpHandoff({ ...base, spokeThisCall: false, workingAtHangUp: true })).toBeNull();
  });

  it("hands over work the voice said it would report on", () => {
    const message = buildHangUpHandoff({
      ...base,
      awaited: [
        {
          threadKey: "e:t",
          threadTitle: "Release build",
          request: "run the tests",
          askedAt: now - 60_000,
        },
      ],
    });
    expect(message).toContain("hung up");
    expect(message).toContain("- Release build: run the tests");
  });

  it("forgets work asked about too long ago", () => {
    expect(
      buildHangUpHandoff({
        ...base,
        awaited: [
          { threadKey: "e:t", threadTitle: "Old", request: "x", askedAt: now - 3 * 60 * 60_000 },
        ],
      }),
    ).toBeNull();
  });

  it("hands over a spoken promise and work still under way", () => {
    expect(
      buildHangUpHandoff({ ...base, lastAssistantLine: "I'll get back to you once it builds." }),
    ).toContain("Your last words on the call");
    expect(buildHangUpHandoff({ ...base, workingAtHangUp: true })).toContain(
      "still in the middle of something",
    );
  });
});

describe("promisesFollowUp", () => {
  it("hears a promise, not a goodbye", () => {
    expect(promisesFollowUp("Let me check on that and let you know.")).toBe(true);
    expect(promisesFollowUp("I'll keep you posted.")).toBe(true);
    expect(promisesFollowUp("Talk soon, bye!")).toBe(false);
    expect(promisesFollowUp(null)).toBe(false);
  });
});
