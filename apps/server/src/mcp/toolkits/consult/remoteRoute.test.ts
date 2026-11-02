import {
  AuthOrchestrationReadScope,
  AuthSessionId,
  AuthStandardClientScopes,
  EnvironmentId,
  ThreadId,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpRouter } from "effect/unstable/http";
import { describe, expect, it } from "vite-plus/test";

import {
  EnvironmentAuth,
  ServerAuthMissingCredentialError,
} from "../../../auth/EnvironmentAuth.ts";
import { ServerEnvironment } from "../../../environment/ServerEnvironment.ts";
import { OrchestrationEngineService } from "../../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { VmAgentStore } from "../../../persistence/Services/VmAgents.ts";
import { remoteConsultRouteLayer } from "./remoteRoute.ts";
import { REMOTE_CONSULT_PATH } from "./types.ts";

const caller = {
  environmentId: EnvironmentId.make("env-mac"),
  computer: "Mac",
  threadId: ThreadId.make("thread-on-mac"),
  label: "Scout",
  upstreamDepth: 0,
  waitingThreadIds: [],
  delegated: false,
};

function fixture() {
  const dependencies = Layer.mergeAll(
    Layer.mock(EnvironmentAuth)({
      authenticateHttpRequest: (request) => {
        const authorization = request.headers.authorization ?? "";
        if (!authorization.startsWith("Bearer host")) {
          return Effect.fail(new ServerAuthMissingCredentialError());
        }
        return Effect.succeed({
          sessionId: AuthSessionId.make("host-session"),
          subject: "mac",
          method: "bearer-access-token",
          scopes: authorization.endsWith("read-only")
            ? [AuthOrchestrationReadScope]
            : [...AuthStandardClientScopes],
        });
      },
    }),
    Layer.mock(ServerEnvironment)({
      getEnvironmentId: Effect.succeed(EnvironmentId.make("env-windows")),
    }),
    Layer.mock(ProjectionSnapshotQuery)({
      getShellSnapshot: () =>
        Effect.succeed({ snapshotSequence: 1, projects: [], threads: [], updatedAt: "" } as never),
    }),
    Layer.mock(OrchestrationEngineService)({}),
    Layer.mock(VmAgentStore)({ list: () => Effect.succeed([]) }),
    Layer.succeed(
      Crypto.Crypto,
      Crypto.make({
        randomBytes: (size) => new Uint8Array(size),
        digest: (_algorithm, data) => Effect.succeed(data),
      }),
    ),
  );
  const app = HttpRouter.toWebHandler(
    remoteConsultRouteLayer.pipe(HttpRouter.provideRequest(dependencies)),
    { disableLogger: true },
  );
  const call = (body: unknown, authorization?: string) =>
    app.handler(
      new Request(`http://windows.test${REMOTE_CONSULT_PATH}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(authorization === undefined ? {} : { authorization }),
        },
        body: JSON.stringify(body),
      }),
    );
  return { app, call };
}

describe("remote consult route", () => {
  it("answers a call from another computer's server", async () => {
    const { app, call } = fixture();
    try {
      const response = await call(
        { input: { action: "list_threads" }, caller },
        "Bearer host-token",
      );
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        ok: true,
        result: { action: "list_threads", threads: [] },
      });
    } finally {
      await app.dispose();
    }
  });

  it("passes a refusal back as an answer, not a transport failure", async () => {
    const { app, call } = fixture();
    try {
      const response = await call(
        {
          input: { action: "list_threads" },
          caller: { ...caller, environmentId: "env-windows" },
        },
        "Bearer host-token",
      );
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        ok: false,
        error: { _tag: "WorkspaceConsultRefusedError" },
      });
    } finally {
      await app.dispose();
    }
  });

  it("refuses callers without a session or without operate access", async () => {
    const { app, call } = fixture();
    try {
      const body = { input: { action: "list_threads" }, caller };
      expect((await call(body)).status).toBe(401);
      expect((await call(body, "Bearer host-read-only")).status).toBe(403);
    } finally {
      await app.dispose();
    }
  });

  it("rejects something that is not a consult request", async () => {
    const { app, call } = fixture();
    try {
      expect((await call({ hello: "world" }, "Bearer host-token")).status).toBe(400);
    } finally {
      await app.dispose();
    }
  });
});
