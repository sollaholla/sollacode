import {
  PreviewTabId,
  ThreadId,
  type PreviewRemoteFrameKeyframe,
  type PreviewRemoteFramePatchSet,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import {
  appendPixels,
  budgetWaitMs,
  catchUp,
  emptyChain,
  fullBudget,
  initialCursor,
  mergePatchSets,
  spendBudget,
  tabDemand,
} from "./remoteFrameChannel.ts";

const keyframe: PreviewRemoteFrameKeyframe = {
  type: "keyframe",
  sequence: 0,
  width: 64,
  height: 64,
  mimeType: "image/jpeg",
  data: "a".repeat(1000),
};
const patch = (sequence: number): PreviewRemoteFramePatchSet => ({
  type: "patch",
  sequence,
  after: sequence - 1,
  width: 64,
  height: 64,
  mimeType: "image/jpeg",
  patches: [{ x: 0, y: 0, width: 8, height: 8, data: `p${sequence}` }],
});
const view = (chain: ReturnType<typeof appendPixels>["chain"]) => ({
  chain,
  state: null,
  stateVersion: 0,
  unavailable: null,
});

describe("remote frame channel", () => {
  it("rejects missing bases and out-of-order patches", () => {
    expect(appendPixels(emptyChain, patch(1))).toEqual({
      chain: emptyChain,
      accepted: false,
      needsKeyframe: true,
    });
    const chain = appendPixels(emptyChain, keyframe).chain;
    expect(appendPixels(chain, patch(2))).toEqual({ chain, accepted: false, needsKeyframe: true });
  });
  it("hard bounds retained patch count even when the host ignores a keyframe request", () => {
    let chain = appendPixels(emptyChain, keyframe).chain;
    for (let sequence = 1; sequence <= 1000; sequence++)
      chain = appendPixels(chain, patch(sequence)).chain;
    expect(chain.patches).toHaveLength(120);
    expect(appendPixels(chain, patch(121)).needsKeyframe).toBe(true);
  });
  it("hard bounds retained patch bytes", () => {
    const chain = appendPixels(emptyChain, keyframe).chain;
    const large = { ...patch(1), patches: [{ ...patch(1).patches[0]!, data: "x".repeat(2001) }] };
    expect(appendPixels(chain, large)).toEqual({ chain, accepted: false, needsKeyframe: true });
  });
  it("coalesces covered patches while preserving the sequence chain", () => {
    const merged = mergePatchSets([patch(1), patch(2), patch(3)]);
    expect(merged).toEqual([{ ...patch(3), after: 0 }]);
  });
  it("sends only the latest patch when a viewer falls behind", () => {
    let chain = appendPixels(emptyChain, keyframe).chain;
    const first = catchUp(view(chain), initialCursor, true);
    for (let sequence = 1; sequence <= 5; sequence++)
      chain = appendPixels(chain, patch(sequence)).chain;
    expect(catchUp(view(chain), first.cursor, true).events).toEqual([{ ...patch(5), after: 0 }]);
  });
  it("delivers a restarted publisher's keyframe even when its sequence repeats", () => {
    const first = catchUp(view(appendPixels(emptyChain, keyframe).chain), initialCursor, true);
    const restarted = { ...keyframe, data: "replacement" };
    expect(
      catchUp(view(appendPixels(emptyChain, restarted).chain), first.cursor, true).events,
    ).toEqual([restarted]);
  });
  it("keeps native viewers on keyframes and asks for the largest active size", () => {
    const target = { threadId: ThreadId.make("thread"), tabId: PreviewTabId.make("tab") };
    expect(
      tabDemand(
        target,
        [
          { maxWidth: 640, maxHeight: 480, patches: false },
          { maxWidth: 1920, maxHeight: 1080, patches: true },
        ],
        2,
      ),
    ).toEqual({ ...target, maxWidth: 1920, maxHeight: 1080, patches: false, keyframeRequest: 2 });
    expect(tabDemand(target, [], 0)).toBeNull();
    let chain = appendPixels(emptyChain, keyframe).chain;
    chain = appendPixels(chain, patch(1)).chain;
    expect(catchUp(view(chain), initialCursor, false).events).toEqual([keyframe]);
  });
  it("permits an isolated burst then charges the debt before the next picture", () => {
    const budget = { bytesPerSecond: 100, burstBytes: 200 };
    const state = spendBudget(budget, fullBudget(budget, 0), 300, 0);
    expect(budgetWaitMs(budget, state, 0)).toBe(1001);
    expect(budgetWaitMs(budget, state, 1001)).toBe(0);
  });
});
