import { describe, expect, it } from "vite-plus/test";

import { ThreadId } from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { FetchHttpClient } from "effect/unstable/http";

import { ServerSecretStore } from "../auth/ServerSecretStore.ts";
import { ServerEnvironment } from "../environment/ServerEnvironment.ts";
import { ThreadHistoryQuery } from "../mcp/toolkits/history/ThreadHistoryQuery.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { VmAgentStore } from "../persistence/Services/VmAgents.ts";
import { RelayedEnvironments } from "../relay/RelayedEnvironments.ts";
import {
  consultInputFor,
  makeVoiceLookups,
  narrowThreadList,
  parseLookupArguments,
  speakable,
} from "./VoiceLookups.ts";

const decodeBody = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)),
);

const thread = (title: string, lastActivityAt: string, computer?: string) => ({
  threadId: ThreadId.make(title),
  title,
  projectId: "project" as never,
  isWorking: false,
  isAgent: false,
  lastActivityAt: lastActivityAt as never,
  ...(computer === undefined ? {} : { computer }),
});

describe("consultInputFor", () => {
  it("reads a page of a thread on another computer", () => {
    expect(
      consultInputFor("read_thread", {
        threadId: "t1",
        environmentId: "env-1",
        cursor: "c1",
        query: "deploy",
      }),
    ).toMatchObject({
      action: "read_thread",
      threadId: "t1",
      environmentId: "env-1",
      cursor: "c1",
      query: "deploy",
    });
  });

  it("refuses a read with no thread and a search with no text", () => {
    expect(consultInputFor("read_thread", {})).toHaveProperty("refused");
    expect(consultInputFor("search_threads", { query: "  " })).toHaveProperty("refused");
  });

  it("offers nothing that could send or change a thing", () => {
    expect(consultInputFor("ask", { threadId: "t1", question: "hi" })).toHaveProperty("refused");
  });
});

describe("narrowThreadList", () => {
  it("keeps matching threads, newest first, and finds them by computer", () => {
    const narrowed = narrowThreadList(
      {
        action: "list_threads",
        status: "Found 3.",
        threads: [
          thread("Old notes", "2026-01-01T00:00:00.000Z", "Studio Mac"),
          thread("Unrelated", "2026-03-01T00:00:00.000Z"),
          thread("New notes", "2026-02-01T00:00:00.000Z", "Studio Mac"),
        ],
      },
      "studio",
    );
    expect(narrowed.threads?.map((row) => row.title)).toEqual(["New notes", "Old notes"]);
  });

  it("says when a long list was cut", () => {
    const narrowed = narrowThreadList(
      {
        action: "list_threads",
        status: "Found.",
        threads: Array.from({ length: 45 }, (_, index) =>
          thread(`Thread ${index}`, "2026-01-01T00:00:00.000Z"),
        ),
      },
      undefined,
    );
    expect(narrowed.threads).toHaveLength(40);
    expect(narrowed.status).toContain("showing the newest 40");
  });
});

describe("parseLookupArguments", () => {
  it("reads an object and reports nothing for anything else", () => {
    expect(parseLookupArguments('{"query":"x"}')).toEqual({ query: "x" });
    expect(parseLookupArguments("[1]")).toEqual({});
    expect(parseLookupArguments("not json")).toEqual({});
    expect(parseLookupArguments(undefined)).toEqual({});
  });
});

describe("speakable", () => {
  it("drops citations and keeps the words of inline links", () => {
    expect(
      speakable(
        "Node **26** is current. ([nodejs.org](https://nodejs.org/en/about)) See [the docs](https://x.test).",
      ),
    ).toBe("Node 26 is current. See the docs.");
  });
});

describe("quickAnswer", () => {
  const speak = {
    speaksFor: ThreadId.make("thread-agent"),
    speakerName: "Scout",
    transcript: "user [0-900ms]: What is the weather?",
  };
  const message = (text: string) => ({
    type: "message",
    content: [{ type: "output_text", text }],
  });
  const call = (name: string) => ({
    type: "function_call",
    call_id: `call-${name}`,
    name,
    arguments: "{}",
  });
  const respondWith = (...turns: ReadonlyArray<ReadonlyArray<unknown> | Response>) => {
    const bodies: Array<Record<string, unknown>> = [];
    const fetch = (async (_url: unknown, init?: RequestInit) => {
      bodies.push(decodeBody(new TextDecoder().decode(init?.body as Uint8Array)));
      const turn = turns[bodies.length - 1] ?? [];
      return turn instanceof Response ? turn : Response.json({ output: turn });
    }) as typeof globalThis.fetch;
    return { bodies, fetch };
  };
  const quick = (fetch: typeof globalThis.fetch, key: Option.Option<string> = Option.some("k")) =>
    Effect.gen(function* () {
      const lookups = yield* makeVoiceLookups;
      return yield* lookups.quickAnswer(speak);
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          FetchHttpClient.layer,
          Layer.mock(ServerEnvironment)({ getEnvironmentId: Effect.die("not reached") }),
          Layer.mock(ServerSecretStore)({
            get: () => Effect.succeed(Option.map(key, (value) => new TextEncoder().encode(value))),
          }),
          Layer.mock(VmAgentStore)({}),
          Layer.mock(ProjectionSnapshotQuery)({}),
          Layer.mock(OrchestrationEngineService)({}),
          Layer.mock(RelayedEnvironments)({}),
          Layer.mock(ThreadHistoryQuery)({}),
          Layer.succeed(Crypto.Crypto, {} as never),
        ),
      ),
      Effect.provideService(FetchHttpClient.Fetch, fetch),
      Effect.runPromise,
    );

  it("speaks what the model answered", async () => {
    const { fetch } = respondWith([message("It is sunny.")]);
    expect(await quick(fetch)).toEqual(Option.some("It is sunny."));
  });

  it("hands anything needing work to the chat", async () => {
    const { fetch } = respondWith([call("start_work")]);
    expect(await quick(fetch)).toEqual(Option.none());
  });

  it("feeds a lookup's result back and answers from it", async () => {
    const { bodies, fetch } = respondWith([call("no_such_lookup")], [message("Nothing there.")]);
    expect(await quick(fetch)).toEqual(Option.some("Nothing there."));
    expect(JSON.stringify(bodies[1]?.input)).toContain("function_call_output");
    expect(JSON.stringify(bodies[1]?.input)).toContain("There is no lookup called no_such_lookup");
  });

  it("gives the fast model only reading tools", async () => {
    const { bodies, fetch } = respondWith([message("Fine.")]);
    await quick(fetch);
    const tools = bodies[0]?.tools as ReadonlyArray<{ type: string; name?: string }>;
    expect(tools.map((tool) => tool.name ?? tool.type)).toEqual([
      "web_search",
      "list_threads",
      "read_thread",
      "search_threads",
      "start_work",
    ]);
  });

  it("falls back to the chat when OpenAI refuses or no key is saved", async () => {
    const refused = respondWith(new Response("nope", { status: 500 }));
    expect(await quick(refused.fetch)).toEqual(Option.none());
    const unused = respondWith([message("Never asked.")]);
    expect(await quick(unused.fetch, Option.none())).toEqual(Option.none());
    expect(unused.bodies).toHaveLength(0);
  });
});
