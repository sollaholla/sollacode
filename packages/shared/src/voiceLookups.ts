/**
 * Read-only lookups a live voice can run itself, without waiting on a chat
 * turn. The host runs them (`apps/server/src/voice/VoiceLookups.ts`), so they
 * see every thread on this computer and on the computers connected to it.
 */

/** The function tool the Grok engine and the host's fast path both understand. */
export interface VoiceLookupTool {
  readonly type: "function";
  readonly name: string;
  readonly description: string;
  readonly parameters: Record<string, unknown>;
}

const ENVIRONMENT_PARAMETER = {
  environmentId: {
    type: "string",
    description:
      "The computer a thread is on, copied from its list_threads row. Omit for this computer.",
  },
} as const;

const CURSOR_PARAMETER = {
  cursor: {
    type: "string",
    description: "nextCursor from the previous page. Omit for the first page.",
  },
} as const;

export const VOICE_LOOKUP_TOOLS: ReadonlyArray<VoiceLookupTool> = [
  {
    type: "function",
    name: "list_threads",
    description:
      "List the person's threads on this computer and on connected computers, newest first, with each thread's status. Use it to find a thread's id before reading it.",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Only threads whose title, project or computer contains this text.",
        },
      },
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "read_thread",
    description:
      "Read one thread's messages, newest first, a page at a time. Pass query to find text inside it. Follow nextCursor for older messages.",
    parameters: {
      type: "object",
      properties: {
        threadId: { type: "string", description: "The thread's id from list_threads." },
        ...ENVIRONMENT_PARAMETER,
        query: { type: "string", description: "Only messages containing this text." },
        ...CURSOR_PARAMETER,
      },
      required: ["threadId"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "search_threads",
    description:
      "Search what every thread has said, on this computer and on connected computers, most recently active threads first. Use it when the person remembers something but not where it was. Follow nextCursor to search further back.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "The text to look for." },
        ...ENVIRONMENT_PARAMETER,
        ...CURSOR_PARAMETER,
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
];

/** Answers from the web on engines with no search of their own. */
export const VOICE_WEB_SEARCH_TOOL: VoiceLookupTool = {
  type: "function",
  name: "web_search",
  description:
    "Search the internet for current facts: news, prices, weather, documentation, anything not in the person's workspace.",
  parameters: {
    type: "object",
    properties: { query: { type: "string", description: "What to find out." } },
    required: ["query"],
    additionalProperties: false,
  },
};

export const VOICE_LOOKUP_NAMES: ReadonlySet<string> = new Set([
  ...VOICE_LOOKUP_TOOLS.map((tool) => tool.name),
  VOICE_WEB_SEARCH_TOOL.name,
]);
