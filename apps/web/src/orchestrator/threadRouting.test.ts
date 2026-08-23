import { describe, expect, it } from "vite-plus/test";

import type { ThreadSnapshot } from "./events";
import { describeCandidate, resolveThreadReference, similarity } from "./threadRouting";

let counter = 0;

const thread = (overrides: Partial<ThreadSnapshot> = {}): ThreadSnapshot => {
  counter += 1;
  const threadId = overrides.threadId ?? `thread-${counter}`;
  return {
    threadId,
    environmentId: "env-1",
    title: "Rover",
    isWorking: false,
    waitingOn: "nothing",
    isSideChat: false,
    sideChatParentThreadId: null,
    backgroundAgentName: null,
    hasError: false,
    environmentUnreachable: false,
    lastError: null,
    failureKind: null,
    errorAt: null,
    settled: false,
    model: "claude-opus-5",
    provider: "claudeAgent",
    accessMode: "full-access",
    interactionMode: "default",
    effort: "high",
    latestTurnState: "completed",
    projectId: "project-1",
    projectName: "Rover Project",
    workspaceName: "rover",
    ...overrides,
    threadKey: `env-1:${threadId}`,
  };
};

const worldOf = (...threads: ReadonlyArray<ThreadSnapshot>) =>
  new Map(threads.map((entry) => [entry.threadKey, entry]));

describe("spoken references", () => {
  it("ignores the filler words people say around a name", () => {
    // The reported failure verbatim: "the Solla Code thread" matched nothing.
    const target = thread({ title: "Solla Code" });
    const world = worldOf(target, thread({ title: "Vera Medical" }));

    for (const spoken of [
      "the Solla Code thread",
      "Solla Code",
      "solla code",
      "that solla code chat",
      "the Solla Code one please",
    ]) {
      const resolution = resolveThreadReference(world, spoken);
      expect(resolution.kind, spoken).toBe("resolved");
      if (resolution.kind === "resolved") {
        expect(resolution.thread.threadId, spoken).toBe(target.threadId);
        expect(resolution.confident, spoken).toBe(true);
      }
    }
  });

  it("treats punctuation and casing as noise", () => {
    // Speech has no hyphens, so "t3 fork" has to reach "t3-fork".
    const target = thread({ title: "t3-fork" });
    const world = worldOf(target);
    for (const spoken of ["t3 fork", "T3 Fork", "t3_fork", "T3-FORK"]) {
      const resolution = resolveThreadReference(world, spoken);
      expect(resolution.kind, spoken).toBe("resolved");
    }
  });

  it("matches a partial name", () => {
    const target = thread({ title: "Vera Medical intake API" });
    const resolution = resolveThreadReference(worldOf(target), "Vera Medical");
    expect(resolution.kind).toBe("resolved");
  });

  it("tolerates a mis-transcribed name", () => {
    const target = thread({ title: "Vera Medical", projectName: "Vera" });
    const resolution = resolveThreadReference(worldOf(target), "vera medcal");
    expect(resolution.kind).toBe("resolved");
  });

  it("matches a name the transcriber spelled by ear", () => {
    // The reported case. None of these share enough letters with "CareGen" to
    // reach the fuzzy tier, and all of them are the same word said out loud.
    const target = thread({ title: "CareGen", projectName: "CareGen" });
    const world = worldOf(target, thread({ title: "Rover" }));

    for (const spoken of ["CaraGen", "Karagen", "Care Gen", "caregen"]) {
      const resolution = resolveThreadReference(world, spoken);
      expect(resolution.kind, spoken).toBe("resolved");
      if (resolution.kind === "resolved") {
        expect(resolution.thread.threadId, spoken).toBe(target.threadId);
        // Acted on without a "did you mean" — the transcript is the only
        // spelling this input channel can ever produce.
        expect(resolution.confident, spoken).toBe(true);
      }
    }
  });

  it("still refuses a name that merely rhymes with nothing in particular", () => {
    const resolution = resolveThreadReference(
      worldOf(thread({ title: "CareGen", projectName: "CareGen" })),
      "quarterly budget",
    );
    expect(resolution.kind).toBe("not-found");
  });

  it("asks when two threads sound equally alike", () => {
    const world = worldOf(
      thread({ title: "CareGen", projectName: "One" }),
      thread({ title: "Care Gen", projectName: "Two" }),
    );
    const resolution = resolveThreadReference(world, "caragen");
    expect(resolution.kind).toBe("ambiguous");
  });

  it("lets a written match beat one that only sounds alike", () => {
    const written = thread({ title: "CaraGen", projectName: "One" });
    const spoken = thread({ title: "CareGen", projectName: "Two" });
    const resolution = resolveThreadReference(worldOf(written, spoken), "CaraGen");
    expect(resolution.kind).toBe("resolved");
    if (resolution.kind === "resolved") {
      expect(resolution.thread.threadId).toBe(written.threadId);
      expect(resolution.matchedOn).toBe("exact-title");
    }
  });

  it("does not force a match on an unrelated word", () => {
    // A confidently wrong route is far worse than asking.
    const resolution = resolveThreadReference(
      worldOf(thread({ title: "Vera Medical", projectName: "Vera Medical" })),
      "quarterly budget",
    );
    expect(resolution.kind).toBe("not-found");
  });

  it("offers the closest threads when nothing matches", () => {
    const resolution = resolveThreadReference(
      worldOf(thread({ title: "Vera Medical", projectName: "Vera" })),
      "vera dental",
    );
    if (resolution.kind === "not-found") {
      expect(resolution.suggestions.length).toBeGreaterThan(0);
    } else {
      // A near-miss resolving outright is also acceptable; a hard failure is not.
      expect(resolution.kind).toBe("resolved");
    }
  });
});

describe("exactness beats fuzziness", () => {
  it("prefers a real title match over a merely similar one", () => {
    const exact = thread({ title: "Rover" });
    const similarOne = thread({ title: "Rovers" });
    const resolution = resolveThreadReference(worldOf(similarOne, exact), "Rover");
    expect(resolution.kind).toBe("resolved");
    if (resolution.kind === "resolved") {
      expect(resolution.thread.threadId).toBe(exact.threadId);
    }
  });
});

describe("project as a second axis", () => {
  it("resolves a thread by the project the user named", () => {
    const target = thread({ title: "intake API", projectName: "Vera Medical" });
    const resolution = resolveThreadReference(
      worldOf(target, thread({ title: "Rover", projectName: "Rover Project" })),
      "Vera Medical",
    );
    expect(resolution.kind).toBe("resolved");
    if (resolution.kind === "resolved") {
      expect(resolution.thread.threadId).toBe(target.threadId);
    }
  });

  it("asks which one when a project has several threads", () => {
    // Exactly the reported case: three threads, all "Vera Medical".
    const world = worldOf(
      thread({ title: "Vera Medical", projectName: "Vera Medical" }),
      thread({ title: "Vera Medical", projectName: "Vera Medical" }),
      thread({ title: "Vera Medical", projectName: "Vera Medical" }),
    );
    const resolution = resolveThreadReference(world, "Vera Medical");
    expect(resolution.kind).toBe("ambiguous");
    if (resolution.kind === "ambiguous") {
      expect(resolution.candidates).toHaveLength(3);
    }
  });

  it("uses a project hint to break a tie between same-named threads", () => {
    const wanted = thread({ title: "API", projectName: "Vera Medical" });
    const other = thread({ title: "API", projectName: "Rover Project" });
    const resolution = resolveThreadReference(worldOf(other, wanted), "API", {
      projectHint: "Vera Medical",
    });
    expect(resolution.kind).toBe("resolved");
    if (resolution.kind === "resolved") {
      expect(resolution.thread.threadId).toBe(wanted.threadId);
    }
  });

  it("falls back to asking when the project hint fits neither", () => {
    // A wrong hint must degrade to a question, never to a wrong route.
    const world = worldOf(
      thread({ title: "API", projectName: "Vera Medical" }),
      thread({ title: "API", projectName: "Rover Project" }),
    );
    const resolution = resolveThreadReference(world, "API", { projectHint: "Atlantis" });
    expect(resolution.kind).toBe("ambiguous");
  });

  it("distinguishes candidates out loud by project and state", () => {
    const description = describeCandidate(
      thread({ title: "Vera Medical", projectName: "Intake", isWorking: true }),
    );
    expect(description).toContain("Vera Medical");
    expect(description).toContain("Intake");
    expect(description).toContain("working");
  });
});

describe("ids still work", () => {
  it("resolves an exact thread id", () => {
    const target = thread({ threadId: "abc-123", title: "Rover" });
    const resolution = resolveThreadReference(worldOf(target), "abc-123");
    expect(resolution.kind).toBe("resolved");
    if (resolution.kind === "resolved") {
      expect(resolution.matchedOn).toBe("thread-id");
    }
  });
});

describe("similarity", () => {
  it("scores identical strings 1 and unrelated ones near 0", () => {
    expect(similarity("Rover", "Rover")).toBe(1);
    expect(similarity("Rover", "rover")).toBe(1);
    expect(similarity("Rover", "Vera Medical")).toBeLessThan(0.3);
  });
});
