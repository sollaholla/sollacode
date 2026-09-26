/**
 * Claude banked usage-limit resets ("cedar_ember" in the Claude CLI).
 *
 * Claude.ai subscribers can be granted a small bank of resets that clear the
 * current usage limits on demand. The CLI reads the bank from the OAuth usage
 * endpoint and redeems one with `/reset-limits`; this module does the same two
 * requests with the CLI's own stored sign-in so the reset shows in the usage
 * card and can be redeemed from there.
 *
 * The stored OAuth token is only ever read. Refreshing it would rotate the
 * refresh token under the CLI and sign it out, so an expired token simply
 * means "unknown" until the CLI refreshes it on its next turn.
 *
 * The status endpoint is rate-limited per account, so reads go through
 * `makeClaudeBankedResetCache` and never follow the 60 s health refresh.
 *
 * @module provider/Drivers/ClaudeBankedResets
 */
// @effect-diagnostics nodeBuiltinImport:off
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as NodeCrypto from "node:crypto";
import * as NodeOS from "node:os";

import type { ProviderUsageResetOutcome } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Predicate from "effect/Predicate";
import * as Ref from "effect/Ref";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";
import { ChildProcess } from "effect/unstable/process";

import { spawnAndCollect } from "../providerSnapshot.ts";

const API_BASE_URL = "https://api.anthropic.com";
const OAUTH_BETA = "oauth-2025-04-20";
const PROGRAM = "cedar_ember";
const GRANT_ID_PATTERN = /^[a-z0-9_-]{1,40}$/;
const REQUEST_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const KEYCHAIN_USER_PATTERN = /^[a-zA-Z0-9._-]+$/;

/** Minimum time between successful status reads for one provider instance. */
export const CLAUDE_BANKED_RESET_REFRESH_MS = 10 * 60_000;
/** Back-off after the status endpoint answers 429. */
export const CLAUDE_BANKED_RESET_RATE_LIMIT_BACKOFF_MS = 15 * 60_000;
/**
 * Wait between a health check and the bank read it schedules. The check's own
 * CLI probe reads the same per-account-limited usage endpoint (every other
 * check, through the CLI's shared snapshot); reading right behind it drew 429s,
 * so the bank read waits half a health interval. Refusals are still possible
 * and back off; the refusal body is traced on the read's span.
 */
export const CLAUDE_BANKED_RESET_READ_DELAY_MS = 30_000;
/** Back-off after a network error, timeout, or unreadable answer. */
export const CLAUDE_BANKED_RESET_FAILURE_BACKOFF_MS = 5 * 60_000;

/** Same shape Codex reports, so the usage card renders both the same way. */
export interface ClaudeResetCredits {
  readonly availableCount: number;
  readonly credits: ReadonlyArray<{
    readonly id: string;
    readonly status: "available";
    readonly title: string;
    readonly description: string | null;
    readonly expiresAt: string | null;
  }>;
}

export interface ClaudeOAuthCredentials {
  readonly accessToken: string;
  readonly organizationUuid: string | null;
}

type Environment = Readonly<Record<string, string | undefined>>;

// ── Credentials ──────────────────────────────────────────────────

function configDirOverride(environment: Environment): string | undefined {
  return environment.CLAUDE_CONFIG_DIR?.trim() || undefined;
}

/** Keychain service name the CLI stores its OAuth sign-in under. */
export function claudeCredentialsServiceName(environment: Environment): string {
  const configDir =
    environment.CLAUDE_SECURESTORAGE_CONFIG_DIR?.trim() || configDirOverride(environment);
  if (!configDir) return "Claude Code-credentials";
  const suffix = NodeCrypto.createHash("sha256")
    .update(configDir.normalize("NFC"))
    .digest("hex")
    .slice(0, 8);
  return `Claude Code-credentials-${suffix}`;
}

export function claudeKeychainAccount(environment: Environment): string {
  const user = environment.USER ?? "";
  return KEYCHAIN_USER_PATTERN.test(user) ? user : "claude-code-user";
}

/** Returns a usable access token, or null when missing, expired, or under-scoped. */
export function parseClaudeStoredCredentials(raw: string, nowMs: number): string | null {
  const text = raw.trim();
  const json =
    /^[0-9a-f]+$/i.test(text) && text.length % 2 === 0
      ? Buffer.from(text, "hex").toString("utf8")
      : text;
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  const oauth = Predicate.isObject(parsed) ? parsed.claudeAiOauth : undefined;
  if (!Predicate.isObject(oauth)) return null;
  const { accessToken, expiresAt, scopes } = oauth;
  if (typeof accessToken !== "string" || accessToken.length === 0) return null;
  if (typeof expiresAt === "number" && expiresAt <= nowMs) return null;
  if (!Array.isArray(scopes) || !scopes.includes("user:profile")) return null;
  return accessToken;
}

export function parseClaudeOrganizationUuid(raw: string): string | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    const account = Predicate.isObject(parsed) ? parsed.oauthAccount : undefined;
    const uuid = Predicate.isObject(account) ? account.organizationUuid : undefined;
    return typeof uuid === "string" && /^[0-9a-f-]{36}$/i.test(uuid) ? uuid : null;
  } catch {
    return null;
  }
}

const readTextFile = (path: string) =>
  FileSystem.FileSystem.pipe(
    Effect.flatMap((fileSystem) => fileSystem.readFileString(path)),
    Effect.orElseSucceed(() => null),
  );

const readKeychainCredentials = (environment: Environment) =>
  spawnAndCollect(
    "/usr/bin/security",
    ChildProcess.make("/usr/bin/security", [
      "find-generic-password",
      "-a",
      claudeKeychainAccount(environment),
      "-w",
      "-s",
      claudeCredentialsServiceName(environment),
    ]),
  ).pipe(
    Effect.map((result) => (result.code === 0 ? result.stdout : null)),
    Effect.timeout("5 seconds"),
    Effect.orElseSucceed(() => null),
  );

/**
 * Reads the Claude CLI's stored sign-in without ever refreshing it. macOS keeps
 * it in the login keychain (written by `/usr/bin/security`, so reading it with
 * the same tool never prompts); elsewhere it is `.credentials.json`.
 */
export const readClaudeOAuthCredentials = Effect.fn("readClaudeOAuthCredentials")(function* (
  environment: Environment,
) {
  const path = yield* Path.Path;
  const configDir = configDirOverride(environment);
  const home = NodeOS.homedir();
  const stored =
    ((yield* HostProcessPlatform) === "darwin"
      ? yield* readKeychainCredentials(environment)
      : null) ??
    (yield* readTextFile(path.join(configDir ?? path.join(home, ".claude"), ".credentials.json")));
  if (stored === null) return null;
  const accessToken = parseClaudeStoredCredentials(stored, yield* Clock.currentTimeMillis);
  if (accessToken === null) return null;
  const globalConfig = yield* readTextFile(path.join(configDir ?? home, ".claude.json"));
  return {
    accessToken,
    organizationUuid: globalConfig === null ? null : parseClaudeOrganizationUuid(globalConfig),
  } satisfies ClaudeOAuthCredentials;
});

// ── Status ───────────────────────────────────────────────────────

function positiveInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : null;
}

const claudeResetTitle = (count: number) =>
  count === 1 ? "Usage limit reset" : `${count} usage limit resets`;

/**
 * Normalizes the usage endpoint's `cedar_ember` block.
 *
 * - `undefined`: the answer was unreadable, so nothing is known.
 * - `null`: the account has no redeemable reset (not offered, ineligible,
 *   none left, or the next grant is paused).
 *
 * Only the grant the server names as next is listed: redeeming any other one
 * is refused with `not_next_grant`.
 */
export function normalizeClaudeBankedResets(body: unknown): ClaudeResetCredits | null | undefined {
  if (!Predicate.isObject(body) || Object.keys(body).length === 0) return undefined;
  const program = body[PROGRAM];
  if (program === undefined || program === null) return null;
  if (!Predicate.isObject(program)) return undefined;
  if (program.eligible !== true) return null;
  const nextGrantId = program.next_grant_id;
  if (typeof nextGrantId !== "string" || !GRANT_ID_PATTERN.test(nextGrantId)) return null;
  const grant = (Array.isArray(program.grants) ? program.grants : []).find(
    (candidate: unknown) => Predicate.isObject(candidate) && candidate.id === nextGrantId,
  );
  if (!Predicate.isObject(grant) || grant.paused === true) return null;
  const resetsLeft = positiveInteger(grant.resets_left);
  if (resetsLeft === null) return null;
  const label = typeof grant.label === "string" ? grant.label.trim() : "";
  const waitsForLimit = grant.use_requires_limit !== false && grant.usable_now !== true;
  return {
    availableCount: resetsLeft,
    credits: [
      {
        id: nextGrantId,
        status: "available",
        title: label || claudeResetTitle(resetsLeft),
        description: waitsForLimit ? "Usable once you reach a usage limit." : null,
        expiresAt: typeof grant.ends_at === "string" ? grant.ends_at : null,
      },
    ],
  };
}

/** Traces why a bank read shows what it shows, without grant ids. */
export function describeBankedResetBody(body: unknown): string {
  const program = Predicate.isObject(body) ? body[PROGRAM] : undefined;
  if (!Predicate.isObject(program)) return `program=${program === null ? "null" : typeof program}`;
  const grants = Array.isArray(program.grants) ? program.grants.filter(Predicate.isObject) : [];
  return [
    `eligible=${String(program.eligible)}`,
    `ineligible_reason=${String(program.ineligible_reason ?? "")}`,
    `grants=${grants.length}`,
    `next_grant=${typeof program.next_grant_id === "string"}`,
    `resets_left=${grants.map((grant) => String(grant.resets_left)).join("/")}`,
    `paused=${grants.map((grant) => String(grant.paused === true)).join("/")}`,
  ].join(" ");
}

export type ClaudeBankedResetRead =
  | { readonly status: "ok"; readonly credits: ClaudeResetCredits | null }
  | { readonly status: "signedOut" }
  | { readonly status: "rateLimited" }
  | { readonly status: "failed" };

/**
 * Headers the CLI itself sends. Anthropic decides eligibility by surface and
 * CLI version (`ineligible_reason: "surface" | "cli_version"`), which it reads
 * from the user agent.
 */
export const claudeCliUserAgent = (cliVersion: string) =>
  `claude-cli/${cliVersion} (external, cli)`;

const authorized = (
  request: HttpClientRequest.HttpClientRequest,
  accessToken: string,
  cliVersion: string,
) =>
  request.pipe(
    HttpClientRequest.bearerToken(accessToken),
    HttpClientRequest.setHeader("anthropic-beta", OAUTH_BETA),
    HttpClientRequest.setHeader("user-agent", claudeCliUserAgent(cliVersion)),
  );

export const fetchClaudeBankedResets = Effect.fn("fetchClaudeBankedResets")(
  function* (accessToken: string, cliVersion: string) {
    const response = yield* HttpClient.execute(
      authorized(
        HttpClientRequest.get(`${API_BASE_URL}/api/oauth/usage`).pipe(
          HttpClientRequest.setUrlParams({ cedar_ember: "1", skip_spend: "1" }),
          HttpClientRequest.setHeader("content-type", "application/json"),
        ),
        accessToken,
        cliVersion,
      ),
    );
    if (response.status !== 200) {
      // The refusal body is short and names the limit or the ineligibility.
      const body = yield* response.text.pipe(Effect.orElseSucceed(() => ""));
      yield* Effect.annotateCurrentSpan("claude.bankedResets.refusal", body.slice(0, 500));
      yield* Effect.logWarning("Claude banked reset read refused", {
        status: response.status,
        body: body.slice(0, 500),
      });
    }
    if (response.status === 429) return { status: "rateLimited" } as const;
    if (response.status === 401 || response.status === 403) return { status: "signedOut" } as const;
    if (response.status !== 200) return { status: "failed" } as const;
    const body = yield* response.json;
    const credits = normalizeClaudeBankedResets(body);
    yield* Effect.annotateCurrentSpan("claude.bankedResets.summary", describeBankedResetBody(body));
    return credits === undefined
      ? ({ status: "failed" } as const)
      : ({ status: "ok", credits } as const);
  },
  (effect) =>
    effect.pipe(
      Effect.timeout("5 seconds"),
      Effect.orElseSucceed((): ClaudeBankedResetRead => ({ status: "failed" })),
    ),
);

/**
 * Serves the last known bank and re-reads it at most every
 * `CLAUDE_BANKED_RESET_REFRESH_MS`, longer after a 429 or failure. A failed
 * read keeps the last answer rather than making a reset vanish from the card.
 *
 * `current` never waits on the network: a due read runs in the background
 * `CLAUDE_BANKED_RESET_READ_DELAY_MS` later and lands in the next health check.
 * Must be built in the provider instance's scope, which owns that read.
 */
export const makeClaudeBankedResetCache = <R>(
  read: Effect.Effect<ClaudeBankedResetRead, never, R>,
) =>
  Effect.gen(function* () {
    const scope = yield* Effect.scope;
    // `nextReadAt` is +Infinity while a read is in flight and 0 once invalidated.
    const state = yield* Ref.make<{
      readonly credits: ClaudeResetCredits | null | undefined;
      readonly nextReadAt: number;
    }>({ credits: undefined, nextReadAt: 0 });

    const refresh = Effect.gen(function* () {
      const result = yield* read;
      const now = yield* Clock.currentTimeMillis;
      yield* Ref.update(state, (cached) => {
        const credits =
          result.status === "ok"
            ? result.credits
            : result.status === "signedOut"
              ? undefined
              : cached.credits;
        const wait =
          result.status === "ok" || result.status === "signedOut"
            ? CLAUDE_BANKED_RESET_REFRESH_MS
            : result.status === "rateLimited"
              ? CLAUDE_BANKED_RESET_RATE_LIMIT_BACKOFF_MS
              : CLAUDE_BANKED_RESET_FAILURE_BACKOFF_MS;
        // A redeem during the read asked for a fresh answer; keep that ask.
        return { credits, nextReadAt: cached.nextReadAt === 0 ? 0 : now + wait };
      });
    });

    const current = Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      const { credits, due } = yield* Ref.modify(state, (cached) =>
        now < cached.nextReadAt
          ? [{ credits: cached.credits, due: false }, cached]
          : [
              { credits: cached.credits, due: true },
              { ...cached, nextReadAt: Number.POSITIVE_INFINITY },
            ],
      );
      if (due) {
        yield* refresh.pipe(Effect.delay(CLAUDE_BANKED_RESET_READ_DELAY_MS), Effect.forkIn(scope));
      }
      return credits;
    });

    return {
      current,
      /** Takes a redeemed reset off the bank at once and re-reads it soon. */
      spend: (grantId: string) =>
        Ref.update(state, (cached) => ({
          credits: spendClaudeResetCredit(cached.credits, grantId),
          nextReadAt: 0,
        })),
      /** Schedules a re-read at the next `current` (used after any redeem attempt). */
      invalidate: Ref.update(state, (cached) => ({ ...cached, nextReadAt: 0 })),
    };
  });

/** The bank after one reset of `grantId` is used; other grants are left alone. */
export function spendClaudeResetCredit(
  credits: ClaudeResetCredits | null | undefined,
  grantId: string,
): ClaudeResetCredits | null | undefined {
  const credit = credits?.credits[0];
  if (!credits || credit?.id !== grantId) return credits;
  const left = credits.availableCount - 1;
  if (left <= 0) return null;
  return {
    availableCount: left,
    credits: [
      {
        ...credit,
        title:
          credit.title === claudeResetTitle(credits.availableCount)
            ? claudeResetTitle(left)
            : credit.title,
      },
    ],
  };
}

/** Adds the bank to a Claude account-usage envelope; unknown leaves it untouched. */
export function withClaudeResetCredits(
  accountUsage: unknown,
  credits: ClaudeResetCredits | null | undefined,
): unknown {
  if (credits === undefined || !Predicate.isObject(accountUsage)) return accountUsage;
  return {
    ...accountUsage,
    rateLimitResetCredits: credits ?? { availableCount: 0, credits: [] },
  };
}

// ── Redeem ───────────────────────────────────────────────────────

export class ClaudeBankedResetError extends Error {
  override readonly name = "ClaudeBankedResetError";
}

/** Maps the claim answer; `undefined` means the outcome is not confirmed. */
export function claudeBankedResetOutcome(body: unknown): ProviderUsageResetOutcome | undefined {
  if (!Predicate.isObject(body) || typeof body.result !== "string") return undefined;
  // The reset may or may not have landed; re-sending the same request id is
  // the safe way to find out, so these must not read as "no credit".
  if (body.reason === "stamp_indeterminate" || body.reason === "reset_unconfirmed") {
    return undefined;
  }
  switch (body.result) {
    case "reset":
      return "reset";
    case "not_limited":
      return "nothingToReset";
    case "already_used":
      return "alreadyRedeemed";
    default:
      return "noCredit";
  }
}

export const claimClaudeBankedReset = Effect.fn("claimClaudeBankedReset")(
  function* (input: {
    readonly credentials: ClaudeOAuthCredentials;
    readonly cliVersion: string;
    readonly grantId: string;
    readonly requestId: string;
  }) {
    if (!GRANT_ID_PATTERN.test(input.grantId)) {
      return yield* Effect.fail(new ClaudeBankedResetError("That Claude reset id is not valid."));
    }
    if (!REQUEST_ID_PATTERN.test(input.requestId)) {
      return yield* Effect.fail(new ClaudeBankedResetError("The reset request id is not valid."));
    }
    const organizationUuid = input.credentials.organizationUuid;
    if (organizationUuid === null) {
      return yield* Effect.fail(
        new ClaudeBankedResetError("Claude's organization could not be read from its sign-in."),
      );
    }
    const response = yield* HttpClient.execute(
      authorized(
        HttpClientRequest.post(
          `${API_BASE_URL}/api/organizations/${organizationUuid}/reset_rate_limits`,
        ),
        input.credentials.accessToken,
        input.cliVersion,
      ).pipe(
        HttpClientRequest.bodyJsonUnsafe({
          program: PROGRAM,
          grant_id: input.grantId,
          request_id: input.requestId,
        }),
      ),
    );
    if (response.status === 429) {
      return yield* Effect.fail(
        new ClaudeBankedResetError("Claude is rate limiting reset requests. Try again shortly."),
      );
    }
    if (response.status === 401 || response.status === 403) {
      return yield* Effect.fail(
        new ClaudeBankedResetError(
          "Claude rejected its stored sign-in. Sign in again, then retry.",
        ),
      );
    }
    const outcome = claudeBankedResetOutcome(yield* response.json);
    if (outcome === undefined) {
      return yield* Effect.fail(new ClaudeBankedResetError("Claude did not confirm the reset."));
    }
    return outcome;
  },
  (effect) =>
    effect.pipe(
      Effect.timeout("25 seconds"),
      Effect.mapError((cause) =>
        cause instanceof ClaudeBankedResetError
          ? cause
          : new ClaudeBankedResetError("Claude did not confirm the reset."),
      ),
    ),
);
