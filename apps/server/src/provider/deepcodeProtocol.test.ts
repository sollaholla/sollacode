// @effect-diagnostics nodeBuiltinImport:off
import * as NodePath from "node:path";
import { describe, expect, it } from "vite-plus/test";
import {
  buildDeepCodeExecArgs,
  DEEPCODE_STDIN_PROMPT,
  buildDeepCodeTurnEnvironment,
  deepCodeProjectCode,
  deepCodeSessionMessagesPath,
  isDeepCodeEffort,
  isDeepCodeSessionId,
  newDeepCodeSessionMessages,
  parseDeepCodeSessionMessages,
  parseDeepCodeSessionsIndex,
  parseDeepCodeSettingsAuth,
  pickDeepCodeSessionId,
  sessionIdFromCursor,
} from "./deepcodeProtocol.ts";

const SESSION_A = "123e4567-e89b-12d3-a456-426614174000";
const SESSION_B = "123e4567-e89b-12d3-a456-426614174001";

describe("deepcodeProtocol", () => {
  it("keeps short project roots as slash-to-dash codes of the resolved path", () => {
    const root = "/tmp/demo";
    const expected = NodePath.resolve(root).replace(/[\\/]/g, "-").replace(/:/g, "");
    expect(deepCodeProjectCode(root)).toBe(expected);
  });

  it("hashes project roots whose legacy code would exceed 64 characters", () => {
    const root = `/Users/example/Documents/${"very-long-project-name".repeat(4)}`;
    const code = deepCodeProjectCode(root, "darwin");
    expect(code.length).toBeLessThanOrEqual(64);
    expect(code).toMatch(/-[0-9a-f]{16}$/);
    expect(code.startsWith("very-long-project-name") || code.startsWith("project-")).toBe(true);
  });

  it("accepts Deep Code session UUIDs and effort levels", () => {
    expect(isDeepCodeSessionId(SESSION_A)).toBe(true);
    expect(isDeepCodeSessionId("not-a-uuid")).toBe(false);
    expect(isDeepCodeEffort("max")).toBe(true);
    expect(isDeepCodeEffort("medium")).toBe(false);
  });

  it("parses the sessions index and ignores malformed rows", () => {
    expect(
      parseDeepCodeSessionsIndex(
        JSON.stringify({
          entries: [
            { id: SESSION_A, updateTime: "2026-09-10T00:00:00.000Z" },
            { id: "nope", updateTime: "2026-09-10T00:00:01.000Z" },
            { id: SESSION_B },
          ],
        }),
      ),
    ).toEqual([{ id: SESSION_A, updateTime: "2026-09-10T00:00:00.000Z" }]);
    expect(parseDeepCodeSessionsIndex("not-json")).toEqual([]);
  });

  it("keeps an existing resume id when it is still in the index", () => {
    expect(
      pickDeepCodeSessionId({
        previous: [],
        next: [
          { id: SESSION_A, updateTime: "2026-09-10T00:00:00.000Z" },
          { id: SESSION_B, updateTime: "2026-09-10T00:00:02.000Z" },
        ],
        resumeSessionId: SESSION_A,
      }),
    ).toBe(SESSION_A);
  });

  it("selects the newest session that appeared or moved forward", () => {
    expect(
      pickDeepCodeSessionId({
        previous: [{ id: SESSION_A, updateTime: "2026-09-10T00:00:00.000Z" }],
        next: [
          { id: SESSION_A, updateTime: "2026-09-10T00:00:00.000Z" },
          { id: SESSION_B, updateTime: "2026-09-10T00:00:01.000Z" },
        ],
      }),
    ).toBe(SESSION_B);
  });

  it("reads API-key presence from settings without returning the secret", () => {
    const parsed = parseDeepCodeSettingsAuth(
      JSON.stringify({
        env: { MODEL: "deepseek-v4-pro", API_KEY: "sk-secret" },
        model: "deepseek-flash",
      }),
    );
    expect(parsed).toEqual({ hasApiKey: true, model: "deepseek-flash" });
    expect(JSON.stringify(parsed)).not.toContain("sk-secret");
    expect(parseDeepCodeSettingsAuth("{")).toEqual({ hasApiKey: false, model: null });
  });

  it("builds exec argv and per-turn environment overrides", () => {
    expect(buildDeepCodeExecArgs({})).toEqual(["--exec", "--prompt", DEEPCODE_STDIN_PROMPT]);
    expect(buildDeepCodeExecArgs({ resumeSessionId: SESSION_A })).toEqual([
      "--exec",
      "--prompt",
      DEEPCODE_STDIN_PROMPT,
      "--resume",
      SESSION_A,
    ]);
    expect(
      buildDeepCodeTurnEnvironment({ PATH: "/bin" }, { model: "deepseek-flash", effort: "high" }),
    ).toEqual({
      PATH: "/bin",
      DEEPCODE_AUTO_COMPACT_WINDOW: "128K",
      DEEPCODE_MODEL: "deepseek-flash",
      DEEPCODE_REASONING_EFFORT: "high",
    });
  });

  it("reads a session id only from a well-formed resume cursor", () => {
    expect(sessionIdFromCursor({ sessionId: SESSION_A })).toBe(SESSION_A);
    expect(sessionIdFromCursor({ conversationId: SESSION_A })).toBeUndefined();
    expect(sessionIdFromCursor({ sessionId: "nope" })).toBeUndefined();
  });

  it("points the messages path at the session JSONL beside the index", () => {
    expect(deepCodeSessionMessagesPath("/home/user", "/tmp/demo", SESSION_A)).toBe(
      NodePath.join(
        "/home/user",
        ".deepcode",
        "projects",
        deepCodeProjectCode("/tmp/demo"),
        `${SESSION_A}.jsonl`,
      ),
    );
  });

  it("parses tool calls and results from a session JSONL and skips bad lines", () => {
    const raw = [
      "not json",
      JSON.stringify({
        id: "assistant-1",
        role: "assistant",
        messageParams: {
          reasoning_content: "thinking",
          tool_calls: [
            {
              id: "call-1",
              type: "function",
              function: { name: "bash", arguments: '{"command":"echo hi"}' },
            },
            { id: "", type: "function", function: { name: "bash" } },
          ],
        },
      }),
      JSON.stringify({
        id: "tool-1",
        role: "tool",
        messageParams: { tool_call_id: "call-1" },
        meta: {
          function: { name: "bash", arguments: '{"command":"echo hi"}' },
          paramsMd: "echo hi",
          resultMd: "hi",
        },
      }),
      "42",
    ].join("\n");

    expect(parseDeepCodeSessionMessages(raw)).toEqual([
      {
        id: "assistant-1",
        role: "assistant",
        toolCalls: [{ id: "call-1", name: "bash", arguments: '{"command":"echo hi"}' }],
        toolCallId: null,
        toolName: null,
        paramsMd: null,
        resultMd: null,
        // The thinking the work log shows; stdout never carries it.
        reasoning: "thinking",
      },
      {
        id: "tool-1",
        role: "tool",
        toolCalls: [],
        toolCallId: "call-1",
        toolName: "bash",
        paramsMd: "echo hi",
        resultMd: "hi",
        reasoning: null,
      },
    ]);
  });

  it("fences a resumed turn to the messages appended after the previous one", () => {
    const messages = ["a", "b", "c", "d"].map((id) => ({
      id,
      role: "assistant" as const,
      toolCalls: [],
      toolCallId: null,
      toolName: null,
      paramsMd: null,
      resultMd: null,
      reasoning: null,
    }));
    expect(newDeepCodeSessionMessages(messages, null).map((message) => message.id)).toEqual([
      "a",
      "b",
      "c",
      "d",
    ]);
    expect(newDeepCodeSessionMessages(messages, "b").map((message) => message.id)).toEqual([
      "c",
      "d",
    ]);
    // A rewritten file no longer holds the anchor: report nothing rather than
    // replaying every earlier turn's tool calls.
    expect(newDeepCodeSessionMessages(messages, "gone")).toEqual([]);
  });
});
