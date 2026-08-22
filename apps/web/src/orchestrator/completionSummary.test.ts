import { describe, expect, it } from "vite-plus/test";

import { buildCompletionAnnouncement, extractArtifacts, tailOf } from "./completionSummary";
import type { OrchestratorEvent } from "./events";

const event = (overrides: Partial<OrchestratorEvent> = {}): OrchestratorEvent => ({
  kind: "thread-finished",
  threadKey: "env-1:thread-a",
  threadId: "thread-a",
  environmentId: "env-1",
  title: "Rover",
  projectName: "Rover Project",
  outcome: "completed",
  ...overrides,
});

describe("extractArtifacts", () => {
  it("picks out the outputs an agent actually named", () => {
    const artifacts = extractArtifacts(
      "Opened https://github.com/acme/repo/pull/42 and edited apps/web/src/main.tsx plus `config.yaml`.",
    );
    expect(artifacts).toContain("https://github.com/acme/repo/pull/42");
    expect(artifacts).toContain("apps/web/src/main.tsx");
    expect(artifacts).toContain("config.yaml");
  });

  it("recognises PR and branch shorthand", () => {
    const artifacts = extractArtifacts("Pushed to branch `fix/login-retry` and opened PR #17.");
    expect(artifacts).toContain("fix/login-retry");
    expect(artifacts.some((entry) => entry.includes("17"))).toBe(true);
  });

  it("strips trailing punctuation from a URL", () => {
    expect(extractArtifacts("See https://example.com/build.")).toEqual([
      "https://example.com/build",
    ]);
  });

  it("invents nothing when the message names no outputs", () => {
    expect(extractArtifacts("All done, everything looks good.")).toEqual([]);
  });

  it("does not run away on a huge message", () => {
    const many = Array.from({ length: 40 }, (_, index) => `src/file${index}.ts`).join(" ");
    expect(extractArtifacts(many).length).toBeLessThanOrEqual(6);
  });
});

describe("tailOf", () => {
  it("keeps the end of a long message, where the summary lives", () => {
    const text = `${"x".repeat(5_000)} FINAL SUMMARY`;
    const tail = tailOf(text);
    expect(tail).toContain("FINAL SUMMARY");
    expect(tail.length).toBeLessThan(1_400);
  });

  it("leaves a short message alone", () => {
    expect(tailOf("  done  ")).toBe("done");
  });
});

describe("buildCompletionAnnouncement", () => {
  it("asks for what it did, the outputs, and a next step", () => {
    const instruction = buildCompletionAnnouncement({
      event: event(),
      lastMessage: "Fixed the retry loop in src/auth/retry.ts and pushed it.",
    });
    expect(instruction).toContain("src/auth/retry.ts");
    expect(instruction).toContain("what it actually did");
    expect(instruction).toContain("next step");
  });

  it("reports the exact error a failed thread recorded", () => {
    // "it ended with an error" is the one thing the user already knows.
    const instruction = buildCompletionAnnouncement({
      event: event({ kind: "thread-failed", outcome: "failed" }),
      error: "429 rate_limit_exceeded: usage limit reached for claude-opus-5",
      failureKind: "usage-limit",
    });

    expect(instruction).toContain("429 rate_limit_exceeded");
    expect(instruction).toContain("usage limit reached for claude-opus-5");
    expect(instruction).toContain("usage-limit");
    expect(instruction).toContain("the actual reason it failed");
  });

  it("says no error was recorded rather than inventing one", () => {
    const instruction = buildCompletionAnnouncement({
      event: event({ kind: "thread-failed", outcome: "failed" }),
    });
    expect(instruction).toContain("no error message was recorded");
    expect(instruction).not.toContain("The error it reported");
  });

  it("truncates a stack-trace-sized error instead of reading it out", () => {
    const instruction = buildCompletionAnnouncement({
      event: event({ kind: "thread-failed", outcome: "failed" }),
      error: `${"at someFrame (file.ts:1:1)\n".repeat(400)}ECONNREFUSED`,
    });
    // The tail is kept: the useful part of a trace is the end of it.
    expect(instruction).toContain("ECONNREFUSED");
    expect(instruction.length).toBeLessThan(4_000);
  });

  it("does not call an interrupted turn a success", () => {
    // "finished" used to cover this case, so half-done work read as done.
    const instruction = buildCompletionAnnouncement({ event: event({ outcome: "partial" }) });
    expect(instruction).toContain("stopped before finishing");
    expect(instruction).toContain("not complete");
  });

  it("says an errored turn ended in an error", () => {
    const instruction = buildCompletionAnnouncement({
      event: event({ kind: "thread-failed", outcome: "failed" }),
    });
    expect(instruction).toContain("ended with an error");
  });

  it("reports being blocked rather than done", () => {
    const instruction = buildCompletionAnnouncement({
      event: event(),
      waitingOn: "approval",
    });
    expect(instruction).toContain("waiting for you to approve");
  });

  it("goes and reads the thread rather than asking the user to look", () => {
    // The result is retrievable, so "I could not read it" is a non-answer and
    // "open the thread and check" asks the user to do the tools' job.
    const instruction = buildCompletionAnnouncement({ event: event() });
    expect(instruction).toContain("call read_thread");
    expect(instruction).toContain("Never tell the user to open the thread");
  });

  it("names the project so same-named threads are distinguishable", () => {
    const instruction = buildCompletionAnnouncement({
      event: event({ title: "API", projectName: "Vera Medical" }),
    });
    expect(instruction).toContain("Vera Medical");
  });
});
