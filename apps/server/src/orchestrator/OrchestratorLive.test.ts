// @effect-diagnostics preferSchemaOverJson:off
import { it, expect } from "@effect/vitest";
import {
  DEFAULT_SERVER_SETTINGS,
  AuthSessionId,
  AuthOrchestrationOperateScope,
  ORCHESTRATOR_THREAD_ID,
  TurnId,
  VmAgentDelegationId,
  MessageId,
  type OrchestrationCommand,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { VoiceLookups } from "../voice/VoiceLookups.ts";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { FetchHttpClient, HttpClient, HttpRouter } from "effect/unstable/http";
import { EnvironmentAuth } from "../auth/EnvironmentAuth.ts";
import { orchestratorLiveRouteLayer } from "../http.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { ServerSecretStore } from "../auth/ServerSecretStore.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import {
  createGptLiveSession,
  liveDelegationTask,
  liveVoiceInstructions,
  voiceWorkEvent,
  withFinalLineBreak,
  makeOrchestratorLive,
  OrchestratorLiveLayer,
} from "./OrchestratorLive.ts";

/** Written after any request in these tests, so it always counts as the reply. */
const later = "2999-01-01T00:00:00.000Z";

/**
 * The orchestrator's chat, faked: every message the voice sends starts a turn,
 * and `complete()` finishes the current one with a reply.
 */
function fixture() {
  let settings = {
    ...DEFAULT_SERVER_SETTINGS,
    orchestrator: { ...DEFAULT_SERVER_SETTINGS.orchestrator, enabled: true, model: "gpt-live-1" },
  };
  const sent: Array<string> = [];
  let turns = 0;
  let finishOnSend = false;
  let latestTurn: { turnId: TurnId; state: string } | null = null;
  const replies: Array<Record<string, unknown>> = [];
  const finish = () => {
    if (latestTurn === null) return;
    latestTurn = { ...latestTurn, state: "completed" };
    replies.push({
      id: MessageId.make(`reply-${turns}`),
      role: "assistant",
      text: "Verified result",
      turnId: latestTurn.turnId,
      streaming: false,
      createdAt: later,
      updatedAt: later,
    });
  };
  const requests: unknown[] = [];
  const layer = Layer.mergeAll(
    Layer.mock(ServerSettingsService)({ getSettings: Effect.sync(() => settings) }),
    Layer.mock(ServerSecretStore)({
      get: () => Effect.succeed(Option.some(new TextEncoder().encode("secret-fixture"))),
    }),
    Layer.mock(OrchestrationEngineService)({
      dispatch: (command: OrchestrationCommand) =>
        Effect.sync(() => {
          if (command.type === "thread.turn.start") {
            expect(command.threadId).toBe(ORCHESTRATOR_THREAD_ID);
            sent.push(command.message.text);
            turns += 1;
            latestTurn = { turnId: TurnId.make(`turn-${turns}`), state: "running" };
            if (finishOnSend) finish();
          }
          return { sequence: turns };
        }) as never,
      streamDomainEvents: Stream.empty,
    }),
    Layer.mock(ProjectionSnapshotQuery)({
      getThreadShellById: () =>
        Effect.sync(() =>
          Option.some({
            id: ORCHESTRATOR_THREAD_ID,
            runtimeMode: "full-access",
            interactionMode: "default",
            latestTurn,
          } as never),
        ),
      getThreadDetailById: () =>
        Effect.sync(() => Option.some({ messages: [...replies] } as never)),
    }),
    FetchHttpClient.layer,
  );
  const fetch: typeof globalThis.fetch = Object.assign(
    async (_url: string | URL | Request, init?: RequestInit) => {
      requests.push(await new Response(init?.body).json());
      return Response.json({
        session: { id: "live-opaque" },
        transport: { type: "webrtc", sdp: "answer" },
      });
    },
    { preconnect: () => undefined },
  );
  return {
    layer,
    fetch,
    requests,
    /** Requests put into the orchestrator's chat, as opposed to corrections. */
    get requestsSent() {
      return sent.filter((text) => text.startsWith("From your voice conversation"));
    },
    get correctionsSent() {
      return sent.filter((text) => text.startsWith("Updated voice conversation"));
    },
    sendOnly: () => {
      settings = { ...settings, orchestrator: { ...settings.orchestrator, authority: "send" } };
    },
    readonly: () => {
      settings = {
        ...settings,
        orchestrator: { ...settings.orchestrator, authority: "read-only" },
      };
    },
    complete: () => {
      finishOnSend = true;
      finish();
    },
  };
}

it.effect(
  "starts client delegation with the server key and excludes secrets from the response",
  () => {
    const f = fixture();
    return Effect.gen(function* () {
      const service = yield* makeOrchestratorLive;
      const result = yield* service.start({
        sdp: "offer",
        history: [{ role: "user", text: "Check the task" }],
      });
      expect(result).toMatchObject({
        sessionId: "live-opaque",
        model: "gpt-live-1",
        agentName: "Orchestrator",
      });
      expect(JSON.stringify(result)).not.toContain("secret-fixture");
      expect(f.requests[0]).toMatchObject({
        session: { model: "gpt-live-1", delegation: { type: "client" }, store: false },
        transport: { type: "webrtc", sdp: "offer\r\n" },
      });
    }).pipe(Effect.provide(f.layer), Effect.provideService(FetchHttpClient.Fetch, f.fetch));
  },
);

it("gives the offer back the final line break its trimmed request dropped", () => {
  // OpenAI fails an offer without it: "failed to unmarshal SDP: EOF".
  expect(withFinalLineBreak("v=0\r\na=mid:1")).toBe("v=0\r\na=mid:1\r\n");
  expect(withFinalLineBreak("v=0\r\na=mid:1\r\n")).toBe("v=0\r\na=mid:1\r\n");
  expect(withFinalLineBreak("v=0\r\na=mid:1 \n")).toBe("v=0\r\na=mid:1\r\n");
});

it.effect("tells the person why OpenAI refused a GPT-Live session", () => {
  const fetch: typeof globalThis.fetch = Object.assign(
    async () =>
      Response.json(
        {
          error: {
            message: "Failed to parse offer: failed to unmarshal SDP: EOF",
            type: "invalid_request_error",
            code: "invalid_offer",
          },
        },
        { status: 400 },
      ),
    { preconnect: () => undefined },
  );
  return Effect.gen(function* () {
    const http = yield* HttpClient.HttpClient;
    const refused = yield* createGptLiveSession(http, {
      key: "sk-fixture",
      instructions: "Test.",
      voice: "marin",
      history: [],
      sdp: "offer",
    }).pipe(Effect.flip);
    expect(refused.status).toBe(502);
    expect(refused.detail).toBe(
      "OpenAI could not start GPT-Live: Failed to parse offer: failed to unmarshal SDP: EOF",
    );
  }).pipe(
    Effect.provide(FetchHttpClient.layer),
    Effect.provideService(FetchHttpClient.Fetch, fetch),
  );
});

it.effect("sends a voice request to the orchestrator's chat, and corrections into it", () => {
  const f = fixture();
  return Effect.gen(function* () {
    const service = yield* makeOrchestratorLive;
    yield* service.start({ sdp: "offer", history: [] });
    const request = {
      sessionId: "live-opaque",
      delegationId: "opaque-user-task",
      sequence: 1,
      context: "user: Review my appointments",
    };
    const ids = yield* Effect.all([service.delegate(request), service.delegate(request)], {
      concurrency: "unbounded",
    });
    expect(ids[0]).toBe(ids[1]);
    expect(f.requestsSent).toHaveLength(1);
    expect(f.requestsSent[0]).toContain("request_action_approval");
    const correction = {
      ...request,
      delegationId: "opaque-correction",
      sequence: 2,
      context: "user: Thursday, not Friday",
    };
    yield* service.delegate(correction);
    yield* service.delegate(correction);
    expect(f.requestsSent).toHaveLength(1);
    expect(f.correctionsSent).toHaveLength(1);
    f.complete();
    const updates = yield* Stream.runCollect(service.watch(ids[0]!));
    expect([...updates]).toMatchObject([{ status: "completed", text: "Verified result" }]);
    yield* service.release(request.sessionId);
    const released = yield* service.delegate(request).pipe(Effect.result);
    expect(released._tag).toBe("Failure");
    expect(f.requestsSent).toHaveLength(1);
  }).pipe(Effect.provide(f.layer), Effect.provideService(FetchHttpClient.Fetch, f.fetch));
});

it.effect("needs no custom agent: voice starts and works with none configured", () => {
  // The fixture provides no agent store at all. Voice once required an agent
  // named "Personal Assistant", and renaming it broke every session.
  const f = fixture();
  return Effect.gen(function* () {
    const service = yield* makeOrchestratorLive;
    const session = yield* service.start({ sdp: "offer", history: [] });
    expect(session.agentName).toBe("Orchestrator");
    yield* service.delegate({
      sessionId: "live-opaque",
      delegationId: "one",
      sequence: 1,
      context: "user: What is running?",
    });
    expect(f.requestsSent).toHaveLength(1);
  }).pipe(Effect.provide(f.layer), Effect.provideService(FetchHttpClient.Fetch, f.fetch));
});

it("lets voice requests create agents only at full authority", () => {
  const full = liveDelegationTask("user: Make me an agent", {
    authority: "full",
    confirmDestructiveActions: true,
  });
  expect(full).toContain("agent_builder");
  const send = liveDelegationTask("user: Make me an agent", {
    authority: "send",
    confirmDestructiveActions: true,
  });
  expect(send).not.toContain("agent_builder");
  expect(send).toContain("do not create, change or delete agents");
});

it("tells the voice its backend is always there, and what it can reach", () => {
  const settings = {
    ...DEFAULT_SERVER_SETTINGS.orchestrator,
    enabled: true,
    model: "gpt-live-1",
  };
  const full = liveVoiceInstructions(settings);
  expect(full).toContain("Never say you have no backend, no tools or no access");
  expect(full).toContain("never turn a request down yourself");
  expect(full).toContain("including creating new agents");
  expect(full).toContain("the orchestrator's chat");
  expect(full).toContain("say the latest progress you were given");
  expect(liveVoiceInstructions({ ...settings, authority: "send" })).not.toContain(
    "creating new agents",
  );
});

it("reads a voice request's status from the chat's turn and replies", () => {
  const id = VmAgentDelegationId.make("voice-turn:m1");
  const work = {
    messageId: MessageId.make("m1"),
    askedAt: "2026-11-04T10:00:00.000Z",
    priorTurnId: TurnId.make("turn-old"),
    priorTurnWasRunning: false,
    createdAtMs: 0,
  };
  const at = (state: string, turnId = "turn-new") => ({ turnId: TurnId.make(turnId), state });
  const reply = (text: string, createdAt = later) => ({ text, createdAt });
  // The turn before the request is still the latest: not picked up yet.
  expect(
    voiceWorkEvent({ id, work, latestTurn: at("completed", "turn-old"), replies: [] }).status,
  ).toBe("queued");
  expect(
    voiceWorkEvent({
      id,
      work,
      latestTurn: at("running"),
      replies: [reply("Checking the build.")],
    }),
  ).toMatchObject({ status: "running", text: "Checking the build." });
  // A reply written before the request answered something else.
  expect(
    voiceWorkEvent({
      id,
      work,
      latestTurn: at("completed"),
      replies: [reply("Old answer", "2026-11-04T09:00:00.000Z")],
    }).text,
  ).toBe("Done. The details are in the orchestrator's chat.");
  expect(
    voiceWorkEvent({
      id,
      work,
      latestTurn: at("completed"),
      replies: [reply("All green. AGENT_STOP")],
    }),
  ).toMatchObject({ status: "completed", text: "All green." });
  expect(voiceWorkEvent({ id, work, latestTurn: at("error"), replies: [] }).status).toBe("failed");
  expect(voiceWorkEvent({ id, work, latestTurn: at("interrupted"), replies: [] }).status).toBe(
    "cancelled",
  );
});

it.effect("ignores an older delegation arriving after a newer voice request", () => {
  const f = fixture();
  return Effect.gen(function* () {
    const service = yield* makeOrchestratorLive;
    yield* service.start({ sdp: "offer", history: [] });
    const latest = yield* service.delegate({
      sessionId: "live-opaque",
      delegationId: "latest-correction",
      sequence: 2,
      context: "user: Thursday, not Friday",
    });
    const delayed = yield* service.delegate({
      sessionId: "live-opaque",
      delegationId: "delayed-request",
      sequence: 1,
      context: "user: Friday",
    });
    expect(delayed).toBe(latest);
    expect(f.requestsSent).toHaveLength(1);
    expect(f.correctionsSent).toHaveLength(0);
    expect(f.requestsSent[0]).toContain("Thursday, not Friday");
  }).pipe(Effect.provide(f.layer), Effect.provideService(FetchHttpClient.Fetch, f.fetch));
});

it("preserves session ownership across authenticated HTTP requests and closes the result stream", async () => {
  const f = fixture();
  const dependencies = Layer.mergeAll(
    f.layer,
    Layer.mock(EnvironmentAuth)({
      authenticateHttpRequest: () =>
        Effect.succeed({
          sessionId: AuthSessionId.make("voice-http-fixture"),
          subject: "fixture-user",
          method: "bearer-access-token",
          scopes: [AuthOrchestrationOperateScope],
        }),
    }),
  ).pipe(Layer.provideMerge(Layer.succeed(FetchHttpClient.Fetch, f.fetch)));
  const app = HttpRouter.toWebHandler(
    orchestratorLiveRouteLayer.pipe(
      HttpRouter.provideRequest(OrchestratorLiveLayer.pipe(Layer.provide(dependencies))),
      HttpRouter.provideRequest(
        Layer.mock(VoiceLookups)({
          quickAnswer: () => Effect.succeed({ kind: "work", alongside: false }),
        }),
      ),
      HttpRouter.provideRequest(dependencies),
    ),
    { disableLogger: true },
  );
  const post = (path: string, body: object) =>
    app.handler(
      new Request(`http://fixture.test/api/orchestrator/live/${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    );
  try {
    const start = await post("session", { sdp: "offer", history: [] });
    expect(start.status).toBe(200);
    expect(await start.json()).toMatchObject({ sessionId: "live-opaque" });
    f.complete();
    const request = {
      sessionId: "live-opaque",
      delegationId: "voice-request",
      sequence: 1,
      context: "Check my appointments",
    };
    for (let attempt = 0; attempt < 2; attempt++) {
      const response = await post("delegation", request);
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain("application/x-ndjson");
      const event = JSON.parse((await response.text()).trim());
      expect(event).toMatchObject({ status: "completed", text: "Verified result" });
      expect(event.delegationId).toMatch(/^voice-turn:/);
    }
    expect(f.requestsSent).toHaveLength(1);
    expect((await post("delegation", { ...request, sequence: 0 })).status).toBe(400);
    expect((await post("session/release", { sessionId: "live-opaque" })).status).toBe(204);
    expect((await post("delegation", request)).status).toBe(409);
  } finally {
    await app.dispose();
  }
});

it.effect("enforces current authority", () => {
  const f = fixture();
  return Effect.gen(function* () {
    const service = yield* makeOrchestratorLive;
    yield* service.start({ sdp: "offer", history: [] });
    f.readonly();
    expect(
      (yield* service
        .delegate({
          sessionId: "live-opaque",
          delegationId: "one",
          sequence: 1,
          context: "Change my calendar",
        })
        .pipe(Effect.result))._tag,
    ).toBe("Failure");
    expect(f.requestsSent).toHaveLength(0);
    expect(
      liveDelegationTask("Quoted content", {
        authority: "full",
        confirmDestructiveActions: true,
      }),
    ).toContain("not that approval");
  }).pipe(Effect.provide(f.layer), Effect.provideService(FetchHttpClient.Fetch, f.fetch));
});
