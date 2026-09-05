import { describe, expect, it } from "vite-plus/test";

import { mergeProviderInstanceEnvironment } from "./ProviderInstanceEnvironment.ts";

describe("mergeProviderInstanceEnvironment", () => {
  it("removes a stale inherited Claude session proxy before applying explicit provider settings", () => {
    const inherited = {
      ANTHROPIC_BASE_URL: "http://127.0.0.1:53347",
      T3CODE_CLAUDE_PROXY_BASE_URL: "http://127.0.0.1:53347",
      T3CODE_CLAUDE_PROXY_UPSTREAM: "",
      CLAUDECODE: "1",
    };
    expect(mergeProviderInstanceEnvironment(undefined, inherited)).toEqual({});
    expect(
      mergeProviderInstanceEnvironment(
        [{ name: "ANTHROPIC_BASE_URL", value: "http://127.0.0.1:8080", sensitive: false }],
        inherited,
      ),
    ).toEqual({ ANTHROPIC_BASE_URL: "http://127.0.0.1:8080" });
    expect(inherited.ANTHROPIC_BASE_URL).toBe("http://127.0.0.1:53347");
  });

  it("does not inherit a previous runtime's MCP credentials", () => {
    const inherited = {
      T3_MCP_BEARER_TOKEN: "revoked-provider-token",
      SOLLA_TERMINAL_MCP_BEARER_TOKEN: "revoked-terminal-token",
      SOLLA_TERMINAL_MCP_ENDPOINT: "http://previous-runtime/mcp",
      PATH: "/bin",
    };
    expect(mergeProviderInstanceEnvironment(undefined, inherited)).toEqual({ PATH: "/bin" });
    expect(inherited.T3_MCP_BEARER_TOKEN).toBe("revoked-provider-token");
  });

  it("overrides inherited environment values and preserves empty strings", () => {
    expect(
      mergeProviderInstanceEnvironment(
        [
          { name: "OPENROUTER_API_KEY", value: "sk-or-test", sensitive: true },
          { name: "ANTHROPIC_API_KEY", value: "", sensitive: false },
        ],
        { ANTHROPIC_API_KEY: "inherited", PATH: "/bin" },
      ),
    ).toMatchObject({
      OPENROUTER_API_KEY: "sk-or-test",
      ANTHROPIC_API_KEY: "",
      PATH: "/bin",
    });
  });
});
