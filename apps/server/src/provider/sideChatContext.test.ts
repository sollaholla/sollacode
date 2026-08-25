import { describe, expect, it } from "vite-plus/test";

import { T3_BROWSER_CONTROL_POLICY } from "../browserControlPolicy.ts";
import { SOLLA_MCP_AGENT_CONTEXT, withSideChatAgentContext } from "./sideChatContext.ts";

describe("withSideChatAgentContext", () => {
  it("makes the forked agent concurrency-aware without replacing the user's request", () => {
    const prompt = withSideChatAgentContext("Compare the two approaches.");

    expect(prompt).toContain("interactive side-chat sub-agent");
    expect(prompt).toContain("main conversation as concurrent work");
    expect(prompt).toContain("mcp__t3-code__thread_collaboration");
    expect(prompt).toContain("Do not call the unqualified name");
    expect(prompt).toContain("Do not edit files");
    expect(prompt).toContain(T3_BROWSER_CONTROL_POLICY);
    expect(prompt).toContain("Compare the two approaches.");
  });

  it("still supplies the guard context for attachment-only turns", () => {
    expect(withSideChatAgentContext(undefined)).toContain("read-only investigation");
  });

  it("explains that Solla's credential-bound MCP server is runtime-injected", () => {
    expect(SOLLA_MCP_AGENT_CONTEXT).toContain(T3_BROWSER_CONTROL_POLICY);
    expect(SOLLA_MCP_AGENT_CONTEXT).toContain("injected in memory");
    expect(SOLLA_MCP_AGENT_CONTEXT).toContain("intentionally does not appear in .mcp.json");
    expect(SOLLA_MCP_AGENT_CONTEXT).toContain("mcp__t3-code__thread_collaboration");
    expect(SOLLA_MCP_AGENT_CONTEXT).toContain("mcp__t3-code__thread_history_query");
    expect(SOLLA_MCP_AGENT_CONTEXT).toContain("Do not infer");
  });
});
