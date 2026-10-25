import type {
  PreviewRemoteFrameDemand,
  PreviewRemoteFrameEvent,
  PreviewRemoteFrameKeyframe,
  PreviewRemoteFramePageState,
  PreviewRemoteFramePatch,
  PreviewRemoteFramePatchSet,
  PreviewRemoteFrameWatchInput,
} from "@t3tools/contracts";
import { PREVIEW_REMOTE_FRAME_MAX_PATCHES } from "@t3tools/contracts";

/**
 * The pixels a tab's viewers need: the latest keyframe and every patch since,
 * in order. A viewer that falls behind is caught up from this in one step, so
 * it never replays stale intermediate pictures (the newest picture wins).
 */
export interface PixelChain {
  readonly keyframe: PreviewRemoteFrameKeyframe | null;
  readonly patches: ReadonlyArray<PreviewRemoteFramePatchSet>;
  /** Base64 bytes held in `patches`. */
  readonly patchBytes: number;
}

export const emptyChain: PixelChain = { keyframe: null, patches: [], patchBytes: 0 };

/**
 * Past this the chain asks the desktop for a fresh keyframe, so a viewer that
 * joins late downloads at most about two pictures' worth.
 */
const MAX_CHAIN_PATCHES = 120;

const patchSetBytes = (set: PreviewRemoteFramePatchSet) =>
  set.patches.reduce((total, patch) => total + patch.data.length, 0);

/** The sequence of the newest picture in the chain, or null when there is none. */
export const chainHead = (chain: PixelChain): number | null =>
  chain.patches.at(-1)?.sequence ?? chain.keyframe?.sequence ?? null;

/**
 * Adds a published picture. A patch must follow the chain's newest picture;
 * one that does not (a lost publish, a desktop that restarted its capture)
 * cannot be drawn by anyone and is refused, and the server asks for a
 * keyframe instead.
 */
export function appendPixels(
  chain: PixelChain,
  event: PreviewRemoteFrameKeyframe | PreviewRemoteFramePatchSet,
): { readonly chain: PixelChain; readonly accepted: boolean; readonly needsKeyframe: boolean } {
  if (event.type === "keyframe") {
    return {
      chain: { keyframe: event, patches: [], patchBytes: 0 },
      accepted: true,
      needsKeyframe: false,
    };
  }
  if (chain.keyframe === null || chainHead(chain) !== event.after) {
    return { chain, accepted: false, needsKeyframe: true };
  }
  if (
    chain.patches.length >= MAX_CHAIN_PATCHES ||
    chain.patchBytes >= Math.max(1024, chain.keyframe.data.length * 2)
  ) {
    return { chain, accepted: false, needsKeyframe: true };
  }
  const patchBytes = chain.patchBytes + patchSetBytes(event);
  if (patchBytes > Math.max(1024, chain.keyframe.data.length * 2)) {
    return { chain, accepted: false, needsKeyframe: true };
  }
  const next: PixelChain = { ...chain, patches: [...chain.patches, event], patchBytes };
  return {
    chain: next,
    accepted: true,
    needsKeyframe:
      next.patches.length > MAX_CHAIN_PATCHES || patchBytes > chain.keyframe.data.length * 2,
  };
}

const contains = (outer: PreviewRemoteFramePatch, inner: PreviewRemoteFramePatch) =>
  outer.x <= inner.x &&
  outer.y <= inner.y &&
  outer.x + outer.width >= inner.x + inner.width &&
  outer.y + outer.height >= inner.y + inner.height;

/**
 * Folds consecutive patch sets into as few as the contract allows (usually
 * one). Rectangles a later rectangle fully covers are dropped: a spinner that
 * turned twenty times while the viewer was busy costs one rectangle, not
 * twenty. Sequences stay the desktop's own, so every event still names the
 * picture it is drawn over.
 */
export function mergePatchSets(
  sets: ReadonlyArray<PreviewRemoteFramePatchSet>,
): ReadonlyArray<PreviewRemoteFramePatchSet> {
  if (sets.length <= 1) return sets;
  const ordered = sets.flatMap((set, setIndex) =>
    set.patches.map((patch) => ({ patch, setIndex })),
  );
  const kept: Array<{ readonly patch: PreviewRemoteFramePatch; readonly setIndex: number }> = [];
  // Newest first, so a rectangle is kept only if nothing drawn after it hides it.
  for (let index = ordered.length - 1; index >= 0; index--) {
    const entry = ordered[index]!;
    if (!kept.some((later) => contains(later.patch, entry.patch))) kept.push(entry);
  }
  kept.reverse();
  const merged: Array<PreviewRemoteFramePatchSet> = [];
  let groupStart = 0;
  let group: Array<PreviewRemoteFramePatch> = [];
  const flush = (lastSetIndex: number) => {
    const first = sets[groupStart]!;
    const last = sets[lastSetIndex]!;
    merged.push({
      type: "patch",
      sequence: last.sequence,
      after: first.after,
      width: last.width,
      height: last.height,
      mimeType: last.mimeType,
      patches: group,
    });
    groupStart = lastSetIndex + 1;
    group = [];
  };
  let cursor = 0;
  for (let setIndex = 0; setIndex < sets.length; setIndex++) {
    const own: Array<PreviewRemoteFramePatch> = [];
    while (cursor < kept.length && kept[cursor]!.setIndex === setIndex) {
      own.push(kept[cursor]!.patch);
      cursor++;
    }
    if (group.length > 0 && group.length + own.length > PREVIEW_REMOTE_FRAME_MAX_PATCHES) {
      flush(setIndex - 1);
    }
    group.push(...own);
  }
  flush(sets.length - 1);
  return merged;
}

/** What one viewer has been sent so far. */
export interface ViewerCursor {
  /** The keyframe the viewer's picture is built on, and the newest picture it holds. */
  readonly keyframe: PreviewRemoteFrameKeyframe | null;
  readonly sequence: number | null;
  readonly stateVersion: number;
  readonly unavailableVersion: number;
}

export const initialCursor: ViewerCursor = {
  keyframe: null,
  sequence: null,
  stateVersion: 0,
  unavailableVersion: 0,
};

/** The parts of a channel a viewer is caught up from. */
export interface ChannelView {
  readonly chain: PixelChain;
  readonly state: PreviewRemoteFramePageState | null;
  readonly stateVersion: number;
  readonly unavailable: { readonly reason: string; readonly version: number } | null;
}

/**
 * Everything a viewer is missing, as few events as possible: state first (so
 * a picture never arrives under a stale title), then either the keyframe plus
 * the merged patches since it, or just the merged patches since the viewer's
 * newest picture. A viewer that cannot draw patches gets the keyframe only;
 * the desktop sends keyframes while such a viewer watches.
 */
export function catchUp(
  view: ChannelView,
  cursor: ViewerCursor,
  drawsPatches: boolean,
): { readonly events: ReadonlyArray<PreviewRemoteFrameEvent>; readonly cursor: ViewerCursor } {
  const events: Array<PreviewRemoteFrameEvent> = [];
  let next = cursor;
  if (view.state !== null && view.stateVersion !== cursor.stateVersion) {
    events.push({ type: "state", state: view.state });
    next = { ...next, stateVersion: view.stateVersion };
  }
  const { keyframe, patches } = view.chain;
  if (keyframe === null) {
    if (view.unavailable !== null && view.unavailable.version !== cursor.unavailableVersion) {
      events.push({ type: "unavailable", reason: view.unavailable.reason });
      next = { ...next, unavailableVersion: view.unavailable.version };
    }
    return { events, cursor: next };
  }
  const head = chainHead(view.chain)!;
  if (cursor.keyframe !== keyframe) {
    events.push(keyframe);
    const merged = drawsPatches ? mergePatchSets(patches) : [];
    events.push(...merged);
    next = {
      ...next,
      keyframe,
      sequence: merged.length === 0 ? keyframe.sequence : head,
    };
  } else if (drawsPatches && cursor.sequence !== head) {
    const from = patches.findIndex((set) => set.after === cursor.sequence);
    // A viewer whose picture is not in this chain starts it over.
    if (from === -1) events.push(keyframe, ...mergePatchSets(patches));
    else events.push(...mergePatchSets(patches.slice(from)));
    next = { ...next, keyframe, sequence: head };
  }
  return { events, cursor: next };
}

/** Base64 bytes of pictures in a batch, the part worth budgeting. */
export const pictureBytes = (events: ReadonlyArray<PreviewRemoteFrameEvent>) =>
  events.reduce(
    (total, event) =>
      total +
      (event.type === "keyframe"
        ? event.data.length
        : event.type === "patch"
          ? patchSetBytes(event)
          : 0),
    0,
  );

/**
 * Bytes per second a viewer may be sent on average, with a burst allowance
 * so a single change (a click, a page load) always goes out at once. Under
 * continuous motion the viewer gets fewer, newer pictures instead of a queue.
 */
export interface ViewerBudget {
  readonly bytesPerSecond: number;
  readonly burstBytes: number;
}

export interface BudgetState {
  readonly tokens: number;
  readonly updatedAt: number;
}

export const fullBudget = (budget: ViewerBudget, now: number): BudgetState => ({
  tokens: budget.burstBytes,
  updatedAt: now,
});

const refill = (budget: ViewerBudget, state: BudgetState, now: number): number =>
  Math.min(
    budget.burstBytes,
    state.tokens + ((now - state.updatedAt) / 1000) * budget.bytesPerSecond,
  );

/** Milliseconds until the viewer may be sent another picture; 0 means now. */
export function budgetWaitMs(budget: ViewerBudget, state: BudgetState, now: number): number {
  const tokens = refill(budget, state, now);
  return tokens > 0 ? 0 : Math.ceil((-tokens / budget.bytesPerSecond) * 1000) + 1;
}

/** Charges a batch. A batch may overdraw; the debt is paid before the next one. */
export function spendBudget(
  budget: ViewerBudget,
  state: BudgetState,
  bytes: number,
  now: number,
): BudgetState {
  return { tokens: refill(budget, state, now) - bytes, updatedAt: now };
}

/** One viewer's request, as the channel keeps it. */
export interface ViewerRequest {
  readonly maxWidth: number;
  readonly maxHeight: number;
  readonly patches: boolean;
}

export const viewerRequest = (input: PreviewRemoteFrameWatchInput): ViewerRequest => ({
  maxWidth: input.maxWidth,
  maxHeight: input.maxHeight,
  patches: input.patches === true,
});

/**
 * What the desktop is asked to send for one tab: big enough for its largest
 * viewer, and keyframes only while any viewer cannot draw patches.
 */
export function tabDemand(
  target: Pick<PreviewRemoteFrameDemand, "threadId" | "tabId">,
  viewers: Iterable<ViewerRequest>,
  keyframeRequest: number,
): PreviewRemoteFrameDemand | null {
  let maxWidth = 0;
  let maxHeight = 0;
  let patches = true;
  let any = false;
  for (const viewer of viewers) {
    any = true;
    maxWidth = Math.max(maxWidth, viewer.maxWidth);
    maxHeight = Math.max(maxHeight, viewer.maxHeight);
    patches &&= viewer.patches;
  }
  if (!any) return null;
  return { ...target, maxWidth, maxHeight, patches, keyframeRequest };
}

export const sameDemand = (
  left: ReadonlyArray<PreviewRemoteFrameDemand>,
  right: ReadonlyArray<PreviewRemoteFrameDemand>,
) =>
  left.length === right.length &&
  left.every((demand, index) => {
    const other = right[index];
    return (
      other !== undefined &&
      demand.threadId === other.threadId &&
      demand.tabId === other.tabId &&
      demand.maxWidth === other.maxWidth &&
      demand.maxHeight === other.maxHeight &&
      demand.patches === other.patches &&
      demand.keyframeRequest === other.keyframeRequest
    );
  });
