// @effect-diagnostics nodeBuiltinImport:off
import * as NodePath from "node:path";
import { describe, expect, it } from "vite-plus/test";
import {
  buildDeepCodeExecArgs,
  buildDeepCodeTurnEnvironment,
  deepCodeProjectCode,
  isDeepCodeEffort,
  isDeepCodeSessionId,
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
    expect(buildDeepCodeExecArgs({ prompt: "hello" })).toEqual(["--exec", "--prompt", "hello"]);
    expect(buildDeepCodeExecArgs({ prompt: "hello", resumeSessionId: SESSION_A })).toEqual([
      "--exec",
      "--prompt",
      "hello",
      "--resume",
      SESSION_A,
    ]);
    expect(
      buildDeepCodeTurnEnvironment({ PATH: "/bin" }, { model: "deepseek-flash", effort: "high" }),
    ).toEqual({
      PATH: "/bin",
      DEEPCODE_MODEL: "deepseek-flash",
      DEEPCODE_REASONING_EFFORT: "high",
    });
  });

  it("reads a session id only from a well-formed resume cursor", () => {
    expect(sessionIdFromCursor({ sessionId: SESSION_A })).toBe(SESSION_A);
    expect(sessionIdFromCursor({ conversationId: SESSION_A })).toBeUndefined();
    expect(sessionIdFromCursor({ sessionId: "nope" })).toBeUndefined();
  });
});
