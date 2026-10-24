import type { OrchestrationLiveBeat } from "@t3tools/contracts";

import type { OrchestratorWorld, ThreadSnapshot } from "./events";

/**
 * The Live Inspector's view model, kept pure so what lands on screen — who is
 * on stage, in what order, and how each beat reads — is testable without a
 * live environment.
 */

/** A beat with the environment it came from: beat ids are unique per environment only. */
export interface InspectorBeat {
  readonly key: string;
  readonly threadKey: string;
  readonly environmentId: string;
  readonly beat: OrchestrationLiveBeat;
}

/** Every environment's beats in one list, oldest first. */
export function mergeEnvironmentBeats(
  environments: ReadonlyArray<{
    readonly environmentId: string;
    readonly beats: ReadonlyArray<OrchestrationLiveBeat>;
  }>,
): ReadonlyArray<InspectorBeat> {
  const merged = environments.flatMap(({ environmentId, beats }) =>
    beats.map((beat) => ({
      key: `${environmentId}:${beat.id}`,
      threadKey: `${environmentId}:${beat.threadId}`,
      environmentId,
      beat,
    })),
  );
  // Stable: beats of one environment that share a timestamp keep their order.
  return environments.length > 1
    ? merged.toSorted((left, right) => left.beat.at.localeCompare(right.beat.at))
    : merged;
}

export type CastStatus = "needs-you" | "working" | "failed" | "done";

export interface CastMember {
  readonly threadKey: string;
  readonly snapshot: ThreadSnapshot;
  readonly status: CastStatus;
  readonly statusLabel: string;
  /** The agent's own latest words: what it says it is doing, or what it did. */
  readonly speech: InspectorBeat | null;
  /** What it is doing this moment, what it needs from the person, or the request it took on. */
  readonly action: InspectorBeat | null;
  /** Its newest beat of any kind: the card lights up when this changes. */
  readonly latest: InspectorBeat | null;
  readonly lastBeatAt: string | null;
  /** When the work under way started; null unless working. */
  readonly workingSince: string | null;
}

/** One project's threads on stage, so a glance shows where the work is. */
export interface StageSection {
  readonly projectKey: string;
  readonly projectId: string;
  readonly projectName: string;
  readonly members: ReadonlyArray<CastMember>;
  readonly needsYou: number;
  readonly working: number;
}

/** How long a thread that went quiet stays on stage. */
export const CAST_RECENT_MS = 10 * 60_000;
/** Cards on stage at once; the rest are counted, not drawn. */
export const CAST_LIMIT = 12;

const STATUS_RANK: Record<CastStatus, number> = {
  "needs-you": 0,
  working: 1,
  failed: 2,
  done: 3,
};

export function castStatus(snapshot: ThreadSnapshot): {
  readonly status: CastStatus;
  readonly label: string;
} {
  switch (snapshot.waitingOn) {
    case "approval":
      return { status: "needs-you", label: "Needs your approval" };
    case "user-input":
      return { status: "needs-you", label: "Waiting for your answer" };
    case "proposed-plan":
      return { status: "needs-you", label: "Has a plan for you" };
    case "nothing":
      break;
  }
  if (snapshot.isWorking) return { status: "working", label: "Working" };
  if (snapshot.hasError && !snapshot.settled) {
    return { status: "failed", label: "Stopped on an error" };
  }
  return {
    status: "done",
    label: snapshot.latestTurnState === "completed" ? "Finished" : "Stopped",
  };
}

function isRecent(at: string | null, nowMs: number): boolean {
  if (at === null) return false;
  const ms = Date.parse(at);
  return Number.isFinite(ms) && nowMs - ms <= CAST_RECENT_MS;
}

/**
 * A card's two lines from a thread's beats, newest first: its latest words,
 * and the latest thing it did. A thread waiting on the person shows what it
 * asked for instead, even if a tool ran after.
 */
function castLines(
  status: CastStatus,
  newestFirst: ReadonlyArray<InspectorBeat>,
): { readonly speech: InspectorBeat | null; readonly action: InspectorBeat | null } {
  const speech = newestFirst.find((entry) => entry.beat.kind === "said") ?? null;
  const request =
    status === "needs-you"
      ? newestFirst.find((entry) => entry.beat.kind === "attention")
      : undefined;
  const action = request ?? newestFirst.find((entry) => entry.beat.kind !== "said") ?? null;
  return { speech, action };
}

/**
 * Who is on stage: every thread that needs the person or is working, then the
 * ones that went quiet in the last few minutes, so a finish stays in view long
 * enough to read. Grouped by project, the most urgent project first.
 */
export function buildStage(
  world: OrchestratorWorld,
  beats: ReadonlyArray<InspectorBeat>,
  nowMs: number,
  /** When each working thread's turn started, by thread key. */
  workingSince: ReadonlyMap<string, string> = new Map(),
): { readonly sections: ReadonlyArray<StageSection>; readonly offStage: number } {
  const byThread = new Map<string, InspectorBeat[]>();
  for (let index = beats.length - 1; index >= 0; index -= 1) {
    const entry = beats[index]!;
    const list = byThread.get(entry.threadKey);
    if (list === undefined) byThread.set(entry.threadKey, [entry]);
    else list.push(entry);
  }

  const members: CastMember[] = [];
  for (const snapshot of world.values()) {
    // A settled thread is one the person called done; even a plan or error it
    // still holds is not asking for anything.
    if (snapshot.environmentUnreachable || snapshot.settled) continue;
    const { status, label } = castStatus(snapshot);
    const threadBeats = byThread.get(snapshot.threadKey) ?? [];
    const latest = threadBeats[0] ?? null;
    const lastBeatAt = latest?.beat.at ?? null;
    const onStage =
      status === "needs-you" ||
      status === "working" ||
      isRecent(lastBeatAt, nowMs) ||
      (status === "failed" && isRecent(snapshot.errorAt, nowMs));
    if (!onStage) continue;
    members.push({
      threadKey: snapshot.threadKey,
      snapshot,
      status,
      statusLabel: label,
      ...castLines(status, threadBeats),
      latest,
      lastBeatAt,
      workingSince: status === "working" ? (workingSince.get(snapshot.threadKey) ?? null) : null,
    });
  }

  members.sort(
    (left, right) =>
      STATUS_RANK[left.status] - STATUS_RANK[right.status] ||
      (right.lastBeatAt ?? "").localeCompare(left.lastBeatAt ?? "") ||
      left.snapshot.title.localeCompare(right.snapshot.title),
  );

  // Sections take the order of their most urgent thread.
  const sections = new Map<
    string,
    {
      -readonly [Key in keyof StageSection]: Key extends "members"
        ? CastMember[]
        : StageSection[Key];
    }
  >();
  for (const member of members.slice(0, CAST_LIMIT)) {
    const { snapshot } = member;
    const projectKey = `${snapshot.environmentId}:${snapshot.projectId}`;
    let section = sections.get(projectKey);
    if (section === undefined) {
      section = {
        projectKey,
        projectId: snapshot.projectId,
        projectName: snapshot.projectName || snapshot.workspaceName || "Project",
        members: [],
        needsYou: 0,
        working: 0,
      };
      sections.set(projectKey, section);
    }
    section.members.push(member);
    if (member.status === "needs-you") section.needsYou += 1;
    if (member.status === "working") section.working += 1;
  }
  return {
    sections: [...sections.values()],
    offStage: Math.max(0, members.length - CAST_LIMIT),
  };
}

/** "12m", "1h 5m", or "just started": how long the work under way has run. */
export function describeElapsed(since: string | null, nowMs: number): string | null {
  if (since === null) return null;
  const startedMs = Date.parse(since);
  if (!Number.isFinite(startedMs)) return null;
  const minutes = Math.floor(Math.max(0, nowMs - startedMs) / 60_000);
  if (minutes < 1) return "just started";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours}h` : `${hours}h ${rest}m`;
}

/** A project's line above its cards: "1 needs you · 2 working". */
export function describeSection(section: StageSection): string {
  const parts = [
    section.needsYou > 0
      ? `${section.needsYou} ${section.needsYou === 1 ? "needs" : "need"} you`
      : null,
    section.working > 0 ? `${section.working} working` : null,
  ].filter((part): part is string => part !== null);
  return parts.length > 0 ? parts.join(" · ") : "Active in the last few minutes";
}

export interface InspectorCounts {
  readonly working: number;
  /** Projects with a thread working. */
  readonly workingProjects: number;
  readonly needsYou: number;
  readonly quiet: number;
}

export function countWorld(world: OrchestratorWorld): InspectorCounts {
  let working = 0;
  let needsYou = 0;
  let quiet = 0;
  const projects = new Set<string>();
  for (const snapshot of world.values()) {
    if (snapshot.settled) continue;
    if (snapshot.waitingOn !== "nothing") needsYou += 1;
    else if (snapshot.isWorking) {
      working += 1;
      projects.add(`${snapshot.environmentId}:${snapshot.projectId}`);
    } else quiet += 1;
  }
  return { working, workingProjects: projects.size, needsYou, quiet };
}

/** "4 working across 3 projects · 1 needs you · 9 quiet", leaving out what is zero. */
export function describeCounts(counts: InspectorCounts): string {
  const working =
    counts.working === 0
      ? null
      : counts.workingProjects > 1
        ? `${counts.working} working across ${counts.workingProjects} projects`
        : `${counts.working} working`;
  const parts = [
    working,
    counts.needsYou > 0
      ? `${counts.needsYou} ${counts.needsYou === 1 ? "needs" : "need"} you`
      : null,
    counts.quiet > 0 ? `${counts.quiet} quiet` : null,
  ].filter((part): part is string => part !== null);
  return parts.length === 0 ? "No open threads" : parts.join(" · ");
}

export interface BeatPresentation {
  /** The few words before the object: "Ran", "Asked you a question". */
  readonly lead: string | null;
  readonly body: string | null;
  readonly bodyStyle: "code" | "quote" | "plain";
  readonly tone: "default" | "attention" | "error" | "muted";
}

/** How a beat reads: a verb and its object, words in quotes, trouble in colour. */
export function presentBeat(beat: OrchestrationLiveBeat): BeatPresentation {
  switch (beat.kind) {
    case "command":
    case "read":
    case "edit":
    case "search":
      return { lead: beat.title, body: beat.detail, bodyStyle: "code", tone: "default" };
    case "think":
      return { lead: beat.title, body: null, bodyStyle: "plain", tone: "muted" };
    case "said":
      return { lead: null, body: beat.detail, bodyStyle: "quote", tone: "default" };
    case "asked":
      return { lead: beat.title, body: beat.detail, bodyStyle: "quote", tone: "default" };
    case "attention":
      return { lead: beat.title, body: beat.detail, bodyStyle: "plain", tone: "attention" };
    case "error":
      return { lead: beat.title, body: beat.detail, bodyStyle: "plain", tone: "error" };
    case "notice":
      return { lead: beat.title, body: beat.detail, bodyStyle: "plain", tone: "muted" };
    case "tool":
    case "task":
      return { lead: beat.title, body: beat.detail, bodyStyle: "plain", tone: "default" };
  }
}

/** How long the orchestrator's last words stay up as a subtitle once finished. */
export const SUBTITLE_MS = 2 * 60_000;

export interface Subtitle {
  readonly key: string;
  readonly speaker: "you" | "orchestrator";
  readonly text: string;
  readonly live: boolean;
}

/**
 * The conversation with the orchestrator, one line at a time: what the person
 * last sent it, then its reply as it is written, the way subtitles run.
 */
export function subtitleFor(
  beats: ReadonlyArray<InspectorBeat>,
  orchestratorThreadKey: string | null,
  nowMs: number,
): Subtitle | null {
  if (orchestratorThreadKey === null) return null;
  for (let index = beats.length - 1; index >= 0; index -= 1) {
    const entry = beats[index]!;
    if (entry.threadKey !== orchestratorThreadKey) continue;
    const { beat } = entry;
    if (beat.kind !== "said" && beat.kind !== "asked") continue;
    if (beat.detail === null) continue;
    if (!beat.live && !(nowMs - Date.parse(beat.at) <= SUBTITLE_MS)) return null;
    return {
      key: entry.key,
      speaker: beat.kind === "said" ? "orchestrator" : "you",
      text: beat.detail,
      live: beat.live,
    };
  }
  return null;
}

/** Five muted colours that tell projects apart at a glance, the same one every time. */
const PROJECT_DOTS = [
  "bg-sky-500",
  "bg-emerald-500",
  "bg-violet-500",
  "bg-rose-500",
  "bg-amber-500",
] as const;

export function projectDotClass(projectId: string): string {
  let hash = 0;
  for (let index = 0; index < projectId.length; index += 1) {
    hash = (hash * 31 + projectId.charCodeAt(index)) >>> 0;
  }
  return PROJECT_DOTS[hash % PROJECT_DOTS.length]!;
}
