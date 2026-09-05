import { describe, expect, it } from "vite-plus/test";

import { mergeProviderInstanceEnvironment } from "./ProviderInstanceEnvironment.ts";

describe("mergeProviderInstanceEnvironment", () => {
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
