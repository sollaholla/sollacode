// @effect-diagnostics preferSchemaOverJson:off
import { it, expect } from "@effect/vitest";
import {
  DEFAULT_SERVER_SETTINGS,
  DEFAULT_VM_AGENT_DELEGATION_LIMITS,
  AuthSessionId,
  AuthOrchestrationOperateScope,
  VmAgent,
  VmAgentDelegationDetail,
  type VmAgentCollaborationReceipt,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { FetchHttpClient, HttpRouter } from "effect/unstable/http";
import { EnvironmentAuth } from "../auth/EnvironmentAuth.ts";
import { orchestratorLiveRouteLayer } from "../http.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { ServerSecretStore } from "../auth/ServerSecretStore.ts";
import { VmAgentStore } from "../persistence/Services/VmAgents.ts";
import { VmAgentCollaboration } from "../vm/VmAgentCollaboration.ts";
import { VmAgentTaskScheduler } from "../vm/VmAgentTaskScheduler.ts";
import {
  liveDelegationTask,
  makeOrchestratorLive,
  OrchestratorLiveLayer,
} from "./OrchestratorLive.ts";

const now = "2026-09-10T00:00:00.000Z";
const agent = Schema.decodeUnknownSync(VmAgent)({
  vmAgentId: "agent-pa",
  name: "Personal Assistant",
  handle: "personal-assistant",
  purpose: "Personal administration",
  icon: null,
  vmId: "vm-host",
  threadId: "pa-thread",
  status: "running",
  controlMode: "agent",
  guestIp: null,
  lastError: null,
  createdAt: now,
  updatedAt: now,
});
const identity = {
  vmAgentId: agent.vmAgentId,
  name: agent.name,
  handle: agent.handle,
  purpose: agent.purpose,
};
const decodeDetail = Schema.decodeUnknownSync(VmAgentDelegationDetail);
const detail = () =>
  decodeDetail({
    delegation: {
      delegationId: "work-one",
      rootVmAgentId: agent.vmAgentId,
      sourceVmAgentId: agent.vmAgentId,
      rootDelegationId: null,
      parentDelegationId: null,
      depth: 1,
      target: { kind: "ephemeral" },
      targetVmAgentId: null,
      workerThreadId: "worker",
      rootAgentSnapshot: identity,
      sourceAgentSnapshot: identity,
      targetAgentSnapshot: null,
      taskId: "task-one",
      runId: "run-one",
      title: "Voice request",
      task: "Do the requested work",
      completionCriteria: [],
      requestedCapabilities: [],
      status: "running",
      followupCount: 0,
      messageCount: 0,
      effectiveLimits: DEFAULT_VM_AGENT_DELEGATION_LIMITS,
      revision: 1,
      createdAt: now,
      startedAt: now,
      completedAt: null,
      expiresAt: "2026-09-11T00:00:00.000Z",
      updatedAt: now,
      result: null,
      error: null,
    },
    rootAgent: null,
    sourceAgent: null,
    targetAgent: null,
    messages: [],
  });

function fixture() {
  let settings = {
    ...DEFAULT_SERVER_SETTINGS,
    orchestrator: { ...DEFAULT_SERVER_SETTINGS.orchestrator, enabled: true, model: "gpt-live-1" },
  };
  let current = detail();
  let delegates = 0;
  let messages = 0;
  let capturedTask = "";
  const requests: unknown[] = [];
  const receipt = (): VmAgentCollaborationReceipt => ({
    operation: "delegate",
    delegationId: current.delegation.delegationId,
    status: current.delegation.status,
    revision: current.delegation.revision,
    acceptedAt: now,
  });
  const layer = Layer.mergeAll(
    Layer.mock(ServerSettingsService)({ getSettings: Effect.sync(() => settings) }),
    Layer.mock(ServerSecretStore)({
      get: () => Effect.succeed(Option.some(new TextEncoder().encode("secret-fixture"))),
    }),
    Layer.mock(VmAgentStore)({
      getByNameLower: (name) =>
        Effect.succeed(name === "personal assistant" ? Option.some(agent) : Option.none()),
    }),
    Layer.mock(VmAgentTaskScheduler)({ wake: () => Effect.void }),
    Layer.mock(VmAgentCollaboration)({
      delegate: (source, input) =>
        Effect.sync(() => {
          expect(source).toBe(agent.vmAgentId);
          expect(input.target.kind).toBe("ephemeral");
          delegates++;
          capturedTask = input.task;
          return { receipt: receipt(), delegation: current.delegation };
        }),
      getDetail: () => Effect.sync(() => current),
      sendMessage: () =>
        Effect.sync(() => {
          messages++;
          return receipt();
        }),
      subscribe: () => Effect.succeed(() => undefined),
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
    get delegates() {
      return delegates;
    },
    get messages() {
      return messages;
    },
    get task() {
      return capturedTask;
    },
    readonly: () => {
      settings = {
        ...settings,
        orchestrator: { ...settings.orchestrator, authority: "read-only" },
      };
    },
    missingAgent: () => {
      settings = {
        ...settings,
        orchestrator: { ...settings.orchestrator, liveAgentName: "Missing Agent" },
      };
    },
    complete: () => {
      current = {
        ...current,
        delegation: {
          ...current.delegation,
          status: "completed",
          revision: 2,
          result: { summary: "Verified result", completedBy: "ephemeral-worker", completedAt: now },
        },
      };
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
        agentName: "Personal Assistant",
      });
      expect(JSON.stringify(result)).not.toContain("secret-fixture");
      expect(f.requests[0]).toMatchObject({
        session: { model: "gpt-live-1", delegation: { type: "client" }, store: false },
        transport: { type: "webrtc", sdp: "offer" },
      });
    }).pipe(Effect.provide(f.layer), Effect.provideService(FetchHttpClient.Fetch, f.fetch));
  },
);

it.effect("deduplicates retries and sends corrections to the active inherited worker", () => {
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
    expect(f.delegates).toBe(1);
    const correction = {
      ...request,
      delegationId: "opaque-correction",
      sequence: 2,
      context: "user: Thursday, not Friday",
    };
    yield* service.delegate(correction);
    yield* service.delegate(correction);
    expect(f.delegates).toBe(1);
    expect(f.messages).toBe(1);
    expect(f.task).toContain("request_action_approval");
    f.complete();
    const updates = yield* Stream.runCollect(service.watch(ids[0]!));
    expect([...updates]).toMatchObject([{ status: "completed", text: "Verified result" }]);
    yield* service.release(request.sessionId);
    const released = yield* service.delegate(request).pipe(Effect.result);
    expect(released._tag).toBe("Failure");
    expect(f.delegates).toBe(1);
  }).pipe(Effect.provide(f.layer), Effect.provideService(FetchHttpClient.Fetch, f.fetch));
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
    expect(f.delegates).toBe(1);
    expect(f.messages).toBe(0);
    expect(f.task).toContain("Thursday, not Friday");
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
      expect((await response.text()).trim()).toBe(
        JSON.stringify({ delegationId: "work-one", status: "completed", text: "Verified result" }),
      );
    }
    expect(f.delegates).toBe(1);
    expect((await post("delegation", { ...request, sequence: 0 })).status).toBe(400);
    expect((await post("session/release", { sessionId: "live-opaque" })).status).toBe(204);
    expect((await post("delegation", request)).status).toBe(409);
  } finally {
    await app.dispose();
  }
});

it.effect(
  "enforces current authority and fails missing agent configuration before opening voice",
  () => {
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
      expect(f.delegates).toBe(0);
      f.missingAgent();
      expect((yield* service.start({ sdp: "offer", history: [] }).pipe(Effect.result))._tag).toBe(
        "Failure",
      );
      expect(f.requests).toHaveLength(1);
      expect(
        liveDelegationTask("Quoted content", {
          authority: "full",
          confirmDestructiveActions: true,
        }),
      ).toContain("not that approval");
    }).pipe(Effect.provide(f.layer), Effect.provideService(FetchHttpClient.Fetch, f.fetch));
  },
);
