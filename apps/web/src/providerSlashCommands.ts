import type { ServerProviderSlashCommand } from "@t3tools/contracts";

/** Commands Solla Code handles itself; typing one never reaches the provider. */
const APP_SLASH_COMMAND_NAMES: ReadonlySet<string> = new Set([
  "model",
  "plan",
  "default",
  "refresh-plan",
]);

const LEADING_SLASH_COMMAND_PATTERN = /^(\s*)\/([^\s/]+)(?=\s|$)/u;

export interface LeadingProviderSlashCommand {
  readonly command: ServerProviderSlashCommand;
  /** Offset of the `/` in the text. */
  readonly start: number;
  /** Offset just past the command name. */
  readonly end: number;
}

/**
 * The provider command a message opens with, if any. A provider runs a slash
 * command only when the message starts with it — the rest of the message is
 * its argument — so a `/name` anywhere later is ordinary text and is never
 * reported here.
 */
export function findLeadingProviderSlashCommand(
  text: string,
  commands: ReadonlyArray<ServerProviderSlashCommand>,
): LeadingProviderSlashCommand | null {
  if (commands.length === 0) return null;
  const match = LEADING_SLASH_COMMAND_PATTERN.exec(text);
  if (!match) return null;
  const name = match[2] ?? "";
  if (APP_SLASH_COMMAND_NAMES.has(name.toLowerCase())) return null;
  const command = commands.find((candidate) => candidate.name === name);
  if (!command) return null;
  const start = (match[1] ?? "").length;
  return { command, start, end: start + 1 + name.length };
}

/** What a command does, in the provider's own words when it gave any. */
export function describeProviderSlashCommand(command: ServerProviderSlashCommand): string {
  return command.description ?? "Runs a command in the provider.";
}
