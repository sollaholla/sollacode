import * as NodeAssert from "node:assert/strict";
import { describe, it } from "vite-plus/test";
import type { ProviderInstanceId } from "@t3tools/contracts";

import { isGitInitRequestReady, useGitInitRequestStore } from "./gitInitRequest.ts";

const INSTANCE = "claudeAgent" as ProviderInstanceId;
const OTHER = "codex" as ProviderInstanceId;

const request = {
  prompt: "set up the repo",
  instanceId: INSTANCE,
  model: "claude-opus-5",
};

describe("gitInitRequest", () => {
  it("holds and releases a single request", () => {
    useGitInitRequestStore.getState().setRequest(request);
    NodeAssert.deepEqual(useGitInitRequestStore.getState().request, request);
    useGitInitRequestStore.getState().clearRequest();
    NodeAssert.equal(useGitInitRequestStore.getState().request, null);
  });

  it("waits until the composer reports the requested provider", () => {
    NodeAssert.equal(
      isGitInitRequestReady({
        request,
        activeInstanceId: INSTANCE,
        activeModel: "claude-opus-5",
      }),
      true,
    );
    // Selection not applied yet — sending now would use the old provider.
    NodeAssert.equal(
      isGitInitRequestReady({ request, activeInstanceId: OTHER, activeModel: "claude-opus-5" }),
      false,
    );
    NodeAssert.equal(
      isGitInitRequestReady({ request, activeInstanceId: INSTANCE, activeModel: "gpt-5" }),
      false,
    );
  });

  it("is never ready without a request", () => {
    NodeAssert.equal(
      isGitInitRequestReady({
        request: null,
        activeInstanceId: INSTANCE,
        activeModel: "claude-opus-5",
      }),
      false,
    );
  });
});
