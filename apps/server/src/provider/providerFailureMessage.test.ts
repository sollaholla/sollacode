import { describe, expect, it } from "vite-plus/test";
import * as Cause from "effect/Cause";

import { ProviderAdapterProcessError, ProviderAdapterRequestError } from "./Errors.ts";
import {
  CLAUDE_CODE_NOT_INSTALLED_MESSAGE,
  GROK_CLI_NOT_INSTALLED_MESSAGE,
  PROVIDER_DISCONNECTED_MESSAGE,
  formatProviderFailureDetail,
  sanitizeProviderFailureText,
} from "./providerFailureMessage.ts";

describe("formatProviderFailureDetail", () => {
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
