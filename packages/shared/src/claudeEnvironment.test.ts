import { describe, expect, it } from "vite-plus/test";

import {
  claudeSessionProxyEnvironment,
  restoreInheritedClaudeEnvironment,
} from "./claudeEnvironment.ts";

const legacySession = {
  ANTHROPIC_BASE_URL: "http://127.0.0.1:53347",
  CLAUDECODE: "1",
  CLAUDE_CODE_ENTRYPOINT: "sdk-cli",
  CLAUDE_AGENT_SDK_VERSION: "0.3.261",
  T3CODE_DESKTOP_ROOT_PID: "123",
};

describe("Claude session environment inheritance", () => {
  it("repairs the dead legacy SDK proxy inherited by an app update", () => {
    const env = { ...legacySession, PATH: "/bin", ANTHROPIC_API_KEY: "keep-credential" };
    restoreInheritedClaudeEnvironment(env);
    expect(env).toEqual({
      PATH: "/bin",
      ANTHROPIC_API_KEY: "keep-credential",
      T3CODE_DESKTOP_ROOT_PID: "123",
    });
    restoreInheritedClaudeEnvironment(env);
    expect(env.ANTHROPIC_BASE_URL).toBeUndefined();
  });

  it.each([undefined, "https://gateway.example/api", "http://127.0.0.1:8080"])(
    "restores the configured upstream %s across repeated app/session launches",
    (upstream) => {
      const appEnv = { ANTHROPIC_BASE_URL: upstream, PATH: "/bin" };
      for (const port of [53347, 56735, 60123]) {
        const childEnv = {
          ...appEnv,
          ...claudeSessionProxyEnvironment(appEnv, `http://127.0.0.1:${port}`),
        };
        restoreInheritedClaudeEnvironment(childEnv);
        expect(childEnv.ANTHROPIC_BASE_URL).toBe(upstream);
        expect(childEnv.T3CODE_CLAUDE_PROXY_BASE_URL).toBeUndefined();
        Object.assign(appEnv, { ANTHROPIC_BASE_URL: childEnv.ANTHROPIC_BASE_URL });
      }
    },
  );

  it.each([undefined, "", "https://api.anthropic.com", "https://api.anthropic.com/"])(
    "keeps the CLI's first-party behavior behind the relay for upstream %s",
    (upstream) => {
      const env = claudeSessionProxyEnvironment(
        { ANTHROPIC_BASE_URL: upstream },
        "http://127.0.0.1:53347",
      );
      expect(env._CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL).toBe("1");
    },
  );

  it.each([
    { ANTHROPIC_BASE_URL: "https://gateway.example/api" },
    { ANTHROPIC_BASE_URL: "http://127.0.0.1:8080" },
    { ANTHROPIC_BASE_URL: "http://api.anthropic.com" },
    { ANTHROPIC_BASE_URL: "not a url" },
    { CLAUDE_CODE_USE_BEDROCK: "1" },
    { CLAUDE_CODE_USE_VERTEX: "true" },
    { CLAUDE_CODE_USE_GATEWAY: "on" },
    { CLAUDE_CODE_USE_ANTHROPIC_AWS: "yes" },
  ])("does not claim first-party behavior for %o", (upstream) => {
    const env = claudeSessionProxyEnvironment(upstream, "http://127.0.0.1:53347");
    expect(env).not.toHaveProperty("_CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL");
  });

  it("reads provider selection flags the way Claude Code does", () => {
    const env = claudeSessionProxyEnvironment(
      { CLAUDE_CODE_USE_BEDROCK: "0", CLAUDE_CODE_USE_VERTEX: "false" },
      "http://127.0.0.1:53347",
    );
    expect(env._CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL).toBe("1");
  });

  it("does not leak the first-party claim into descendant launches", () => {
    const env: Record<string, string | undefined> = {
      PATH: "/bin",
      ...claudeSessionProxyEnvironment({}, "http://127.0.0.1:53347"),
    };
    restoreInheritedClaudeEnvironment(env);
    expect(env).toEqual({ PATH: "/bin" });
  });

  it("preserves a deliberate endpoint change made inside a session", () => {
    const env = {
      ...claudeSessionProxyEnvironment({}, "http://127.0.0.1:53347"),
      ANTHROPIC_BASE_URL: "https://new.example/api",
    };
    restoreInheritedClaudeEnvironment(env);
    expect(env).toEqual({ ANTHROPIC_BASE_URL: "https://new.example/api" });
  });

  it.each([
    { ANTHROPIC_BASE_URL: "http://127.0.0.1:53347" },
    { ...legacySession, T3CODE_DESKTOP_ROOT_PID: undefined },
    { ...legacySession, CLAUDE_CODE_ENTRYPOINT: "cli" },
    { ...legacySession, ANTHROPIC_BASE_URL: "https://gateway.example/api" },
  ])("preserves unowned API endpoints", (inherited) => {
    const env = { ...inherited };
    restoreInheritedClaudeEnvironment(env);
    expect(env.ANTHROPIC_BASE_URL).toBe(inherited.ANTHROPIC_BASE_URL);
  });
});
