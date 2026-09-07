// @effect-diagnostics nodeBuiltinImport:off - the wiring check reads a source
// file, which is a build-time concern rather than app runtime.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import type { ServerProvider } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  isProviderAuthenticationPauseActive,
  resolveThreadProviderAuthStatus,
} from "./providerAuthPause.ts";

const AUTH_ERROR = "Invalid API key · Please run /login";

const provider = (
  instanceId: string,
  status: "authenticated" | "unauthenticated" | "unknown",
): ServerProvider => ({ instanceId, auth: { status } }) as unknown as ServerProvider;

describe("isProviderAuthenticationPauseActive", () => {
  it("pauses while the provider is still signed out", () => {
    expect(
      isProviderAuthenticationPauseActive({
        sessionStatus: "error",
        sessionLastError: AUTH_ERROR,
        providerAuthStatus: "unauthenticated",
      }),
    ).toBe(true);
  });

  it("retires the pause once the provider reports it is signed in", () => {
    // The session error is never rewritten by signing in, and the pause gates
    // sending - so latching on it alone left the user unable to send with no
    // way out but a new session they could not start.
    expect(
      isProviderAuthenticationPauseActive({
        sessionStatus: "error",
        sessionLastError: AUTH_ERROR,
        providerAuthStatus: "authenticated",
      }),
    ).toBe(false);
  });

  it("keeps the pause when there is no live answer to trust", () => {
    for (const status of ["unknown", null] as const) {
      expect(
        isProviderAuthenticationPauseActive({
          sessionStatus: "error",
          sessionLastError: AUTH_ERROR,
          providerAuthStatus: status,
        }),
      ).toBe(true);
    }
  });

  it("ignores sessions that did not fail on authentication", () => {
    expect(
      isProviderAuthenticationPauseActive({
        sessionStatus: "error",
        sessionLastError: "the model ran out of context",
        providerAuthStatus: "unauthenticated",
      }),
    ).toBe(false);
    expect(
      isProviderAuthenticationPauseActive({
        sessionStatus: "ready",
        sessionLastError: AUTH_ERROR,
        providerAuthStatus: "unauthenticated",
      }),
    ).toBe(false);
  });
});

describe("resolveThreadProviderAuthStatus", () => {
  it("finds the thread's own provider", () => {
    const providers = [
      provider("claudeAgent", "authenticated"),
      provider("codex", "unauthenticated"),
    ];
    expect(resolveThreadProviderAuthStatus({ instanceId: "codex", providers })).toBe(
      "unauthenticated",
    );
  });

  it("answers null rather than guessing when the provider is unknown", () => {
    expect(
      resolveThreadProviderAuthStatus({
        instanceId: "gone",
        providers: [provider("codex", "authenticated")],
      }),
    ).toBeNull();
    expect(resolveThreadProviderAuthStatus({ instanceId: null, providers: [] })).toBeNull();
  });
});

describe("chat view wiring", () => {
  it("derives the pause through the live-auth helper, not the raw classifier", () => {
    // Every failure in this area has been a wiring failure: the predicate was
    // right and the caller read the wrong state. Calling
    // `isProviderAuthenticationFailure` directly here is exactly the latch
    // that left the user unable to send after signing back in.
    const source = NodeFS.readFileSync(
      NodePath.join(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)), "..", "ChatView.tsx"),
      "utf8",
    );
    expect(source).toContain("isProviderAuthenticationPauseActive({");
    expect(source).toContain("resolveThreadProviderAuthStatus({");
    expect(
      source,
      "ChatView classifies the session error itself again, so the pause cannot see a fresh sign-in",
    ).not.toContain("isProviderAuthenticationFailure(");
  });
});
