// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { describe, expect, it } from "vite-plus/test";

/**
 * Structural guards for the voice session's lifecycle seams.
 *
 * The hook's glue cannot run under the node test environment, and every bug
 * pinned here lived precisely in that glue: bookkeeping committed while the
 * delivery it described was still in flight, and intent flags that outlived
 * the surfaces that owned them. Each check names one line that must not
 * quietly disappear in a refactor; the behaviour behind it is documented at
 * the line itself.
 */
const read = (name: string) =>
  NodeFS.readFileSync(NodePath.join(import.meta.dirname, name), "utf8");

describe("voice session lifecycle", () => {
  const hook = () => read("useOrchestratorSession.ts");
  const session = () => read("realtimeSession.ts");

  it("lets disabling voice cancel a reconnect that is mid-backoff", () => {
    const source = hook();
    // The timer must be reachable (a stored handle), gated on the enabled
    // flag when it fires, and covered by the disable effect via the intent
    // flag — during the backoff there is no session for that effect to see.
    expect(source).toContain("reconnectTimerRef.current = setTimeout(");
    expect(source).toContain("if (!sessionWantedRef.current || !orchestratorEnabledRef.current)");
    expect(source).toMatch(
      /!orchestrator\.enabled &&\s*\(sessionRef\.current !== null \|\| sessionWantedRef\.current\)/,
    );
  });

  it("kills reconnect intent when the hook unmounts", () => {
    // A timer surviving unmount opens a microphone no UI can stop.
    const cleanup = hook().split("// Intent dies with the owner")[1] ?? "";
    expect(cleanup).toContain("sessionWantedRef.current = false");
    expect(cleanup).toContain("clearTimeout(reconnectTimerRef.current)");
  });

  it("clears the working latch when the session goes away", () => {
    // Stopping mid tool call latched "working" forever: the orb said the
    // assistant held the floor while nothing was running, and the next
    // session inherited the lie through the bubble override.
    expect(hook()).toMatch(/bubbleWorkingRef\.current = false;\s*\n\s*setWorking\(false\)/);
    expect(session()).toMatch(
      /if \(lastWorkingReported\) \{\s*\n\s*lastWorkingReported = false;\s*\n\s*callbacks\.onWorkingChange\?\.\(false\);/,
    );
  });

  it("treats a refused announcement as undelivered, not as done", () => {
    const source = hook();
    // announce() reports acceptance; a completion it refuses is queued for
    // the next session instead of being marked delivered into silence.
    expect(source).toContain("sessionRef.current === session && session.announce(text)");
    expect(source).toContain("if (!delivered) pendingWakeLinesRef.current.push(text)");
  });

  it("keeps the report-back promise across approval and input pauses", () => {
    // forgetAwaitedWork on approval-needed meant a thread that paused for an
    // answer could never wake the session when it actually finished.
    const source = hook();
    const forgets = source.match(/forgetAwaitedWork\(/g) ?? [];
    expect(forgets.length).toBe(1);
  });

  it("delivers a wake line into a session the user already started", () => {
    // Queued behind an already-listening session, the line waited for a
    // transition that never comes and replayed out of context later.
    expect(hook()).toContain("if (live !== null && live.announce(line)) return;");
  });

  it("does not turn bookkeeping turns into spoken user requests", () => {
    const source = hook();
    expect(source).toContain("if (input.awaited !== false)");
    expect(source).toContain("request: input.requestLabel ?? input.message");
    // The settings marker is bookkeeping; the plan approval keeps its promise
    // but under a label a person could have said.
    expect(source).toContain("awaited: false");
    expect(read("tools.ts")).toContain('requestLabel: "implement the approved plan"');
  });
});
