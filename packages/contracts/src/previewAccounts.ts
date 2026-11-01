import * as Schema from "effect/Schema";

import { EnvironmentId, ThreadId } from "./baseSchemas.ts";

/**
 * Whose cookies, logins and cache a browser tab uses: its project's, or one
 * agent's own. Every thread in a project shares the project's; an agent's chat,
 * side chats and scheduled tasks share that agent's.
 */
export const PreviewBrowserProfile = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("project"), projectId: Schema.String }),
  Schema.Struct({ kind: Schema.Literal("agent"), rootThreadId: ThreadId }),
]);
export type PreviewBrowserProfile = typeof PreviewBrowserProfile.Type;

/** What exists right now, which is how the desktop tells a live profile from a dead one. */
export const PreviewBrowserProfileInventory = Schema.Struct({
  environmentId: EnvironmentId,
  projects: Schema.Array(
    Schema.Struct({ projectId: Schema.String, threadIds: Schema.Array(ThreadId) }),
  ),
  agentRootThreadIds: Schema.Array(ThreadId),
  /** Every environment this desktop hosts browsers for, reported or not. */
  hostedEnvironmentIds: Schema.Array(EnvironmentId),
});
export type PreviewBrowserProfileInventory = typeof PreviewBrowserProfileInventory.Type;

export const PreviewAccountProvider = Schema.Literals(["google", "github", "microsoft", "apple"]);
export type PreviewAccountProvider = typeof PreviewAccountProvider.Type;

export const PreviewAccountOwner = Schema.Struct({
  environmentId: Schema.String,
  kind: Schema.Literals(["project", "agent"]),
  ownerId: Schema.String,
});
export type PreviewAccountOwner = typeof PreviewAccountOwner.Type;

/** One account signed in to one profile. `identity` is null when the site does not say who. */
export const PreviewAccountSession = Schema.Struct({
  provider: PreviewAccountProvider,
  identity: Schema.NullOr(Schema.String),
  /** False when the cookies are there but the site says the session has ended. */
  live: Schema.Boolean,
  directory: Schema.String,
  owner: PreviewAccountOwner,
  linked: Schema.Boolean,
});
export type PreviewAccountSession = typeof PreviewAccountSession.Type;

export const PreviewAccountEventReason = Schema.Literals([
  "signed-in",
  "signed-out",
  "session-ended",
]);
export type PreviewAccountEventReason = typeof PreviewAccountEventReason.Type;

export const PreviewAccountEvent = Schema.Struct({
  at: Schema.String,
  provider: PreviewAccountProvider,
  reason: PreviewAccountEventReason,
  identity: Schema.NullOr(Schema.String),
  directory: Schema.String,
  owner: Schema.NullOr(PreviewAccountOwner),
  /** How Chromium says the session cookie went away; absent for a site-reported end. */
  cookieCause: Schema.optionalKey(Schema.String),
});
export type PreviewAccountEvent = typeof PreviewAccountEvent.Type;

export const PreviewAccountsSnapshot = Schema.Struct({
  sessions: Schema.Array(PreviewAccountSession),
  recentEvents: Schema.Array(PreviewAccountEvent),
  profileCount: Schema.Number,
  retiredProfileCount: Schema.Number,
  /** Profiles whose stored cookies are confirmed encrypted. */
  encryptedProfileCount: Schema.Number,
});
export type PreviewAccountsSnapshot = typeof PreviewAccountsSnapshot.Type;

export const PreviewAccountSignOutInput = Schema.Struct({
  provider: PreviewAccountProvider,
  directory: Schema.String,
});
export type PreviewAccountSignOutInput = typeof PreviewAccountSignOutInput.Type;

export const PreviewAccountLinkInput = Schema.Struct({
  provider: PreviewAccountProvider,
  fromDirectory: Schema.String,
  environmentId: EnvironmentId,
  to: PreviewBrowserProfile,
});
export type PreviewAccountLinkInput = typeof PreviewAccountLinkInput.Type;

/**
 * A question shown on a browser tab about signing in. Passwords never appear
 * here: a captured one stays in the desktop process until the answer.
 */
export const PreviewAccountPrompt = Schema.Union([
  Schema.Struct({
    id: Schema.String,
    kind: Schema.Literal("remember"),
    origin: Schema.String,
    username: Schema.String,
    /** A login for this name is already saved with a different password. */
    update: Schema.Boolean,
  }),
  Schema.Struct({
    id: Schema.String,
    kind: Schema.Literal("use-account"),
    provider: PreviewAccountProvider,
    identity: Schema.NullOr(Schema.String),
    fromDirectory: Schema.String,
    fromOwner: PreviewAccountOwner,
  }),
  Schema.Struct({
    id: Schema.String,
    kind: Schema.Literal("fill-saved"),
    credentialId: Schema.String,
    origin: Schema.String,
    username: Schema.String,
  }),
]);
export type PreviewAccountPrompt = typeof PreviewAccountPrompt.Type;

export const PreviewAccountPromptAnswer = Schema.Literals(["accept", "dismiss", "never-for-site"]);
export type PreviewAccountPromptAnswer = typeof PreviewAccountPromptAnswer.Type;
