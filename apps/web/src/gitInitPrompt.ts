/**
 * Prompt construction for AI-assisted `git init`.
 *
 * A plain `git init` produces a repository that knows nothing about the project
 * it now tracks — no `.gitignore`, so the first `git add` sweeps up
 * `node_modules`, build output, and whatever secrets happen to be on disk. The
 * assisted path asks a provider to read the project first and set the
 * repository up to match it.
 *
 * The instructions are seeded into an editable field rather than hidden behind
 * the button, so "generate it from my project" and "do exactly this instead"
 * are the same control.
 */

export const DEFAULT_GIT_INIT_INSTRUCTIONS = [
  "Set this project up as a Git repository properly, based on what is actually in it.",
  "",
  "1. Survey the project and every folder inside it to identify the languages, frameworks, package managers, and build tools in use.",
  "2. Write a `.gitignore` covering what this project actually generates — dependency directories, build and cache output, editor and OS files, logs, and local environment or secret files. Do not paste a generic template for a stack that is not present.",
  "3. If there is no README, write a short one describing what the project is and how to run it.",
  "4. Stage the files that belong in version control and make one initial commit with a descriptive message.",
  "",
  "Do not commit anything that should be ignored, and do not commit credentials.",
].join("\n");

/**
 * How the repository gets created.
 *
 * `plain` is the original button behaviour, kept as a first-class choice
 * because the assisted path costs a provider turn and is not always wanted.
 */
export type GitInitMode = "plain" | "assisted";

/**
 * Wraps the user's instructions with the target directory.
 *
 * The path is stated explicitly because the provider's working directory is not
 * necessarily the folder the button was pressed for, and a repository created
 * one level up is tedious to undo.
 */
export function buildGitInitPrompt(input: {
  readonly cwd: string;
  readonly instructions: string;
  readonly alreadyInitialized: boolean;
}): string {
  const instructions = input.instructions.trim();
  const opening = input.alreadyInitialized
    ? `The Git repository at \`${input.cwd}\` has just been initialized and has no commits yet.`
    : `Initialize a Git repository at \`${input.cwd}\`.`;
  return `${opening}\n\n${instructions}`;
}

/**
 * Whether the assisted action can run.
 *
 * Empty instructions are rejected rather than silently swapped for the default:
 * a user who cleared the field is asking for something, and sending the text
 * they just deleted would be the one outcome they ruled out.
 */
export function canRunAssistedGitInit(input: {
  readonly cwd: string | null;
  readonly instructions: string;
  readonly busy: boolean;
}): boolean {
  return (
    input.cwd !== null &&
    input.cwd.length > 0 &&
    input.instructions.trim().length > 0 &&
    !input.busy
  );
}

/**
 * Whether the plain action can run. Unlike the assisted path this needs no
 * instructions, so a cleared field must not disable it.
 */
export function canRunPlainGitInit(input: {
  readonly cwd: string | null;
  readonly busy: boolean;
}): boolean {
  return input.cwd !== null && input.cwd.length > 0 && !input.busy;
}
