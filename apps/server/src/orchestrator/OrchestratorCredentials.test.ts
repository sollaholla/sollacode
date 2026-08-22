import { it as effectIt } from "@effect/vitest";
import { describe, expect, it } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { HostProcessEnvironment } from "@t3tools/shared/hostProcess";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";

import {
  describeMintFailure,
  isQuotaExhausted,
  isVoiceRejection,
  openaiClientSecretBody,
  quotaExhaustedMessage,
  resolveOrchestratorApiKey,
  xaiClientSecretBody,
} from "./OrchestratorCredentials.ts";
import {
  ORCHESTRATOR_OPENAI_API_KEY_SECRET_NAME,
  ORCHESTRATOR_XAI_API_KEY_SECRET_NAME,
} from "./OrchestratorSecretNames.ts";

const textEncoder = new TextEncoder();

describe("isQuotaExhausted", () => {
  it("recognises the wording the API actually returns", () => {
    // Verbatim from a live failure: everything else worked — the key was valid
    // and the token even minted — right up until the session refused to open.
    expect(
      isQuotaExhausted(
        400,
        "You have no credits remaining. Add credits to continue using the API at https://platform.openai.com/settings/organization/billing/.",
      ),
    ).toBe(true);
  });

  it("recognises it from the machine-readable fields", () => {
    expect(isQuotaExhausted(400, "insufficient_quota")).toBe(true);
    expect(isQuotaExhausted(429, "credit_balance_exhausted")).toBe(true);
    expect(isQuotaExhausted(429, "You exceeded your current quota")).toBe(true);
    expect(isQuotaExhausted(400, "insufficient credits")).toBe(true);
  });

  it("treats a payment-required status as quota whatever it says", () => {
    expect(isQuotaExhausted(402, "")).toBe(true);
  });

  it("does not claim a spent account for unrelated failures", () => {
    // A wrong key or a dead model must not send the user to their billing page.
    expect(isQuotaExhausted(401, "Incorrect API key provided")).toBe(false);
    expect(isQuotaExhausted(404, "The model 'gpt-realtime-9' does not exist")).toBe(false);
    expect(isQuotaExhausted(500, "internal server error")).toBe(false);
  });

  it("recognises an xAI team with no Voice credits, which arrives as 403", () => {
    // Verbatim from a live mint: the key was accepted, then xAI refused the
    // ephemeral token because the team has no prepaid credits or licenses.
    const detail =
      '{"code":"The caller does not have permission to execute the specified operation","error":"Your newly created team doesn\'t have any credits or licenses yet. You can purchase those on https://console.x.ai/team/example."}';
    expect(isQuotaExhausted(403, detail)).toBe(true);
    expect(describeMintFailure(detail)).toContain("credits or licenses");
    expect(describeMintFailure(detail)).toContain("console.x.ai");
  });
});

describe("quotaExhaustedMessage", () => {
  it("points OpenAI users at platform.openai.com", () => {
    expect(quotaExhaustedMessage("openai")).toContain("platform.openai.com");
    expect(quotaExhaustedMessage("openai")).not.toContain("console.x.ai");
  });

  it("points Grok users at console.x.ai", () => {
    expect(quotaExhaustedMessage("xai")).toContain("console.x.ai");
    expect(quotaExhaustedMessage("xai")).toContain("xAI");
  });
});

describe("resolveOrchestratorApiKey", () => {
  effectIt.effect("resolves OpenAI and Grok Voice from distinct secret slots", () =>
    Effect.gen(function* () {
      const secrets = new Map<string, Uint8Array>([
        [ORCHESTRATOR_OPENAI_API_KEY_SECRET_NAME, textEncoder.encode("sk-openai")],
        [ORCHESTRATOR_XAI_API_KEY_SECRET_NAME, textEncoder.encode("xai-stored")],
      ]);
      const secretStore = ServerSecretStore.ServerSecretStore.of({
        get: (name) => {
          const value = secrets.get(name);
          return Effect.succeed(value === undefined ? Option.none() : Option.some(value));
        },
        set: (name, value) => Effect.sync(() => void secrets.set(name, value)),
        create: (name, value) => Effect.sync(() => void secrets.set(name, value)),
        getOrCreateRandom: (_name, bytes) => Effect.succeed(new Uint8Array(bytes)),
        remove: (name) => Effect.sync(() => void secrets.delete(name)),
      });

      const [openAi, xai] = yield* Effect.all([
        resolveOrchestratorApiKey("openai"),
        resolveOrchestratorApiKey("xai"),
      ]).pipe(
        Effect.provideService(ServerSecretStore.ServerSecretStore, secretStore),
        Effect.provideService(HostProcessEnvironment, { XAI_API_KEY: "xai-from-env" }),
      );

      expect(Option.getOrUndefined(openAi)).toBe("sk-openai");
      expect(Option.getOrUndefined(xai)).toBe("xai-stored");

      secrets.delete(ORCHESTRATOR_OPENAI_API_KEY_SECRET_NAME);
      const missingOpenAi = yield* resolveOrchestratorApiKey("openai").pipe(
        Effect.provideService(ServerSecretStore.ServerSecretStore, secretStore),
        Effect.provideService(HostProcessEnvironment, { XAI_API_KEY: "xai-from-env" }),
      );
      expect(Option.isNone(missingOpenAi)).toBe(true);
    }),
  );
});

describe("isVoiceRejection", () => {
  it("only fires on a 4xx that mentions the voice", () => {
    expect(isVoiceRejection(400, "Unknown voice 'cedar'")).toBe(true);
    expect(isVoiceRejection(400, "no credits remaining")).toBe(false);
    expect(isVoiceRejection(500, "voice unavailable")).toBe(false);
  });
});

describe("client secret request bodies", () => {
  it("binds the OpenAI model and voice at mint time", () => {
    expect(openaiClientSecretBody({ model: "gpt-realtime", voice: "marin" })).toEqual({
      session: {
        type: "realtime",
        model: "gpt-realtime",
        audio: { output: { voice: "marin" } },
      },
    });
  });

  it("sends only expires_after to xAI, as the ephemeral-token docs require", () => {
    // Model rides the WebSocket query string; voice is applied on session.update.
    expect(xaiClientSecretBody()).toEqual({ expires_after: { seconds: 600 } });
  });
});
