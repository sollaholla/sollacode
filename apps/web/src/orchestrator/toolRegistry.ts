import type { OrchestratorAuthority } from "@t3tools/contracts";

/**
 * The orchestrator's tool surface, declared in one place.
 *
 * Previously the wire definitions lived in `realtimeProtocol.ts` and the
 * authority rules in `tools.ts`, so adding a tool meant editing two files that
 * could silently disagree — a tool advertised at one authority and executed
 * under another. A single registry carries the schema, the authority floor and
 * whether the call has to be confirmed, and both sides derive from it.
 *
 * Reading project files and searching them is included, at read-only authority:
 * the orchestrator is asked about code often enough that refusing made it feel
 * crippled. Those calls go through the same server RPCs the editor uses, which
 * confine every path to the project's own workspace root and refuse binaries —
 * so the blast radius is "files in a project you already opened", not the disk.
 *
 * One tool reaches outside the app: `open_website` puts a page on the user's
 * screen. It is at read-only authority because it is the narrowest thing that
 * answers "put that on" — a URL chosen from a fixed catalog, handed to the
 * browser through the same allow-listed path a clicked link takes. It cannot
 * express an address the model invented, so a misheard site name resolves to a
 * known site or to nothing.
 *
 * `list_terminals`, `read_terminal` and `write_to_terminal` reach the same
 * thread terminals the UI shows. List and read are read-only; writing is send
 * authority because it types into a live pane. None of them open a new terminal.
 *
 * `run_command` runs a shell command on the machine and reads back its output,
 * so the orchestrator can look around rather than telling the user to go and
 * look themselves. Read-only is asked for in the tool description rather than
 * enforced by an allowlist: the line between reading and writing is gray enough
 * in practice that a list strict enough to mean anything blocked most of what
 * the tool is for. The server refuses only a short list of irreversible
 * actions, which exists because the input arrives by voice and a
 * mis-transcription there cannot be taken back.
 */

export interface OrchestratorToolDefinition {
  readonly type: "function";
  readonly name: string;
  readonly description: string;
  readonly parameters: Record<string, unknown>;
  /** Lowest authority that may call this tool. */
  readonly minAuthority: OrchestratorAuthority;
  /** Whether the tool refuses to act until the user has confirmed out loud. */
  readonly requiresConfirmation: boolean;
}

/**
 * Every tool takes this. The model states, in one short phrase, why it is
 * calling — which is what makes the tool log readable after the fact instead of
 * a list of bare names.
 */
const REASON_PARAMETER = {
  reason: {
    type: "string",
    description:
      'One short phrase on why you are calling this, in the user\'s terms. Example: "user asked which model Rover uses".',
  },
} as const;

/**
 * How the user refers to a thread out loud.
 *
 * Requiring an exact id — which in practice meant an exact title — is what made
 * routing brittle: "the Solla Code thread" matched nothing. Names are resolved
 * against titles, projects and workspace folders, so the model should pass
 * through whatever the user actually said rather than trying to normalize it.
 */
const THREAD_TARGET_PARAMETERS = {
  thread: {
    type: "string",
    description:
      'The thread: its id from list_threads, or simply the name the user used — "Vera Medical", "the Solla Code one", "rover". Pass their words through; do not clean them up.',
  },
  project: {
    type: "string",
    description:
      "The project, when the user named one to tell similar threads apart (several threads often share a project). Only narrows an otherwise ambiguous match.",
  },
} as const;

const CONFIRM_PARAMETER = {
  confirm: {
    type: "boolean",
    description:
      "Set only after the user has explicitly agreed to this exact action. Omit on the first call.",
  },
} as const;

export const ORCHESTRATOR_TOOLS: ReadonlyArray<OrchestratorToolDefinition> = [
  {
    type: "function",
    name: "list_threads",
    description:
      "List the user's threads with their status, what each is blocked on, and the model each runs on. Call this before answering any question about what is running.",
    minAuthority: "read-only",
    requiresConfirmation: false,
    parameters: {
      type: "object",
      properties: {
        ...REASON_PARAMETER,
        includeSettled: {
          type: "boolean",
          description: "Include threads the user already settled. Defaults to false.",
        },
      },
      required: [],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "describe_thread",
    description:
      "Get the detailed current status of one thread, including the project it belongs to, the model and provider it runs on, its thinking effort, its access mode, and why it failed if it did. Accepts the name the user used, not just an id.",
    minAuthority: "read-only",
    requiresConfirmation: false,
    parameters: {
      type: "object",
      properties: {
        ...REASON_PARAMETER,
        ...THREAD_TARGET_PARAMETERS,
      },
      required: ["thread"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "read_thread",
    description:
      "Read what was actually said in a thread — the messages themselves, newest last, grouped into numbered turns. Use this whenever the user asks what a thread said, found, decided or concluded, instead of guessing from its status or asking the thread to repeat itself. Set includeActivities to also see the tool calls and events of those turns.",
    minAuthority: "read-only",
    requiresConfirmation: false,
    parameters: {
      type: "object",
      properties: {
        ...REASON_PARAMETER,
        ...THREAD_TARGET_PARAMETERS,
        limit: {
          type: "number",
          description: "How many of the most recent messages to read. Defaults to 20, max 60.",
        },
        includeActivities: {
          type: "boolean",
          description:
            "Also return the thread's activity log — tool calls, errors and turn events. Off by default; it is detail the user rarely wants read aloud.",
        },
      },
      required: ["thread"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "search_threads",
    description:
      "Search what threads have said for a word or phrase, across the whole workspace or within one project. Returns the matching lines with the thread they came from and which turn. Use this when the user remembers something was discussed but not where, or asks which thread mentioned something.",
    minAuthority: "read-only",
    requiresConfirmation: false,
    parameters: {
      type: "object",
      properties: {
        ...REASON_PARAMETER,
        query: {
          type: "string",
          description: "The text to look for. Matched case-insensitively.",
        },
        project: {
          type: "string",
          description:
            "Optional. Restrict the search to one project, named the way the user named it.",
        },
        thread: {
          type: "string",
          description: "Optional. Restrict the search to a single thread.",
        },
        limit: {
          type: "number",
          description: "How many matches to return. Defaults to 12, max 40.",
        },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "end_voice_session",
    description:
      'Stop listening, or stop talking, because the user asked you to out loud. Use mode "stop" when they are done with the conversation — "that\'s all", "goodbye", "stop listening", "you can go now" — and mode "hush" when they only want you to stop talking but keep listening — "quiet", "shut up", "stop talking", "enough". Call this instead of telling them to press a button. Do not call it for "stop" aimed at a thread; that is interrupt_thread.',
    // Ending your own microphone needs no privilege: it is the one action that
    // only ever reduces what the orchestrator is doing.
    minAuthority: "read-only",
    requiresConfirmation: false,
    parameters: {
      type: "object",
      properties: {
        ...REASON_PARAMETER,
        mode: {
          type: "string",
          enum: ["stop", "hush"],
          description:
            '"stop" closes the voice session entirely; "hush" only cuts off what you are saying and keeps listening. Defaults to "stop".',
        },
      },
      required: [],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "set_orchestrator_voice",
    description:
      "Change the voice you speak with, when the user asks for a different one. The voice is fixed when a session starts, so a live session is reconnected for you and the new voice is heard straight away. Keep your reply to a few words — the reconnection cuts off anything longer.",
    // Writes a persisted user setting, so it sits with the other actions rather
    // than with the read-only inspection tools.
    minAuthority: "send",
    requiresConfirmation: false,
    parameters: {
      type: "object",
      properties: {
        ...REASON_PARAMETER,
        voice: {
          type: "string",
          description:
            'The voice name, as the user said it. On OpenAI that is a Realtime voice such as "cedar", "marin" or "alloy". On Grok it is a built-in name such as "eve", "ara", "leo" or "rex", or an 8-character custom voice id. Passed through as-is.',
        },
      },
      required: ["voice"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "get_orchestrator_settings",
    description:
      "Read your own configuration: the voice provider (OpenAI or Grok), the model and voice you were started with, the language you are pinned to, your authority, and whether a settings change is waiting for the voice session to restart. Use this whenever the user asks what model you are using or whether a settings change has taken effect.",
    minAuthority: "read-only",
    requiresConfirmation: false,
    parameters: {
      type: "object",
      properties: { ...REASON_PARAMETER },
      required: [],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "get_runtime_state",
    description:
      "Read the workspace's runtime state: connected environments and their reachability, and how many threads are working, blocked, failed or idle.",
    minAuthority: "read-only",
    requiresConfirmation: false,
    parameters: {
      type: "object",
      properties: { ...REASON_PARAMETER },
      required: [],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "open_website",
    description:
      "Open a website on the user's screen, in their normal browser. Give the site by name — YouTube, Google, GitHub, Google Maps, Spotify, Wikipedia, Gmail — and optionally something to search for on it. Use it when the user asks you to open, pull up, put on or look something up. It only opens a page: it cannot run anything, install anything, or change any file, and it cannot open a site that is not on its list.",
    minAuthority: "read-only",
    requiresConfirmation: false,
    parameters: {
      type: "object",
      properties: {
        site: {
          type: "string",
          description:
            'The site, in the user\'s own words — "YouTube", "you tube", "Google Maps". Near-misses from speech are resolved for you.',
        },
        query: {
          type: "string",
          description: "Optional. What to search for on that site. Omit to open its home page.",
        },
        ...REASON_PARAMETER,
      },
      required: ["site"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "run_command",
    description:
      "Run a shell command on the user's computer and read its output back. Use it to look things up for yourself — what is in a folder, what a file contains, what git says about a repository, what is installed, how much disk is free — instead of asking the user to go and check. Pipes, globs and redirection all work. Keep to commands that only read: this is trusted rather than enforced, so do not install, delete, move, overwrite or modify anything unless the user has just asked you to in this conversation. Output is truncated and the command is stopped after twenty seconds, so prefer targeted commands over ones that print everything.",
    minAuthority: "read-only",
    requiresConfirmation: false,
    parameters: {
      type: "object",
      properties: {
        command: {
          type: "string",
          description:
            'The command line to run, exactly as it would be typed in a terminal — for example "ls -la ~/Documents" or "git -C ~/code/app log --oneline -5".',
        },
        cwd: {
          type: "string",
          description:
            "Optional. Absolute directory to run in. Omit to run in the orchestrator's own working directory, or pass an absolute path yourself.",
        },
        ...REASON_PARAMETER,
      },
      required: ["command"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "create_project",
    description:
      "Add a folder that already exists on this computer to Solla Code as a project, so threads can be started in it. Give the folder's absolute path and, optionally, a name — the folder's own name is used when you do not. It only links a folder that is already there: it never creates one, so if the path does not exist this fails and says so rather than making an empty directory. Use it when the user names a folder they want to work in and it is not already a project. Check list_projects first — linking a folder that is already a project fails.",
    minAuthority: "full",
    // Adds something durable to the user's workspace, from a path that arrived
    // by voice. The spoken confirmation is what stops a misheard directory name
    // becoming a project nobody asked for.
    requiresConfirmation: true,
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description:
            'Absolute path to the existing folder, e.g. "/Users/example/code/SampleApp". Use run_command to find it first if you only have a name.',
        },
        name: {
          type: "string",
          description: "Optional. What to call the project. Defaults to the folder's own name.",
        },
        ...REASON_PARAMETER,
      },
      required: ["path"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "approve_proposed_plan",
    description:
      "Approve the plan a thread is waiting on, so it stops waiting and starts building. Only for when the user has just told you, in this conversation, to approve it — the plan is theirs to accept, and this exists so they can say yes out loud instead of going to find the thread. Describe the plan first with describe_thread, and only call this once they have agreed to that plan.",
    minAuthority: "full",
    // The one tool that commits someone else's work to a course of action. The
    // spoken confirmation is the safeguard that keeps a misheard "yeah" from
    // starting a build.
    requiresConfirmation: true,
    parameters: {
      type: "object",
      properties: {
        thread: {
          type: "string",
          description: "The thread whose plan should be approved, by name or id.",
        },
        ...REASON_PARAMETER,
      },
      required: ["thread"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "get_usage",
    description:
      "Read how much the user has used: each provider's remaining quota — the same figures the Providers tab shows, with the percentage used and when each window resets — and separately the orchestrator's own voice usage, in spoken minutes and estimated cost. Use it whenever the user asks how much they have used, how much is left, whether they are near a limit, or what talking to you is costing.",
    minAuthority: "read-only",
    requiresConfirmation: false,
    parameters: {
      type: "object",
      properties: {
        scope: {
          type: "string",
          enum: ["all", "providers", "voice"],
          description:
            'Which half to read. "providers" for plan quota, "voice" for what this orchestrator has cost, "all" (the default) for both.',
        },
        ...REASON_PARAMETER,
      },
      required: [],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "list_project_files",
    description:
      "List files and folders in a project, so you can see how it is laid out. Give a sub-path to look inside a folder, or omit it for the top level. Read-only.",
    minAuthority: "read-only",
    requiresConfirmation: false,
    parameters: {
      type: "object",
      properties: {
        ...REASON_PARAMETER,
        project: {
          type: "string",
          description: "The project, named the way the user says it. Omit if there is only one.",
        },
        path: {
          type: "string",
          description:
            'Folder within the project, e.g. "apps/web/src". Omit for the top level. Always relative to the project.',
        },
      },
      required: [],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "read_project_file",
    description:
      "Read a text file from a project. Use it to answer questions about what the code or config actually says instead of guessing. Long files come back truncated; binaries are refused. Read-only.",
    minAuthority: "read-only",
    requiresConfirmation: false,
    parameters: {
      type: "object",
      properties: {
        ...REASON_PARAMETER,
        project: {
          type: "string",
          description: "The project, named the way the user says it. Omit if there is only one.",
        },
        path: {
          type: "string",
          description:
            'Path to the file relative to the project root, e.g. "apps/web/src/main.tsx".',
        },
      },
      required: ["path"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "find_project_files",
    description:
      "Find files in a project by name or partial path when you do not know exactly where something lives. Read-only.",
    minAuthority: "read-only",
    requiresConfirmation: false,
    parameters: {
      type: "object",
      properties: {
        ...REASON_PARAMETER,
        project: {
          type: "string",
          description: "The project, named the way the user says it. Omit if there is only one.",
        },
        query: {
          type: "string",
          description: 'Part of a filename or path, e.g. "realtimeSession"',
        },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "search_project",
    description:
      "Search a project's file contents for a string, and get back the matching lines with their files and line numbers. Use it to find where something is defined or used. Read-only.",
    minAuthority: "read-only",
    requiresConfirmation: false,
    parameters: {
      type: "object",
      properties: {
        ...REASON_PARAMETER,
        project: {
          type: "string",
          description: "The project, named the way the user says it. Omit if there is only one.",
        },
        query: { type: "string", description: "Text to search for." },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "list_terminals",
    description:
      "List the terminals currently open in the workspace: which thread they belong to, their label (the running command when one is active), and whether they are running. Call this when the user asks what is in a terminal, which CLIs are open, or before reading or typing into a pane.",
    minAuthority: "read-only",
    requiresConfirmation: false,
    parameters: {
      type: "object",
      properties: {
        ...REASON_PARAMETER,
        ...THREAD_TARGET_PARAMETERS,
      },
      required: [],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "read_terminal",
    description:
      "Read the current output of a terminal pane — the visible text, newest at the end. Use this when the user asks what a terminal is showing, whether a CLI is waiting, or what an agent in a terminal last said. Does not start a new terminal.",
    minAuthority: "read-only",
    requiresConfirmation: false,
    parameters: {
      type: "object",
      properties: {
        ...REASON_PARAMETER,
        ...THREAD_TARGET_PARAMETERS,
        terminal: {
          type: "string",
          description:
            'The terminal, as the user named it — "the claude one", "term-1", "grok". Omit when the thread has only one pane.',
        },
      },
      required: [],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "send_to_thread",
    description:
      "Send a message into one thread, exactly as if the user had typed it there. Just send it — the target is resolved from the name the user used, and you are only asked to confirm when that name genuinely matches more than one thread.",
    minAuthority: "send",
    requiresConfirmation: false,
    parameters: {
      type: "object",
      properties: {
        ...REASON_PARAMETER,
        ...CONFIRM_PARAMETER,
        ...THREAD_TARGET_PARAMETERS,
        message: { type: "string", description: "The message to send." },
      },
      required: ["thread", "message"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "write_to_terminal",
    description:
      "Type into a live terminal, as if the user had typed there. Use this to send a command, answer a CLI prompt, or continue an agent that is running in a pane rather than in chat. Defaults to pressing Enter after the text; set submit false to type without submitting. Does not open a new terminal.",
    minAuthority: "send",
    requiresConfirmation: false,
    parameters: {
      type: "object",
      properties: {
        ...REASON_PARAMETER,
        ...CONFIRM_PARAMETER,
        ...THREAD_TARGET_PARAMETERS,
        terminal: {
          type: "string",
          description:
            'The terminal, as the user named it — "the claude one", "term-1". Omit when the thread has only one pane.',
        },
        text: {
          type: "string",
          description: "What to type. Pass the user's words; do not wrap them in extra quotes.",
        },
        submit: {
          type: "boolean",
          description: "Press Enter after typing. Defaults to true.",
        },
      },
      required: ["text"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "create_thread",
    description:
      "Start a new thread for work that does not belong in any existing one, and send it a first message. Use this when the request is unrelated to what the open threads are doing. When it *is* related, send to that thread instead — do not fragment one piece of work across several.",
    minAuthority: "send",
    requiresConfirmation: false,
    parameters: {
      type: "object",
      properties: {
        ...REASON_PARAMETER,
        project: {
          type: "string",
          description:
            "The project it belongs to, named the way the user says it. Omit only when there is exactly one project.",
        },
        title: {
          type: "string",
          description:
            "A short title describing the work. Write one yourself from what the user asked; do not make them supply it.",
        },
        message: { type: "string", description: "The first message to send into the new thread." },
      },
      required: ["title", "message"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "create_side_chat",
    description:
      "Open a side chat off a thread that is already running, and ask it something. A side chat inherits that thread's conversation as it stands now, so it can be asked about work in progress without disturbing it — the parent keeps running. Use this for a question or a tangent about what a thread is doing; use create_thread for genuinely separate work.",
    minAuthority: "send",
    requiresConfirmation: false,
    parameters: {
      type: "object",
      properties: {
        ...REASON_PARAMETER,
        ...CONFIRM_PARAMETER,
        ...THREAD_TARGET_PARAMETERS,
        title: {
          type: "string",
          description: "Short title for the side chat. Write it yourself from what was asked.",
        },
        message: { type: "string", description: "The first message to send into the side chat." },
      },
      required: ["thread", "title", "message"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "rename_thread",
    description:
      "Rename a thread. Use when the user asks for a clearer name, or when two threads share a title and they want them told apart. If you read the thread first to choose a fitting name, call this tool next instead of only proposing the name. Renaming is reversible and is applied without confirmation unless the target is ambiguous.",
    minAuthority: "send",
    requiresConfirmation: false,
    parameters: {
      type: "object",
      properties: {
        ...REASON_PARAMETER,
        ...CONFIRM_PARAMETER,
        ...THREAD_TARGET_PARAMETERS,
        title: {
          type: "string",
          description: "The new title. Keep it short and human — it is what the user will see.",
        },
      },
      required: ["thread", "title"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "settle_thread",
    description:
      "Mark a thread as settled — finished, dealt with, no longer needing attention. This records the state only: the thread stays exactly where it is in the sidebar and nothing is hidden, removed or archived. Reversible with undo.",
    minAuthority: "send",
    requiresConfirmation: false,
    parameters: {
      type: "object",
      properties: {
        ...REASON_PARAMETER,
        ...CONFIRM_PARAMETER,
        ...THREAD_TARGET_PARAMETERS,
        undo: {
          type: "boolean",
          description: "Set true to un-settle a thread that was marked settled before.",
        },
      },
      required: ["thread"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "update_thread_settings",
    description:
      "Change a thread's settings: the model it uses, its thinking effort, its access permissions, or whether it is in plan, agent or normal mode. Omit any field you are not changing. The change is applied for real — you do not need to ask permission to carry out what the user just asked for. You are only sent back for confirmation when it would widen the agent's access or stop a turn already running.",
    minAuthority: "full",
    requiresConfirmation: true,
    parameters: {
      type: "object",
      properties: {
        ...REASON_PARAMETER,
        ...CONFIRM_PARAMETER,
        ...THREAD_TARGET_PARAMETERS,
        model: {
          type: "string",
          description:
            'Model slug to switch to, for example "claude-opus-5". Omit to leave the model alone.',
        },
        provider: {
          type: "string",
          description:
            "Provider instance id, only when moving the thread to a different provider. Omit to keep the current one.",
        },
        effort: {
          type: "string",
          description:
            'Thinking effort, for example "low", "medium", "high", "xhigh" or "max". The valid values depend on the provider; a wrong one comes back with the list.',
        },
        accessMode: {
          type: "string",
          enum: ["approval-required", "auto-accept-edits", "auto", "full-access"],
          description:
            "Access permissions: approval-required (supervised), auto-accept-edits, auto, or full-access.",
        },
        interactionMode: {
          type: "string",
          enum: ["default", "plan", "agent"],
          description: "default (normal chat), plan (plan mode), or agent (autonomous agent mode).",
        },
        applyNow: {
          type: "boolean",
          description:
            "Defaults to true, which is almost always right: a model or effort change only reaches the agent once a turn runs, so this is what actually applies it. Set false only if the user explicitly wants the change queued for later — note that on a thread mid-turn, applying stops the turn in progress.",
        },
      },
      required: ["thread"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "interrupt_thread",
    description:
      "Interrupt a thread's in-flight turn, stopping the work it has in progress. Call once without `confirm` to find out exactly what would stop, read that back to the user, and only call again with confirm=true once they have said yes.",
    minAuthority: "full",
    requiresConfirmation: true,
    parameters: {
      type: "object",
      properties: {
        ...REASON_PARAMETER,
        ...CONFIRM_PARAMETER,
        ...THREAD_TARGET_PARAMETERS,
      },
      required: ["thread"],
      additionalProperties: false,
    },
  },
];

const AUTHORITY_RANK: Record<OrchestratorAuthority, number> = {
  "read-only": 0,
  send: 1,
  full: 2,
};

export const DESTRUCTIVE_TOOL_NAMES: ReadonlySet<string> = new Set(
  ORCHESTRATOR_TOOLS.filter((tool) => tool.minAuthority === "full").map((tool) => tool.name),
);

export function isToolAllowed(name: string, authority: OrchestratorAuthority): boolean {
  const tool = ORCHESTRATOR_TOOLS.find((candidate) => candidate.name === name);
  if (tool === undefined) return false;
  return AUTHORITY_RANK[authority] >= AUTHORITY_RANK[tool.minAuthority];
}

/** Wire-shaped definitions for the tools available at this authority. */
export function toolsForAuthority(authority: OrchestratorAuthority): ReadonlyArray<{
  readonly type: "function";
  readonly name: string;
  readonly description: string;
  readonly parameters: Record<string, unknown>;
}> {
  return ORCHESTRATOR_TOOLS.filter((tool) => isToolAllowed(tool.name, authority)).map((tool) => ({
    type: tool.type,
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
  }));
}

// ── Tool call log ────────────────────────────────────────────────

export interface OrchestratorToolLogEntry {
  readonly name: string;
  /** The model's own stated reason, when it supplied one. */
  readonly reason: string | null;
  readonly outcome: "ok" | "needs-confirmation" | "error";
  readonly detail: string;
  readonly durationMs: number;
  readonly at: string;
}

export const MAX_TOOL_LOG_ENTRIES = 25;
