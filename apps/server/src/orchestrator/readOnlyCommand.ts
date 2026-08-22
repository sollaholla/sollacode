/**
 * Running a shell command for the voice orchestrator.
 *
 * The orchestrator can look around the machine — list a directory, read a file,
 * grep a tree, ask git what it thinks — so it can answer questions about the
 * computer instead of telling the user to go and look.
 *
 * **Read-only is an instruction, not a gate.** An allowlist of "safe" binaries
 * was tried and thrown away: the boundary between reading and writing is gray
 * in practice (a build that writes a cache, a formatter with `--check`, a tool
 * whose read mode is a flag), and a list strict enough to be meaningful blocked
 * most of what the feature exists to do. The model is told to stay read-only
 * and is trusted with that, exactly as it is trusted with every other tool.
 *
 * What remains is a much narrower guard: commands whose damage cannot be undone
 * and cannot be meant. This is not a permission boundary — anything determined
 * enough gets past it — it is a guard against a mis-transcribed sentence
 * wiping a disk, which is a real failure mode when the input arrives by voice.
 */

/**
 * Patterns that destroy something no backup or undo brings back.
 *
 * Deliberately tiny and specific. Every entry is something that is never a step
 * in exploring a machine, so refusing it costs the feature nothing.
 */
const CATASTROPHIC_PATTERNS: ReadonlyArray<{
  readonly pattern: RegExp;
  readonly reason: string;
}> = [
  {
    // `rm -rf /`, `rm -rf ~`, `rm -fr /*` — recursive force at a filesystem root.
    pattern: /\brm\s+(-[a-z]*[rf][a-z]*\s+)+(\/|~|\$HOME|\/\*|\.\s*$)/i,
    reason: "That would recursively delete a filesystem root.",
  },
  {
    pattern: /\bmkfs(\.\w+)?\b/i,
    reason: "That would format a filesystem.",
  },
  {
    pattern: /\bdd\b[^\n]*\bof=\/dev\//i,
    reason: "That would write directly to a device.",
  },
  {
    pattern: />\s*\/dev\/(sd|nvme|disk|hd)/i,
    reason: "That would overwrite a raw disk.",
  },
  {
    pattern: /\b(shutdown|reboot|halt|poweroff)\b/i,
    reason: "That would shut the machine down mid-conversation.",
  },
  {
    // The classic fork bomb, in its usual spellings.
    pattern: /:\(\)\s*\{.*\|.*&.*\}\s*;?\s*:/,
    reason: "That is a fork bomb.",
  },
  {
    pattern: /\bdiskutil\s+(erase|reformat|partitionDisk)/i,
    reason: "That would erase a disk.",
  },
];

export type CommandAssessment =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: string };

/** How long a command may run before it is killed. */
export const COMMAND_TIMEOUT_MS = 20_000;
/** Output beyond this is truncated — it is being read aloud, after all. */
export const COMMAND_MAX_OUTPUT_BYTES = 64 * 1024;
const MAX_COMMAND_LENGTH = 2_000;

export function assessCommand(raw: string): CommandAssessment {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return { ok: false, reason: "No command was given." };
  if (trimmed.length > MAX_COMMAND_LENGTH) {
    return { ok: false, reason: "That command is too long to run." };
  }

  for (const entry of CATASTROPHIC_PATTERNS) {
    if (entry.pattern.test(trimmed)) {
      return { ok: false, reason: entry.reason };
    }
  }

  return { ok: true };
}
