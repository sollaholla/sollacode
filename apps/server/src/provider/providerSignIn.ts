import type { ServerProvider } from "@t3tools/contracts";

/**
 * The command that signs a provider's CLI in, or switches which account it
 * uses.
 *
 * Each entry was read from that CLI's own `--help` on a machine with it
 * installed, not from documentation: a sign-in command that does not exist is
 * worse than none, because the person pastes it and gets "unknown command"
 * with no idea whether the app or the CLI is wrong. Providers whose help has
 * no login verb are deliberately absent — Antigravity and the MCP bridge have
 * none, and Deep Code authenticates with an API key that already has its own
 * editor in this screen.
 */
const SIGN_IN_VERB_BY_DRIVER: Readonly<Record<string, string>> = {
  claudeAgent: "auth",
  codex: "login",
  grok: "login",
  muse: "login",
  // `opencode auth` is an alias of this; the canonical spelling is the one
  // its help prints.
  opencode: "providers",
};

/** The binary each driver invokes, when its name is not the driver's own. */
const BINARY_BY_DRIVER: Readonly<Record<string, string>> = {
  claudeAgent: "claude",
  cursor: "cursor-agent",
};

/**
 * Attach the sign-in command to a provider snapshot.
 *
 * Applied centrally rather than in each driver: the drivers build their auth
 * block at a dozen call sites between them, and a command that is only present
 * on some of those paths shows and hides itself as the provider re-probes.
 *
 * Left alone when the driver already set one, so a driver that knows its own
 * configured binary path wins over the default name guessed here.
 */
export function withProviderSignInCommand(provider: ServerProvider): ServerProvider {
  if (provider.auth.signInCommand !== undefined) {
    return provider;
  }
  const verb = SIGN_IN_VERB_BY_DRIVER[provider.driver];
  if (verb === undefined) {
    return provider;
  }
  const binary = BINARY_BY_DRIVER[provider.driver] ?? provider.driver;
  return { ...provider, auth: { ...provider.auth, signInCommand: `${binary} ${verb}` } };
}
