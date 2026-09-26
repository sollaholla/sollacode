import { describe, expect, it } from "@effect/vitest";
import { ProviderDriverKind } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import { TestClock } from "effect/testing";
import {
  HttpClient,
  type HttpClientRequest,
  HttpClientResponse,
  UrlParams,
} from "effect/unstable/http";

import { carryClaudeResetCredits } from "../Layers/ProviderRegistry.ts";
import {
  CLAUDE_BANKED_RESET_RATE_LIMIT_BACKOFF_MS,
  CLAUDE_BANKED_RESET_READ_DELAY_MS,
  CLAUDE_BANKED_RESET_REFRESH_MS,
  type ClaudeBankedResetRead,
  claimClaudeBankedReset,
  claudeBankedResetOutcome,
  claudeCredentialsServiceName,
  claudeKeychainAccount,
  describeBankedResetBody,
  fetchClaudeBankedResets,
  makeClaudeBankedResetCache,
  normalizeClaudeBankedResets,
  parseClaudeOrganizationUuid,
  parseClaudeStoredCredentials,
  spendClaudeResetCredit,
  withClaudeResetCredits,
} from "./ClaudeBankedResets.ts";

const ORG = "0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0";

const grant = (overrides: Record<string, unknown> = {}) => ({
  id: "grant_1",
  label: "Launch reset",
  resets_total: 3,
  resets_left: 2,
  starts_at: "2026-09-01T00:00:00Z",
  ends_at: "2026-12-01T00:00:00Z",
  clears: ["five_hour", "seven_day"],
  paused: false,
  usable_now: false,
  use_requires_limit: true,
  ...overrides,
});

const status = (program: Record<string, unknown>) => ({
  five_hour: { utilization: 42 },
  cedar_ember: {
    eligible: true,
    at_limit: false,
    exhausted: [],
    grants: [grant()],
    next_grant_id: "grant_1",
    ...program,
  },
});

/** Records every request and answers with `answer`; never touches the network. */
const mockHttp = (
  answer: (request: HttpClientRequest.HttpClientRequest) => Response,
  requests: Array<HttpClientRequest.HttpClientRequest>,
) =>
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) => {
      requests.push(request);
      return Effect.succeed(HttpClientResponse.fromWeb(request, answer(request)));
    }),
  );

describe("normalizeClaudeBankedResets", () => {
  it("lists only the grant the server names as next", () => {
    const credits = normalizeClaudeBankedResets(
      status({ grants: [grant({ id: "other" }), grant()], next_grant_id: "grant_1" }),
    );
    expect(credits).toEqual({
      availableCount: 2,
      credits: [
        {
          id: "grant_1",
          status: "available",
          title: "Launch reset",
          description: "Usable once you reach a usage limit.",
          expiresAt: "2026-12-01T00:00:00Z",
        },
      ],
    });
  });

  it("drops the waiting note once the grant is usable", () => {
    const credits = normalizeClaudeBankedResets(status({ grants: [grant({ usable_now: true })] }));
    expect(credits?.credits[0]?.description).toBeNull();
  });

  it("answers none when not offered, ineligible, paused, spent, or the next id is malformed", () => {
    expect(normalizeClaudeBankedResets({ five_hour: { utilization: 1 } })).toBeNull();
    expect(normalizeClaudeBankedResets({ cedar_ember: null })).toBeNull();
    expect(normalizeClaudeBankedResets(status({ eligible: false }))).toBeNull();
    expect(normalizeClaudeBankedResets(status({ grants: [grant({ paused: true })] }))).toBeNull();
    expect(normalizeClaudeBankedResets(status({ grants: [grant({ resets_left: 0 })] }))).toBeNull();
    expect(normalizeClaudeBankedResets(status({ next_grant_id: "Grant 1" }))).toBeNull();
    expect(normalizeClaudeBankedResets(status({ next_grant_id: "missing" }))).toBeNull();
  });

  it("knows nothing from an empty or malformed answer", () => {
    expect(normalizeClaudeBankedResets({})).toBeUndefined();
    expect(normalizeClaudeBankedResets("nope")).toBeUndefined();
    expect(normalizeClaudeBankedResets({ cedar_ember: "yes" })).toBeUndefined();
  });
});

describe("stored Claude credentials", () => {
  const stored = (overrides: Record<string, unknown> = {}) =>
    JSON.stringify({
      claudeAiOauth: {
        accessToken: "token-fixture",
        refreshToken: "refresh-fixture",
        expiresAt: 2_000,
        scopes: ["user:inference", "user:profile"],
        ...overrides,
      },
    });

  it("returns the access token only while it is live and profile-scoped", () => {
    expect(parseClaudeStoredCredentials(stored(), 1_000)).toBe("token-fixture");
    expect(parseClaudeStoredCredentials(stored(), 2_000)).toBeNull();
    expect(parseClaudeStoredCredentials(stored({ scopes: ["user:inference"] }), 1_000)).toBeNull();
    expect(parseClaudeStoredCredentials("not json", 1_000)).toBeNull();
  });

  it("accepts the keychain's hex form", () => {
    const hex = Buffer.from(stored(), "utf8").toString("hex");
    expect(parseClaudeStoredCredentials(hex, 1_000)).toBe("token-fixture");
  });

  it("names the keychain item the CLI writes", () => {
    expect(claudeCredentialsServiceName({})).toBe("Claude Code-credentials");
    expect(claudeCredentialsServiceName({ CLAUDE_CONFIG_DIR: "/tmp/claude-work" })).toMatch(
      /^Claude Code-credentials-[0-9a-f]{8}$/,
    );
    expect(
      claudeCredentialsServiceName({
        CLAUDE_CONFIG_DIR: "/tmp/a",
        CLAUDE_SECURESTORAGE_CONFIG_DIR: "/tmp/b",
      }),
    ).toBe(claudeCredentialsServiceName({ CLAUDE_CONFIG_DIR: "/tmp/b" }));
    expect(claudeKeychainAccount({ USER: "fixture.user" })).toBe("fixture.user");
    expect(claudeKeychainAccount({ USER: "has space" })).toBe("claude-code-user");
  });

  it("reads the organization from the global config", () => {
    expect(
      parseClaudeOrganizationUuid(JSON.stringify({ oauthAccount: { organizationUuid: ORG } })),
    ).toBe(ORG);
    expect(parseClaudeOrganizationUuid(JSON.stringify({ oauthAccount: {} }))).toBeNull();
    expect(
      parseClaudeOrganizationUuid(JSON.stringify({ oauthAccount: { organizationUuid: "../x" } })),
    ).toBeNull();
  });
});

describe("fetchClaudeBankedResets", () => {
  it.effect("reads the bank from the OAuth usage endpoint", () => {
    const requests: Array<HttpClientRequest.HttpClientRequest> = [];
    return Effect.gen(function* () {
      const result = yield* fetchClaudeBankedResets("token-fixture", "2.1.280");
      expect(result.status).toBe("ok");
      const [request] = requests;
      expect(request?.method).toBe("GET");
      expect(request?.url).toBe("https://api.anthropic.com/api/oauth/usage");
      expect(UrlParams.toString(request!.urlParams)).toBe("cedar_ember=1&skip_spend=1");
      expect(request?.headers.authorization).toBe("Bearer token-fixture");
      expect(request?.headers["anthropic-beta"]).toBe("oauth-2025-04-20");
      expect(request?.headers["user-agent"]).toBe("claude-cli/2.1.280 (external, cli)");
      expect(request?.headers["content-type"]).toBe("application/json");
    }).pipe(Effect.provide(mockHttp(() => Response.json(status({})), requests)));
  });

  it.effect("reports 429 and sign-in rejection distinctly", () =>
    Effect.gen(function* () {
      const answers = [429, 401, 500];
      const results: Array<string> = [];
      for (const code of answers) {
        const result = yield* fetchClaudeBankedResets("token-fixture", "2.1.280").pipe(
          Effect.provide(mockHttp(() => new Response("{}", { status: code }), [])),
        );
        results.push(result.status);
      }
      expect(results).toEqual(["rateLimited", "signedOut", "failed"]);
    }),
  );
});

describe("makeClaudeBankedResetCache", () => {
  it.effect("reads in the background, at most once per interval, and backs off after a 429", () =>
    Effect.gen(function* () {
      const reads = yield* Ref.make(0);
      const answers: Array<ClaudeBankedResetRead> = [
        { status: "ok", credits: normalizeClaudeBankedResets(status({}))! },
        { status: "rateLimited" },
        { status: "ok", credits: null },
      ];
      const cache = yield* makeClaudeBankedResetCache(
        Ref.getAndUpdate(reads, (count) => count + 1).pipe(Effect.map((index) => answers[index]!)),
      );

      // The first check schedules the read without waiting for it, and checks
      // while it is pending do not schedule another.
      expect(yield* cache.current).toBeUndefined();
      expect(yield* cache.current).toBeUndefined();
      expect(yield* Ref.get(reads)).toBe(0);
      yield* TestClock.adjust(CLAUDE_BANKED_RESET_READ_DELAY_MS);
      expect(yield* Ref.get(reads)).toBe(1);
      expect((yield* cache.current)?.availableCount).toBe(2);

      yield* TestClock.adjust(CLAUDE_BANKED_RESET_REFRESH_MS - 1);
      expect((yield* cache.current)?.availableCount).toBe(2);
      yield* TestClock.adjust(CLAUDE_BANKED_RESET_READ_DELAY_MS);
      expect(yield* Ref.get(reads)).toBe(1);

      // 429: keeps the last answer and waits out the longer back-off.
      yield* TestClock.adjust(1);
      expect((yield* cache.current)?.availableCount).toBe(2);
      yield* TestClock.adjust(CLAUDE_BANKED_RESET_READ_DELAY_MS);
      expect(yield* Ref.get(reads)).toBe(2);
      expect((yield* cache.current)?.availableCount).toBe(2);
      yield* TestClock.adjust(CLAUDE_BANKED_RESET_RATE_LIMIT_BACKOFF_MS - 1);
      yield* cache.current;
      yield* TestClock.adjust(CLAUDE_BANKED_RESET_READ_DELAY_MS);
      expect(yield* Ref.get(reads)).toBe(2);
    }).pipe(Effect.scoped, Effect.provide(TestClock.layer())),
  );

  it.effect("takes a redeemed reset off the bank before the re-read lands", () =>
    Effect.gen(function* () {
      const answers: Array<ClaudeBankedResetRead> = [
        {
          status: "ok",
          credits: normalizeClaudeBankedResets(status({ grants: [grant({ label: "" })] }))!,
        },
        { status: "ok", credits: null },
      ];
      const reads = yield* Ref.make(0);
      const cache = yield* makeClaudeBankedResetCache(
        Ref.getAndUpdate(reads, (count) => count + 1).pipe(Effect.map((index) => answers[index]!)),
      );
      yield* cache.current;
      yield* TestClock.adjust(CLAUDE_BANKED_RESET_READ_DELAY_MS);
      expect((yield* cache.current)?.credits[0]?.title).toBe("2 usage limit resets");

      yield* cache.spend("grant_1");
      const spent = yield* cache.current;
      expect(spent?.availableCount).toBe(1);
      expect(spent?.credits[0]?.title).toBe("Usage limit reset");

      yield* TestClock.adjust(CLAUDE_BANKED_RESET_READ_DELAY_MS);
      expect(yield* Ref.get(reads)).toBe(2);
      expect(yield* cache.current).toBeNull();
    }).pipe(Effect.scoped, Effect.provide(TestClock.layer())),
  );
});

describe("describeBankedResetBody", () => {
  it("says why a read shows no bank, without grant ids", () => {
    expect(describeBankedResetBody(status({}))).toBe(
      "eligible=true ineligible_reason= grants=1 next_grant=true resets_left=2 paused=false",
    );
    expect(
      describeBankedResetBody(
        status({ eligible: false, ineligible_reason: "surface", grants: [] }),
      ),
    ).toBe(
      "eligible=false ineligible_reason=surface grants=0 next_grant=true resets_left= paused=",
    );
    expect(describeBankedResetBody({ cedar_ember: null })).toBe("program=null");
    expect(describeBankedResetBody(status({}))).not.toContain("grant_1");
  });
});

describe("spendClaudeResetCredit", () => {
  const credits = normalizeClaudeBankedResets(status({}))!;

  it("keeps a custom label and empties the bank on the last reset", () => {
    expect(spendClaudeResetCredit(credits, "grant_1")).toMatchObject({
      availableCount: 1,
      credits: [{ id: "grant_1", title: "Launch reset" }],
    });
    expect(
      spendClaudeResetCredit(spendClaudeResetCredit(credits, "grant_1"), "grant_1"),
    ).toBeNull();
  });

  it("leaves the bank alone for another grant or an unknown bank", () => {
    expect(spendClaudeResetCredit(credits, "grant_2")).toBe(credits);
    expect(spendClaudeResetCredit(undefined, "grant_1")).toBeUndefined();
  });
});

describe("claimClaudeBankedReset", () => {
  const credentials = { accessToken: "token-fixture", organizationUuid: ORG };
  const cliVersion = "2.1.280";

  it.effect("sends the CLI's claim for the chosen grant with the caller's request id", () => {
    const requests: Array<HttpClientRequest.HttpClientRequest> = [];
    return Effect.gen(function* () {
      const outcome = yield* claimClaudeBankedReset({
        credentials,
        cliVersion,
        grantId: "grant_1",
        requestId: "8b1c6f0e-3a57-4d2f-9f0a-0c1d2e3f4a5b",
      });
      expect(outcome).toBe("reset");
      const [request] = requests;
      expect(request?.method).toBe("POST");
      expect(request?.url).toBe(
        `https://api.anthropic.com/api/organizations/${ORG}/reset_rate_limits`,
      );
      expect(request?.headers.authorization).toBe("Bearer token-fixture");
      expect(request?.headers["user-agent"]).toBe("claude-cli/2.1.280 (external, cli)");
      const body = request?.body;
      expect(body?._tag).toBe("Uint8Array");
      expect(new TextDecoder().decode(body?._tag === "Uint8Array" ? body.body : undefined)).toBe(
        '{"program":"cedar_ember","grant_id":"grant_1","request_id":"8b1c6f0e-3a57-4d2f-9f0a-0c1d2e3f4a5b"}',
      );
    }).pipe(
      Effect.provide(
        mockHttp(
          () => Response.json({ result: "reset", resets_left: 1, cleared: ["five_hour"] }),
          requests,
        ),
      ),
    );
  });

  it.effect("refuses malformed ids and a missing organization without sending anything", () => {
    const requests: Array<HttpClientRequest.HttpClientRequest> = [];
    return Effect.gen(function* () {
      const attempts = [
        { credentials, cliVersion, grantId: "Grant 1", requestId: "ok" },
        { credentials, cliVersion, grantId: "grant_1", requestId: "has space" },
        {
          credentials: { ...credentials, organizationUuid: null },
          cliVersion,
          grantId: "grant_1",
          requestId: "ok",
        },
      ];
      for (const attempt of attempts) {
        const result = yield* Effect.result(claimClaudeBankedReset(attempt));
        expect(result._tag).toBe("Failure");
      }
      expect(requests).toEqual([]);
    }).pipe(Effect.provide(mockHttp(() => Response.json({ result: "reset" }), requests)));
  });

  it.effect(
    "fails, rather than reporting no credit, when the reset is unconfirmed or refused",
    () =>
      Effect.gen(function* () {
        const answers = [
          () => Response.json({ result: "unavailable", reason: "reset_unconfirmed" }),
          () => new Response("{}", { status: 429 }),
          () => new Response("{}", { status: 401 }),
          () => new Response("<html>", { status: 502 }),
        ];
        for (const answer of answers) {
          const result = yield* Effect.result(
            claimClaudeBankedReset({
              credentials,
              cliVersion,
              grantId: "grant_1",
              requestId: "req-1",
            }).pipe(Effect.provide(mockHttp(answer, []))),
          );
          expect(result._tag).toBe("Failure");
        }
      }),
  );
});

describe("claudeBankedResetOutcome", () => {
  it("maps each claim result onto the shared outcomes", () => {
    expect(claudeBankedResetOutcome({ result: "reset" })).toBe("reset");
    expect(claudeBankedResetOutcome({ result: "not_limited" })).toBe("nothingToReset");
    expect(claudeBankedResetOutcome({ result: "already_used" })).toBe("alreadyRedeemed");
    expect(claudeBankedResetOutcome({ result: "cooldown" })).toBe("noCredit");
    expect(claudeBankedResetOutcome({ result: "ineligible", reason: "expired" })).toBe("noCredit");
    expect(claudeBankedResetOutcome({ result: "something_new" })).toBe("noCredit");
    expect(
      claudeBankedResetOutcome({ result: "unavailable", reason: "stamp_indeterminate" }),
    ).toBeUndefined();
    expect(claudeBankedResetOutcome({})).toBeUndefined();
  });
});

describe("account usage envelope", () => {
  const credits = normalizeClaudeBankedResets(status({}))!;

  it("adds the bank to real usage and never invents an envelope", () => {
    expect(withClaudeResetCredits({ rate_limits: {} }, credits)).toEqual({
      rate_limits: {},
      rateLimitResetCredits: credits,
    });
    expect(withClaudeResetCredits({ rate_limits: {} }, null)).toEqual({
      rate_limits: {},
      rateLimitResetCredits: { availableCount: 0, credits: [] },
    });
    const usage = { rate_limits: {} };
    expect(withClaudeResetCredits(usage, undefined)).toBe(usage);
    expect(withClaudeResetCredits(undefined, credits)).toBeUndefined();
  });

  it("carries the bank across a Claude rate-limit event that omits it", () => {
    const claude = ProviderDriverKind.make("claudeAgent");
    const previous = { rate_limits: {}, rateLimitResetCredits: credits };
    expect(carryClaudeResetCredits(claude, previous, { rate_limits: { a: 1 } })).toEqual({
      rate_limits: { a: 1 },
      rateLimitResetCredits: credits,
    });
    const answered = { rate_limits: {}, rateLimitResetCredits: null };
    expect(carryClaudeResetCredits(claude, previous, answered)).toBe(answered);
    const codexEvent = { rateLimits: {} };
    expect(carryClaudeResetCredits(ProviderDriverKind.make("codex"), previous, codexEvent)).toBe(
      codexEvent,
    );
  });
});
