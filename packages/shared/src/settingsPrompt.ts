export const SETTINGS_UPDATE_MESSAGE_PREFIX = "Settings updated:";

const SETTINGS_UPDATE_MESSAGE_INSTRUCTION =
  "Apply these settings immediately and continue the current task without waiting for another message.";

export function buildSettingsUpdatePrompt(description: string): string {
  return `${SETTINGS_UPDATE_MESSAGE_PREFIX} ${description}. ${SETTINGS_UPDATE_MESSAGE_INSTRUCTION}`;
}

export function isSettingsUpdatePrompt(text: string): boolean {
  return text.startsWith(SETTINGS_UPDATE_MESSAGE_PREFIX);
}

/**
 * The human-readable settings description of an app-authored settings-update
 * prompt, or null when the text is not one. Tolerates persisted legacy turns
 * whose trailing instruction wording drifted between builds.
 */
export function parseSettingsUpdatePrompt(text: string): { description: string } | null {
  if (!isSettingsUpdatePrompt(text)) return null;
  const rest = text.slice(SETTINGS_UPDATE_MESSAGE_PREFIX.length).trim();
  const instructionIndex = rest.indexOf(". Apply these settings immediately");
  const description = instructionIndex === -1 ? rest : rest.slice(0, instructionIndex);
  return { description: description.trim() };
}
