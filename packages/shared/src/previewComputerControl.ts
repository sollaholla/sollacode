/**
 * Display mapping for the built-in t3-code Preview MCP tools.
 *
 * Providers surface these calls with transport naming — codex titles them
 * "t3-code · preview_click", ACP providers can pass through the raw
 * "mcp__t3-code__preview_click" — none of which says what the agent actually
 * did to the page. Work logs show them as "Computer control · <action>" with
 * a mouse icon instead.
 */
export const COMPUTER_CONTROL_LABEL = "Computer control";

/**
 * Codex does not drive the computer through an MCP computer-control tool. It
 * runs code in its own `node_repl`, which imports `@oai/sky` and calls
 * `sky.click(...)`, `sky.get_app_state(...)`, `sky.press_key(...)` and friends.
 * Work logs showed every one of those as "Node_repl · js" — the transport,
 * with no hint that the agent was clicking around the user's machine.
 *
 * Only code that actually reaches for `sky` counts: a `node_repl` call doing
 * ordinary JavaScript is not computer control and keeps its own name.
 */
const SKY_CALL_PATTERN = /\bsky\.([A-Za-z_][A-Za-z0-9_]*)\s*\(/;
const NODE_REPL_SERVER = "node_repl";

/** `get_app_state` and `getAppState` both read as "get app state". */
function humanizeSkyMethod(method: string): string {
  return method
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replaceAll("_", " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/**
 * Both halves, in that order: what the agent did, then why. "Click" alone
 * loses the intent, and "Open Lyra project installer" alone hides that this
 * particular step was a click — so the row reads
 * "Click — Open Lyra project installer".
 */
function actionFromNodeReplCode(
  server: string,
  code: string,
  title: string | undefined,
): string | null {
  if (server.trim().toLowerCase() !== NODE_REPL_SERVER) return null;
  const method = SKY_CALL_PATTERN.exec(code)?.[1];
  if (method === undefined) return null;
  const action = humanizeSkyMethod(method);
  if (action.length === 0) return null;
  const suppliedTitle = title?.trim();
  return suppliedTitle !== undefined && suppliedTitle.length > 0
    ? `${action} — ${suppliedTitle}`
    : action;
}

const PREVIEW_TOOL_PATTERN = /^preview_[a-z0-9_]+$/;
const RAW_MCP_PREVIEW_TOOL_PATTERN = /^mcp__t3-code__(preview_[a-z0-9_]+)$/;

function actionFromPreviewTool(tool: string): string | null {
  if (!PREVIEW_TOOL_PATTERN.test(tool)) return null;
  const action = tool.slice("preview_".length).replaceAll("_", " ").trim();
  return action.length === 0 ? null : action;
}

function actionFromServerAndTool(server: string, tool: string): string | null {
  return server.trim().toLowerCase() === "t3-code" ? actionFromPreviewTool(tool.trim()) : null;
}

/**
 * The humanized action ("click", "wait for download", "get app state") when a
 * work-log entry is the agent driving a computer — a t3-code Preview MCP call,
 * or a Codex `node_repl` call whose code uses `sky` — else null. Accepts the shapes work logs
 * actually carry: a codex `mcpToolCall` item ({server, tool}), a composed
 * "t3-code · preview_click" title, or a raw "mcp__t3-code__preview_click"
 * tool name used as the title.
 */
export function previewComputerControlAction(input: {
  readonly toolTitle?: string | undefined;
  readonly toolData?: unknown;
}): string | null {
  const data = input.toolData;
  if (data !== null && typeof data === "object") {
    const server = (data as { readonly server?: unknown }).server;
    const tool = (data as { readonly tool?: unknown }).tool;
    if (typeof server === "string" && typeof tool === "string") {
      const action = actionFromServerAndTool(server, tool);
      if (action !== null) return action;
    }
    if (typeof server === "string") {
      const args = (data as { readonly arguments?: unknown }).arguments;
      const code =
        args !== null && typeof args === "object"
          ? (args as { readonly code?: unknown }).code
          : undefined;
      if (typeof code === "string") {
        const suppliedTitle =
          args !== null && typeof args === "object"
            ? (args as { readonly title?: unknown }).title
            : undefined;
        const action = actionFromNodeReplCode(
          server,
          code,
          typeof suppliedTitle === "string" ? suppliedTitle : undefined,
        );
        if (action !== null) return action;
      }
    }
  }

  const title = input.toolTitle?.trim();
  if (!title) return null;
  const middotParts = title.split(" · ");
  if (middotParts.length === 2) {
    const action = actionFromServerAndTool(middotParts[0]!, middotParts[1]!);
    if (action !== null) return action;
  }
  const rawToolName = RAW_MCP_PREVIEW_TOOL_PATTERN.exec(title)?.[1];
  return rawToolName === undefined ? null : actionFromPreviewTool(rawToolName);
}

/** "Computer control · Click" — the row heading for a detected action. */
export function previewComputerControlHeading(action: string): string {
  return `${COMPUTER_CONTROL_LABEL} · ${action.charAt(0).toUpperCase()}${action.slice(1)}`;
}
