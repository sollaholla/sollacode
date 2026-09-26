// @effect-diagnostics nodeBuiltinImport:off - This session-scoped helper runs in providers' shell tools.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import type { McpProviderSessionConfig } from "./McpProviderSession.ts";

/** A standard MCP client for runtimes whose native transport is missing or broken. */
export async function createMcpShellBridge(
  config: McpProviderSessionConfig,
  stateDir: string,
  platform: NodeJS.Platform,
): Promise<string> {
  const directory = NodePath.join(stateDir, "mcp-tools");
  await NodeFSP.mkdir(directory, { recursive: true, mode: 0o700 });
  const file = NodePath.join(directory, `${config.providerSessionId}.cjs`);
  const source = `const endpoint = ${JSON.stringify(config.endpoint)};
const authorization = ${JSON.stringify(config.authorizationHeader)};
let sessionId;
let counter = 0;
async function request(method, params, notification = false) {
 const response = await fetch(endpoint, { method: 'POST', headers: { Authorization: authorization, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...(sessionId ? {'Mcp-Session-Id':sessionId} : {}) }, body: JSON.stringify({jsonrpc:'2.0', ...(notification ? {} : {id:++counter}), method, params}), signal: AbortSignal.timeout(180000) });
 if (!response.ok) throw new Error('Host MCP request failed (HTTP '+response.status+'). Ask Solla to refresh this session if the credential expired.');
 sessionId = response.headers.get('mcp-session-id') || sessionId;
 if (notification || response.status === 202) return;
 const text = await response.text();
 const frames = response.headers.get('content-type')?.includes('text/event-stream') ? text.split(/\\r?\\n/).filter(line=>line.startsWith('data:')).map(line=>JSON.parse(line.slice(5).trim())) : [JSON.parse(text)];
 const reply = frames.find(frame=>frame.id === counter);
 if (!reply) throw new Error('Host MCP did not return a matching response.');
 if (reply.error) throw new Error(reply.error.message || 'Host MCP tool failed');
 return reply.result;
}
(async () => {
 await request('initialize', { protocolVersion:'2025-03-26', capabilities:{}, clientInfo:{name:'solla-provider-tools',version:'1'} });
 await request('notifications/initialized', {}, true);
 const [action, name, json] = process.argv.slice(2);
 if (action === 'call') {
   if (!name) throw new Error('Usage: call tool_name JSON_arguments');
   console.log(JSON.stringify(await request('tools/call', {name, arguments:JSON.parse(json || '{}')})));
 } else {
   let tools = [], cursor;
   do { const page = await request('tools/list', cursor ? {cursor} : {}); tools.push(...page.tools); cursor = page.nextCursor; } while(cursor);
   if (action === 'describe') { const tool = tools.find(tool=>tool.name === name); if(!tool) throw new Error('Unknown tool '+name); console.log(JSON.stringify(tool)); }
   else console.log(JSON.stringify(tools.map(tool=>({name:tool.name, description:tool.description?.slice(0,500)}))));
 }
})().catch(error=>{console.error(error.message);process.exitCode=1;});
`;
  await NodeFSP.writeFile(file, source, { mode: 0o600 });
  const quote = (value: string) =>
    platform === "win32"
      ? `"${value.replaceAll('"', '""')}"`
      : `'${value.replaceAll("'", "'\\''")}'`;
  const command = `${platform === "win32" ? 'set "ELECTRON_RUN_AS_NODE=1" && ' : "ELECTRON_RUN_AS_NODE=1 "}${quote(process.execPath)} ${quote(file)}`;
  return `[Solla host tools]
You have access to this thread's MCP tools, including persisted history, workspace consultation, collaboration, terminal and preview tools. Prefer the native t3-code tools when present. If your provider does not expose them natively, use your shell tool to run this session-scoped MCP client:
${command} list
${command} describe thread_history_query
${command} call thread_history_query '{}'
For other tools, describe the tool first, then call it with one JSON object argument. The client uses your existing thread credential; do not read, copy or print the helper's source. Do not claim history or host tools are unavailable without trying this client. Tool permissions and approvals still apply.
[/Solla host tools]`;
}

export async function removeMcpShellBridge(
  config: McpProviderSessionConfig,
  stateDir: string,
): Promise<void> {
  await NodeFSP.rm(NodePath.join(stateDir, "mcp-tools", `${config.providerSessionId}.cjs`), {
    force: true,
  });
}
