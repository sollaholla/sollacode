export const RESUME_PROMPT =
  "Please resume your current task using the context provided and pick up exactly where you left off.";

const LEGACY_RESUME_PROMPT = "resume";

/** True for app-authored resume prompts, including already-persisted legacy turns. */
export function isResumePrompt(text: string): boolean {
  return text === RESUME_PROMPT || text === LEGACY_RESUME_PROMPT;
}
