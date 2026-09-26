import { describe, expect, it } from "vite-plus/test";
import * as Cause from "effect/Cause";

import { ProviderAdapterProcessError, ProviderAdapterRequestError } from "./Errors.ts";
import {
  CLAUDE_CODE_NOT_INSTALLED_MESSAGE,
  GROK_CLI_NOT_INSTALLED_MESSAGE,
  PROVIDER_DISCONNECTED_MESSAGE,
  formatProviderFailureDetail,
  sanitizeProviderFailureText,
  formatAutomaticResumptionPausedMessage,
  humanizeProviderFailureDetail,
} from "./providerFailureMessage.ts";

describe("formatProviderFailureDetail", () => {
  it("formats a shutdown timeout with no Error message", () => {
    expect(formatProviderFailureDetail(Cause.fail(new Cause.TimeoutError()))).toBe(
      "The provider operation timed out.",
    );
  });

  it("maps a missing Claude native binary to a short install instruction", () => {
    const error = new ProviderAdapterProcessError({
      provider: "claudeAgent",
      threadId: "ce00c987-98c3-4f49-b80a-01e2d4de10e5",
      detail: "Failed to start Claude runtime session.",
      cause: new ReferenceError(
        "Claude Code native binary not found at C:\\Users\\Developer\\AppData\\Roaming\\npm\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe. Please ensure Claude Code is installed via native installer or specify a valid path with options.pathToClaudeCodeExecutable.",
      ),
    });
    expect(formatProviderFailureDetail(Cause.fail(error))).toBe(CLAUDE_CODE_NOT_INSTALLED_MESSAGE);
  });

  it("maps a missing Grok spawn to a short install instruction", () => {
    const error = new ProviderAdapterProcessError({
      provider: "grok",
      threadId: "thread-1",
      detail: "spawn grok ENOENT",
      cause: Object.assign(new Error("spawn grok ENOENT"), { code: "ENOENT" }),
    });
    expect(formatProviderFailureDetail(Cause.fail(error))).toBe(GROK_CLI_NOT_INSTALLED_MESSAGE);
  });

  it("maps a dropped pipe to a reconnect instruction", () => {
    const error = new ProviderAdapterRequestError({
      provider: "grok",
      method: "session/prompt",
      detail: "write EPIPE",
    });
    expect(formatProviderFailureDetail(Cause.fail(error))).toBe(PROVIDER_DISCONNECTED_MESSAGE);
  });

  it("keeps a request detail without dumping the Effect stack", () => {
    const error = new ProviderAdapterRequestError({
      provider: "codex",
      method: "thread.start",
      detail: "deterministic startup failure",
    });
    expect(formatProviderFailureDetail(Cause.fail(error))).toBe("deterministic startup failure");
  });

  it("strips stack frames from a pretty-printed process error", () => {
    expect(
      sanitizeProviderFailureText(
        [
          "ProviderAdapterProcessError: Provider adapter process error (claudeAgent) for thread abc: Failed to start Claude runtime session.",
          "    at catch (file:///C:/Users/Developer/AppData/Local/Programs/solla-code/resources/app.asar/apps/server/dist/bin.mjs:58420:22)",
          "    at failWithCatch (file:///C:/Users/Developer/AppData/Local/Programs/solla-code/resources/app.asar/node_modules/effect/dist/internal/effect.js:745:21)",
          "  [cause]: ReferenceError: Claude Code native binary not found at C:\\Users\\dev\\claude.exe.",
        ].join("\n"),
      ),
    ).toBe(CLAUDE_CODE_NOT_INSTALLED_MESSAGE);
  });
});

describe("sanitizeProviderFailureText", () => {
  // 2026-09-18: this reached the thread banner in front of an otherwise
  // readable sentence, because ingestion wrote the provider's message raw.
  it("drops the adapter request wrapper", () => {
    expect(
      sanitizeProviderFailureText(
        "Provider adapter request failed (grok) for session/prompt: Grok Build's usage balance is exhausted, so xAI declined this turn.",
      ),
    ).toBe("Grok Build's usage balance is exhausted, so xAI declined this turn.");
  });
});

describe("paused auto-resume banner", () => {
  // Reported 2026-09-18: the banner read "Gave up after 8 failed attempts:
  // model stream idle timeout after 180000ms Use Resume to try again" —
  // retry accounting first, provider jargon second, no full stop between the
  // cause and the instruction.
  it("leads with the cause and keeps the retry count as an aside", () => {
    expect(
      formatAutomaticResumptionPausedMessage(
        "Gave up after 8 failed attempts: model stream idle timeout after 180000ms",
      ),
    ).toBe(
      "The model stopped sending output for 3 minutes. Solla retried 8 times, then paused. Use Resume to try again, or switch provider.",
    );
  });

  // The same banner carried eleven frames of bundler stack for OpenCode.
  it("drops a provider stack trace and names the missing model", () => {
    const message = formatAutomaticResumptionPausedMessage(
      [
        "Gave up after 8 failed attempts: ProviderModelNotFoundError: Model not found: opencode/union-alpha.",
        "    at <anonymous> (/$bunfs/root/chunk-1x5k94j8.js:439:94278)",
        "    at SessionPrompt.getModel (/$bunfs/root/chunk-ew1rm7q3.js:1142:11505)",
      ].join("\n"),
    );

    expect(message).toBe(
      "The provider no longer offers the model opencode/union-alpha. Solla retried 8 times, then paused. Use Resume to try again, or switch provider.",
    );
    expect(message).not.toContain("bunfs");
    expect(message).not.toContain("ProviderModelNotFoundError");
  });

  it("still reads as a sentence when the reason is unrecognised", () => {
    expect(
      formatAutomaticResumptionPausedMessage("Gave up after 1 failed attempt: weird thing"),
    ).toBe(
      "Weird thing. Solla retried 1 time, then paused. Use Resume to try again, or switch provider.",
    );
    expect(formatAutomaticResumptionPausedMessage("something else entirely")).toBe(
      "Something else entirely. Use Resume to try again, or switch provider.",
    );
  });

  it("clamps a runaway provider sentence instead of pasting a wall of text", () => {
    const long = `Gave up after 2 failed attempts: ${"word ".repeat(120)}`;
    const message = formatAutomaticResumptionPausedMessage(long);

    expect(message.length).toBeLessThan(300);
    expect(message).toContain("…");
    expect(message).toContain("Use Resume to try again");
  });

  it("converts a sub-minute timeout into seconds", () => {
    expect(humanizeProviderFailureDetail("model stream idle timeout after 45000ms")).toBe(
      "The model stopped sending output for 45 seconds.",
    );
  });
});
