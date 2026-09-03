import type { SettingsSectionPath } from "./SettingsSidebarNav";

/**
 * One searchable setting. `tab` is the settings route that renders it and
 * `anchor` the row id on that page (derived from the row title unless the row
 * sets an explicit id), so a result can deep-link straight to the control.
 */
export interface SettingsSearchEntry {
  readonly title: string;
  readonly tab: SettingsSectionPath;
  readonly tabLabel: string;
  readonly section: string;
  readonly keywords?: ReadonlyArray<string>;
  readonly anchor?: string;
  /** Only meaningful when the desktop bridge exposes it. */
  readonly desktopOnly?: boolean;
}

/** Row id derived from a title: "Glass opacity" → "setting-glass-opacity". */
export function settingsRowAnchor(title: string): string {
  return `setting-${title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")}`;
}

function entries(
  tab: SettingsSectionPath,
  tabLabel: string,
  section: string,
  rows: ReadonlyArray<
    string | { title: string; keywords?: ReadonlyArray<string>; anchor?: string }
  >,
): SettingsSearchEntry[] {
  return rows.map((row) =>
    typeof row === "string"
      ? { title: row, tab, tabLabel, section }
      : {
          title: row.title,
          tab,
          tabLabel,
          section,
          ...(row.keywords ? { keywords: row.keywords } : {}),
          ...(row.anchor ? { anchor: row.anchor } : {}),
        },
  );
}

export const SETTINGS_SEARCH_INDEX: ReadonlyArray<SettingsSearchEntry> = [
  ...entries("/settings/general", "General", "Threads", [
    { title: "New threads", keywords: ["worktree", "local", "default mode", "draft"] },
    { title: "Start from origin", keywords: ["worktree", "branch", "remote"] },
    { title: "Resume unfinished threads on startup", keywords: ["resume", "restart", "crash"] },
    { title: "Auto-open task panel", keywords: ["plan", "tasks", "right panel"] },
    { title: "Archive confirmation", keywords: ["confirm", "archive"] },
    { title: "Delete confirmation", keywords: ["confirm", "delete", "history"] },
  ]),
  ...entries("/settings/general", "General", "Projects", [
    { title: "Project Grouping", keywords: ["sidebar", "repositories", "environments", "combine"] },
    { title: "Add project starts in", keywords: ["folder", "browser", "directory", "home"] },
  ]),
  ...entries("/settings/general", "General", "Models", [
    { title: "Utility AI model", keywords: ["titles", "task drafting", "plan", "text generation"] },
    { title: "Token Optimizer", keywords: ["claude", "context", "images", "roi", "tokens"] },
  ]),
  ...entries("/settings/general", "General", "Background work", [
    {
      title: "Background activity",
      anchor: "setting-background-activity",
      keywords: ["git refresh", "health probes", "policy", "intervals", "advanced"],
    },
    { title: "Attachment retention", keywords: ["images", "cleanup", "hours", "storage"] },
  ]),
  ...entries("/settings/general", "General", "Voice input", [
    { title: "Auto-send transcription", keywords: ["dictation", "push to talk", "microphone"] },
    {
      title: "Contextual transcription correction",
      keywords: ["dictation", "names", "punctuation", "speech"],
    },
    { title: "Voice correction model", keywords: ["dictation", "fast model", "speech"] },
  ]),
  ...entries("/settings/general", "General", "About", [
    { title: "Version", anchor: "setting-version", keywords: ["update track", "release", "about"] },
    { title: "Update track", keywords: ["nightly", "stable", "release channel"] },
    { title: "Diagnostics", keywords: ["tracing", "otlp", "logs", "performance", "spans"] },
  ]),
  ...entries("/settings/appearance", "Appearance", "Appearance", [
    { title: "Theme", keywords: ["dark", "light", "system", "colors"] },
    { title: "Glass opacity", keywords: ["transparency", "blur", "menus", "dialogs"] },
    { title: "Environment identification", keywords: ["dev", "nightly", "artwork", "pill"] },
  ]),
  ...entries("/settings/appearance", "Appearance", "Content", [
    { title: "Word wrap", keywords: ["code blocks", "diffs", "long lines", "tables"] },
    { title: "Time format", keywords: ["12-hour", "24-hour", "clock", "timestamps"] },
    { title: "Assistant output", keywords: ["streaming", "tokens", "live response"] },
    { title: "Hide whitespace changes", keywords: ["diff", "whitespace", "ignore"] },
  ]),
  ...entries("/settings/appearance", "Appearance", "Sound", [
    { title: "Sound cues", keywords: ["audio", "tones", "voice", "microphone", "beep"] },
    { title: "Cue volume", keywords: ["audio", "loudness", "sound"] },
    {
      title: "Mute system audio while listening",
      keywords: ["audio", "microphone", "push to talk", "macos"],
    },
  ]),
  ...entries("/settings/appearance", "Appearance", "Thread list", [
    { title: "Flat thread list", keywords: ["sidebar", "projects", "grouping"] },
    { title: "Auto-settle inactive threads", keywords: ["sidebar", "settle", "inactive", "tidy"] },
  ]),
  ...entries("/settings/keybindings", "Keybindings", "Keybindings", [
    {
      title: "Keybindings",
      anchor: "setting-keybindings",
      keywords: ["shortcuts", "hotkeys", "keyboard", "command", "terminal", "composer"],
    },
  ]),
  ...entries("/settings/providers", "Providers", "Providers", [
    {
      title: "Providers",
      anchor: "setting-providers",
      keywords: [
        "claude",
        "codex",
        "grok",
        "cursor",
        "opencode",
        "api key",
        "login",
        "cli",
        "models",
      ],
    },
    { title: "Health check interval", keywords: ["refresh", "availability", "versions", "probe"] },
  ]),
  ...entries("/settings/providers", "Providers", "Provider preferences", [
    { title: "Provider usage bar", keywords: ["quota", "usage", "limits", "composer"] },
    { title: "Provider update checks", keywords: ["cli", "versions", "upgrade"] },
  ]),
  ...entries("/settings/orchestrator", "Orchestrator", "Orchestrator", [
    { title: "Enable the orchestrator", keywords: ["voice", "assistant", "orb"] },
    { title: "Voice provider", keywords: ["openai", "grok", "realtime"] },
    { title: "OpenAI API key", keywords: ["voice", "credentials", "secret"] },
    { title: "Grok Voice API key", keywords: ["xai", "voice", "credentials", "secret"] },
    { title: "Voice", keywords: ["speaker", "tts", "tone"] },
    { title: "Language", keywords: ["locale", "speech", "transcription"] },
    { title: "Floating bubble", keywords: ["orb", "overlay", "window", "always on top"] },
    { title: "Model", anchor: "setting-model", keywords: ["realtime model", "voice model"] },
  ]),
  ...entries("/settings/orchestrator", "Orchestrator", "Interruptions", [
    { title: "Let me interrupt by talking over it", keywords: ["barge in", "interrupt"] },
  ]),
  ...entries("/settings/orchestrator", "Orchestrator", "Microphone", [
    { title: "Filter background noise", keywords: ["noise suppression", "microphone"] },
  ]),
  ...entries("/settings/orchestrator", "Orchestrator", "Usage", [
    { title: "Stop listening after silence", keywords: ["timeout", "idle", "microphone"] },
    { title: "Silence before stopping", keywords: ["timeout", "seconds"] },
    { title: "Come back when awaited work finishes", keywords: ["notify", "resume", "await"] },
  ]),
  ...entries("/settings/orchestrator", "Orchestrator", "Activation", [
    { title: "How to start talking", keywords: ["push to talk", "wake word", "hotkey"] },
    { title: "Wake word", keywords: ["hey", "activation phrase"] },
  ]),
  ...entries("/settings/orchestrator", "Orchestrator", "Authority", [
    { title: "What the orchestrator may do", keywords: ["permissions", "actions", "autonomy"] },
    { title: "Confirm destructive actions", keywords: ["safety", "confirm", "delete"] },
  ]),
  ...entries("/settings/agents", "Agents", "Agent Stack", [
    { title: "Enable Agent Stack", keywords: ["custom agents", "sidebar", "agents"] },
    { title: "Desktop agent alerts", keywords: ["notifications", "agents", "blockers"] },
  ]),
  ...entries("/settings/source-control", "Source Control", "Version Control", [
    {
      title: "Version Control",
      anchor: "setting-version-control",
      keywords: ["git", "github", "repositories", "scan", "remotes", "credentials"],
    },
    { title: "Server environment", keywords: ["git", "ssh", "credentials", "environment"] },
  ]),
  ...entries("/settings/source-control", "Source Control", "Text generation", [
    {
      title: "Source control writing style",
      keywords: ["commit messages", "pull requests", "tone"],
    },
    { title: "Follow change request templates", keywords: ["pull request template", "github"] },
    { title: "Source control writer model", keywords: ["commit messages", "model", "ai"] },
  ]),
  ...entries("/settings/connections", "Connections", "Connections", [
    {
      title: "Connect another device",
      keywords: ["pairing", "qr", "phone", "mobile", "tailscale", "remote"],
    },
    {
      title: "Advanced connection settings",
      keywords: ["port", "https", "tailscale", "network", "listen"],
    },
    { title: "Administrative access", keywords: ["admin", "sessions", "devices", "revoke"] },
    { title: "Remote environments", keywords: ["ssh", "wsl", "windows", "servers", "hosts"] },
    { title: "WSL backend", keywords: ["windows", "linux", "distro"] },
  ]),
  ...entries("/settings/archived", "Archive", "Archived threads", [
    {
      title: "Archived threads",
      anchor: "setting-archived-threads",
      keywords: ["restore", "unarchive", "history", "old threads"],
    },
  ]),
  {
    title: "Permissions",
    tab: "/settings/permissions",
    tabLabel: "Permissions",
    section: "Permissions",
    anchor: "setting-permissions",
    keywords: ["microphone", "screen recording", "accessibility", "macos", "privacy"],
    desktopOnly: true,
  },
];

export interface SettingsSearchResult extends SettingsSearchEntry {
  readonly anchorId: string;
  readonly score: number;
}

function normalize(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/**
 * Rank settings for a query: title prefix > title word > title substring >
 * section/tab > keyword. Every query token must hit somewhere. Empty query
 * returns nothing so the sidebar can fall back to the plain tab list.
 */
export function searchSettings(
  query: string,
  index: ReadonlyArray<SettingsSearchEntry> = SETTINGS_SEARCH_INDEX,
  options: { readonly includeDesktopOnly?: boolean } = {},
): SettingsSearchResult[] {
  const tokens = normalize(query).split(" ").filter(Boolean);
  if (tokens.length === 0) return [];
  const results: SettingsSearchResult[] = [];
  for (const entry of index) {
    if (entry.desktopOnly && !options.includeDesktopOnly) continue;
    const title = normalize(entry.title);
    const context = normalize(`${entry.section} ${entry.tabLabel}`);
    const keywords = (entry.keywords ?? []).map(normalize);
    let score = 0;
    let matchedAll = true;
    for (const token of tokens) {
      if (title.startsWith(token)) score += 40;
      else if (title.split(" ").some((word) => word.startsWith(token))) score += 30;
      else if (title.includes(token)) score += 20;
      else if (context.includes(token)) score += 10;
      else if (keywords.some((keyword) => keyword.includes(token))) score += 8;
      else {
        matchedAll = false;
        break;
      }
    }
    if (!matchedAll) continue;
    results.push({ ...entry, anchorId: entry.anchor ?? settingsRowAnchor(entry.title), score });
  }
  return results.sort(
    (left, right) => right.score - left.score || left.title.localeCompare(right.title),
  );
}
