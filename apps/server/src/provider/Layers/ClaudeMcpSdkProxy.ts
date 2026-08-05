import type { McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type ListToolsResult,
} from "@modelcontextprotocol/sdk/types.js";

import packageJson from "../../../package.json" with { type: "json" };

export interface ClaudeMcpSdkProxy {
  readonly serverConfig: McpSdkServerConfigWithInstance;
  readonly close: () => Promise<void>;
}

const alwaysLoadTools = (result: ListToolsResult): ListToolsResult => ({
  ...result,
  tools: result.tools.map((tool) => ({
    ...tool,
    _meta: {
      ...tool._meta,
      "anthropic/alwaysLoad": true,
    },
  })),
});

/**
 * Bridges Solla's credential-scoped HTTP MCP endpoint through the Claude
 * Agent SDK's in-process MCP transport.
 *
 * Claude Code 2.1.221 can advertise HTTP MCP schemas to the model while its
 * local execution registry still omits those tools, producing "No such tool
 * available" when the model calls a schema it was just given. SDK MCP tools
 * use the bidirectional control channel instead, while this proxy preserves
 * the same server-side credential and relationship authorization by
 * forwarding every list/call to Solla's real endpoint.
 */
export async function createClaudeMcpSdkProxy(input: {
  readonly endpoint: string;
  readonly authorizationHeader: string;
}): Promise<ClaudeMcpSdkProxy> {
  const client = new Client({
    name: "solla-claude-mcp-proxy",
    version: packageJson.version,
  });
  const transport = new StreamableHTTPClientTransport(new URL(input.endpoint), {
    requestInit: {
      headers: {
        Authorization: input.authorizationHeader,
      },
    },
  });

  try {
    // MCP SDK 1.29's transport class and interface disagree under
    // exactOptionalPropertyTypes about the optional sessionId property.
    await client.connect(transport as unknown as Transport);
    // Fail session startup explicitly if the credential or endpoint cannot
    // supply schemas. A connected-but-empty Claude session is misleading and
    // strands side agents without the collaboration tool they were promised.
    const initialTools = alwaysLoadTools(await client.listTools());
    const instructions = client.getInstructions();
    const server = new McpServer(
      {
        name: "Solla Code",
        version: packageJson.version,
      },
      {
        capabilities: {
          tools: {},
        },
        ...(instructions !== undefined ? { instructions } : {}),
      },
    );

    server.server.setRequestHandler(ListToolsRequestSchema, async (request) => {
      if (request.params?.cursor === undefined) {
        return initialTools;
      }
      return alwaysLoadTools(await client.listTools(request.params));
    });
    server.server.setRequestHandler(CallToolRequestSchema, async (request) =>
      client.callTool(request.params),
    );

    let closed = false;
    return {
      serverConfig: {
        type: "sdk",
        name: "Solla Code",
        instance: server,
      },
      close: async () => {
        if (closed) return;
        closed = true;
        await client.close();
      },
    };
  } catch (cause) {
    await client.close().catch(() => undefined);
    throw cause;
  }
}

export const __testing = {
  alwaysLoadTools,
};
