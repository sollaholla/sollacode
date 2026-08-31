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
 * The humanized action ("click", "wait for download") when a work-log entry
 * is a t3-code Preview MCP call, else null. Accepts the shapes work logs
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
