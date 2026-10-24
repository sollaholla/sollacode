import { ThreadId, type OrchestrationLiveBeat } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { OrchestratorWorld, ThreadSnapshot } from "./events";
import {
  buildStage,
  CAST_LIMIT,
  CAST_RECENT_MS,
  countWorld,
  describeCounts,
  describeElapsed,
  describeSection,
  mergeEnvironmentBeats,
  presentBeat,
  projectDotClass,
  subtitleFor,
  SUBTITLE_MS,
} from "./liveInspector";

const NOW = Date.parse("2026-10-11T20:00:00.000Z");
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString();

function snapshot(id: string, overrides: Partial<ThreadSnapshot> = {}): ThreadSnapshot {
  return {
    threadKey: `env:${id}`,
    threadId: id,
    environmentId: "env",
    title: `Thread ${id}`,
    isWorking: false,
    waitingOn: "nothing",
    hasError: false,
    lastError: null,
    failureKind: null,
    errorAt: null,
    settled: false,
    environmentUnreachable: false,
    model: "model",
    provider: "codex",
    accessMode: "full-access",
    interactionMode: "default",
    effort: "default",
    isSideChat: false,
    sideChatParentThreadId: null,
    backgroundAgentName: null,
    projectId: "project",
    projectName: "Project",
    workspaceName: "project",
    latestTurnState: "completed",
    ...overrides,
  };
}

function world(...snapshots: ThreadSnapshot[]): OrchestratorWorld {
  return new Map(snapshots.map((entry) => [entry.threadKey, entry]));
}

function beat(
  id: string,
  thread: string,
  msAgo: number,
  overrides: Partial<OrchestrationLiveBeat> = {},
) {
  return {
    id,
    threadId: ThreadId.make(thread),
    kind: "command",
    title: "Ran",
    detail: "pnpm test",
    live: false,
    at: iso(msAgo),
    ...overrides,
  } satisfies OrchestrationLiveBeat;
}

describe("mergeEnvironmentBeats", () => {
  it("interleaves environments by time and keys beats by environment", () => {
    const merged = mergeEnvironmentBeats([
      { environmentId: "a", beats: [beat("1", "t", 3_000), beat("2", "t", 1_000)] },
      { environmentId: "b", beats: [beat("1", "u", 2_000)] },
    ]);
    expect(merged.map((entry) => entry.key)).toEqual(["a:1", "b:1", "a:2"]);
    expect(merged[1]?.threadKey).toBe("b:u");
  });
});

describe("buildStage", () => {
  it("puts who needs the person first, then the working, then recent finishes", () => {
    const beats = mergeEnvironmentBeats([
      {
        environmentId: "env",
        beats: [
          beat("old", "idle", CAST_RECENT_MS + 60_000),
          beat("w1", "working", 30_000),
          beat("d1", "done", 60_000),
          beat("w2", "working", 5_000, { title: "Running", live: true }),
        ],
      },
    ]);
    const { sections, offStage } = buildStage(
      world(
        snapshot("idle"),
        snapshot("done"),
        snapshot("working", { isWorking: true, latestTurnState: "running" }),
        snapshot("asking", { waitingOn: "user-input", isWorking: true }),
      ),
      beats,
      NOW,
      new Map([["env:working", iso(12 * 60_000)]]),
    );
    expect(sections).toHaveLength(1);
    const members = sections[0]!.members;
    expect(members.map((member) => [member.snapshot.threadId, member.statusLabel])).toEqual([
      ["asking", "Waiting for your answer"],
      ["working", "Working"],
      ["done", "Finished"],
    ]);
    expect(members[1]?.action?.beat.id).toBe("w2");
    expect(members[1]?.workingSince).toBe(iso(12 * 60_000));
    expect(members[2]?.workingSince).toBeNull();
    expect(sections[0]).toMatchObject({ needsYou: 1, working: 1 });
    expect(offStage).toBe(0);
  });

  it("groups threads by project, the most urgent project first", () => {
    const { sections } = buildStage(
      world(
        snapshot("game-1", { projectId: "game", projectName: "Game", isWorking: true }),
        snapshot("desk-1", { projectId: "desk", projectName: "Desk", waitingOn: "approval" }),
        snapshot("game-2", { projectId: "game", projectName: "Game", isWorking: true }),
      ),
      [],
      NOW,
    );
    expect(sections.map((section) => [section.projectName, section.members.length])).toEqual([
      ["Desk", 1],
      ["Game", 2],
    ]);
    expect(describeSection(sections[0]!)).toBe("1 needs you");
    expect(describeSection(sections[1]!)).toBe("2 working");
  });

  it("gives each card the agent's latest words and its latest move, or what it is asking", () => {
    const beats = mergeEnvironmentBeats([
      {
        environmentId: "env",
        beats: [
          beat("said-old", "t", 50_000, { kind: "said", title: "Said", detail: "Looking." }),
          beat("ask", "t", 40_000, {
            kind: "attention",
            title: "Asked you a question",
            detail: "Which branch?",
          }),
          beat("said", "t", 30_000, { kind: "said", title: "Said", detail: "Fixing the grid." }),
          beat("ran", "t", 10_000),
        ],
      },
    ]);
    const working = buildStage(world(snapshot("t", { isWorking: true })), beats, NOW).sections[0]!
      .members[0]!;
    expect(working.speech?.beat.detail).toBe("Fixing the grid.");
    expect(working.action?.beat.id).toBe("ran");
    expect(working.latest?.beat.id).toBe("ran");

    const asking = buildStage(world(snapshot("t", { waitingOn: "user-input" })), beats, NOW)
      .sections[0]!.members[0]!;
    expect(asking.action?.beat.id).toBe("ask");
  });

  it("leaves out a thread the person settled, even one still holding a plan", () => {
    const settledWorld = world(
      snapshot("settled-plan", { settled: true, waitingOn: "proposed-plan" }),
      snapshot("open", { isWorking: true }),
    );
    const { sections } = buildStage(settledWorld, [], NOW);
    expect(
      sections.flatMap((section) => section.members.map((member) => member.threadKey)),
    ).toEqual(["env:open"]);
    expect(countWorld(settledWorld)).toMatchObject({ working: 1, needsYou: 0, quiet: 0 });
  });

  it("shows a recent failure, leaves out a stale one, and counts what does not fit", () => {
    const failed = buildStage(
      world(
        snapshot("fresh", { hasError: true, errorAt: iso(60_000), latestTurnState: "error" }),
        snapshot("stale", { hasError: true, errorAt: iso(CAST_RECENT_MS * 3) }),
      ),
      [],
      NOW,
    );
    expect(
      failed.sections.flatMap((section) =>
        section.members.map((member) => [member.snapshot.threadId, member.status]),
      ),
    ).toEqual([["fresh", "failed"]]);

    const crowd = Array.from({ length: CAST_LIMIT + 2 }, (_, index) =>
      snapshot(`t${index}`, { isWorking: true }),
    );
    const crowded = buildStage(world(...crowd), [], NOW);
    expect(crowded.sections.flatMap((section) => section.members)).toHaveLength(CAST_LIMIT);
    expect(crowded.offStage).toBe(2);
  });
});

describe("counts", () => {
  it("reads as a short sentence without zeroes, naming how many projects are busy", () => {
    const counts = countWorld(
      world(
        snapshot("a", { isWorking: true }),
        snapshot("b", { waitingOn: "approval" }),
        snapshot("c"),
        snapshot("d"),
      ),
    );
    expect(describeCounts(counts)).toBe("1 working · 1 needs you · 2 quiet");
    expect(
      describeCounts(
        countWorld(
          world(
            snapshot("a", { isWorking: true, projectId: "one" }),
            snapshot("b", { isWorking: true, projectId: "two" }),
            snapshot("c", { isWorking: true, projectId: "two" }),
          ),
        ),
      ),
    ).toBe("3 working across 2 projects");
    expect(describeCounts({ working: 0, workingProjects: 0, needsYou: 2, quiet: 0 })).toBe(
      "2 need you",
    );
    expect(describeCounts({ working: 0, workingProjects: 0, needsYou: 0, quiet: 0 })).toBe(
      "No open threads",
    );
  });

  it("says how long the work under way has run", () => {
    expect(describeElapsed(iso(20_000), NOW)).toBe("just started");
    expect(describeElapsed(iso(12 * 60_000), NOW)).toBe("12m");
    expect(describeElapsed(iso(65 * 60_000), NOW)).toBe("1h 5m");
    expect(describeElapsed(iso(120 * 60_000), NOW)).toBe("2h");
    expect(describeElapsed(null, NOW)).toBeNull();
  });
});

describe("presentBeat", () => {
  it("shows commands as code, words as quotes, and trouble in its own tone", () => {
    expect(presentBeat(beat("1", "t", 0))).toMatchObject({ lead: "Ran", bodyStyle: "code" });
    expect(
      presentBeat(beat("2", "t", 0, { kind: "said", title: "Said", detail: "Done." })),
    ).toEqual({ lead: null, body: "Done.", bodyStyle: "quote", tone: "default" });
    expect(presentBeat(beat("3", "t", 0, { kind: "attention" })).tone).toBe("attention");
    expect(presentBeat(beat("4", "t", 0, { kind: "error" })).tone).toBe("error");
  });
});

describe("subtitleFor", () => {
  const orchestrator = "env:solla-orchestrator";
  const said = (msAgo: number, live: boolean) =>
    mergeEnvironmentBeats([
      {
        environmentId: "env",
        beats: [
          beat("ask", "solla-orchestrator", msAgo + 1_000, {
            kind: "asked",
            title: "You wrote",
            detail: "What is Fieldwork doing?",
          }),
          beat("other", "elsewhere", 0, { kind: "said", detail: "Not the orchestrator" }),
          beat("reply", "solla-orchestrator", msAgo, {
            kind: "said",
            title: "Said",
            detail: "Fieldwork is rerunning its tests.",
            live,
          }),
        ],
      },
    ]);

  it("shows the orchestrator's reply, while written and for a while after", () => {
    expect(subtitleFor(said(5_000, true), orchestrator, NOW)).toMatchObject({
      speaker: "orchestrator",
      text: "Fieldwork is rerunning its tests.",
      live: true,
    });
    expect(subtitleFor(said(SUBTITLE_MS - 1_000, false), orchestrator, NOW)).not.toBeNull();
    expect(subtitleFor(said(SUBTITLE_MS + 1_000, false), orchestrator, NOW)).toBeNull();
    expect(subtitleFor(said(5_000, true), null, NOW)).toBeNull();
  });

  it("shows what the person sent until the reply starts", () => {
    const beats = mergeEnvironmentBeats([
      {
        environmentId: "env",
        beats: [
          beat("ask", "solla-orchestrator", 2_000, {
            kind: "asked",
            title: "You wrote",
            detail: "Pause the trading desk",
          }),
        ],
      },
    ]);
    expect(subtitleFor(beats, orchestrator, NOW)).toMatchObject({
      speaker: "you",
      text: "Pause the trading desk",
    });
  });
});

describe("projectDotClass", () => {
  it("gives a project the same colour every time", () => {
    expect(projectDotClass("project-a")).toBe(projectDotClass("project-a"));
    expect(projectDotClass("x")).toMatch(/^bg-/);
  });
});
