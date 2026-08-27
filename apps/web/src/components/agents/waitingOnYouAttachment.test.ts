import type { VmAgentBlockerId, VmAgentId } from "@t3tools/contracts";
import { beforeEach, describe, expect, it } from "vite-plus/test";

import {
  attachWaitingOnYou,
  detachWaitingOnYou,
  getWaitingOnYouAttachment,
  pruneWaitingOnYouAttachment,
} from "./waitingOnYouAttachment";

const threadKey = "env-1:thread-1";
const other = "env-1:thread-2";
const request = {
  vmAgentId: "agent-1" as VmAgentId,
  blockerId: "blocker-1" as VmAgentBlockerId,
  title: "Sign in to Drive",
};

beforeEach(() => {
  detachWaitingOnYou(threadKey);
  detachWaitingOnYou(other);
});

describe("waitingOnYouAttachment", () => {
  it("tags one conversation without tagging another", () => {
    attachWaitingOnYou(threadKey, request);

    expect(getWaitingOnYouAttachment(threadKey)).toEqual(request);
    expect(getWaitingOnYouAttachment(other)).toBeNull();
  });

  it("replaces a tag rather than stacking a second one", () => {
    attachWaitingOnYou(threadKey, request);
    attachWaitingOnYou(threadKey, {
      ...request,
      blockerId: "blocker-2" as VmAgentBlockerId,
      title: "Approve spend",
    });

    expect(getWaitingOnYouAttachment(threadKey)?.blockerId).toBe("blocker-2");
  });

  it("detaches without complaining when nothing is tagged", () => {
    expect(() => detachWaitingOnYou(threadKey)).not.toThrow();
    expect(getWaitingOnYouAttachment(threadKey)).toBeNull();
  });

  it("drops a tag whose request closed somewhere else", () => {
    // The card can be resolved from another window or by the agent itself. A
    // tag promising to close a request that is already gone is a lie.
    attachWaitingOnYou(threadKey, request);
    pruneWaitingOnYouAttachment(threadKey, new Set(["blocker-9"]));

    expect(getWaitingOnYouAttachment(threadKey)).toBeNull();
  });

  it("keeps a tag whose request is still open", () => {
    attachWaitingOnYou(threadKey, request);
    pruneWaitingOnYouAttachment(threadKey, new Set(["blocker-1"]));

    expect(getWaitingOnYouAttachment(threadKey)).toEqual(request);
  });
});
