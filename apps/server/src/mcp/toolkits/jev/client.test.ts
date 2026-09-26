import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Schema from "effect/Schema";
import { decideWithJev, type JevFetch } from "./client.ts";
import { JevDecideInput } from "./types.ts";

const decodeJson = Schema.decodeUnknownEffect(Schema.UnknownFromJsonString);
const decodeInput = Schema.decodeUnknownSync(JevDecideInput);

const input = {
  state: "All tests passed",
  questions: { passed: { type: "noul" as const, instructions: "Did the tests pass?" } },
};
const result = {
  model: "jev-1.13-free",
  answers: { passed: { type: "noul", noul: 0.98 } },
  usage: { input_tokens: 42, output_tokens: 5 },
  cost: "0",
};
const respond =
  (body: unknown, status = 200): JevFetch =>
  async () =>
    new Response(JSON.stringify(body), { status });

it.effect("uses only Jev Free and the System One endpoint with a cancellable request", () =>
  Effect.gen(function* () {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const answer = yield* decideWithJev(input, async (url, init) => {
      calls.push({ url: String(url), ...(init ? { init } : {}) });
      return new Response(JSON.stringify(result));
    });
    expect(answer).toEqual(result);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://opencode.ai/zen/v1/systemone");
    const body = yield* decodeJson(String(calls[0]?.init?.body));
    expect(body).toEqual({ ...input, model: "jev-1.13-free" });
    expect(calls[0]?.init?.signal).toBeInstanceOf(AbortSignal);
    expect(calls[0]?.init?.redirect).toBe("error");
  }),
);

it.effect("accepts a mixed decision batch with fractional scores", () =>
  Effect.gen(function* () {
    const mixed = {
      state: "Test failed.",
      questions: {
        category: {
          type: "choice" as const,
          instructions: "What failed?",
          criteria: { tests: "Tests", build: null },
        },
        severity: {
          type: "score" as const,
          instructions: "How severe?",
          criteria: ["Low", "High"],
        },
        ...input.questions,
      },
    };
    const response = {
      ...result,
      answers: {
        ...result.answers,
        category: {
          type: "choice",
          choice: "tests",
          confidence: 0.7,
          probabilities: { tests: 0.8, build: 0.2 },
        },
        severity: {
          type: "score",
          score: 0.75,
          confidence: 0.4,
          probabilities: { "0": 0.25, "1": 0.75 },
          legend: { "0": "Low", "1": "High" },
        },
      },
    };
    expect(yield* decideWithJev(mixed, respond(response))).toEqual(response);
  }),
);

for (const status of [401, 402, 404, 429, 503, 529]) {
  it.effect(`reports HTTP ${status} without retrying or selecting a paid model`, () =>
    Effect.gen(function* () {
      let calls = 0;
      const error = yield* decideWithJev(input, async () => {
        calls++;
        return new Response("upstream error", { status });
      }).pipe(Effect.flip);
      expect(error.status).toBe(status);
      expect(calls).toBe(1);
      expect(error.message).toContain("No paid model was attempted");
    }),
  );
}

for (const [name, response] of Object.entries({
  missing: { ...result, answers: {} },
  extra: { ...result, answers: { ...result.answers, extra: { type: "noul", noul: 0.5 } } },
  wrongType: {
    ...result,
    answers: {
      passed: { type: "choice", choice: "yes", confidence: 1, probabilities: { yes: 1 } },
    },
  },
  invalidProbability: { ...result, answers: { passed: { type: "noul", noul: 1.1 } } },
  negativeUsage: { ...result, usage: { input_tokens: -1, output_tokens: 2 } },
  charged: { ...result, cost: "0.01" },
  wrongModel: { ...result, model: "unrelated" },
  wrongJevVersion: { ...result, model: "jev-2.0" },
})) {
  it.effect(`rejects ${name} responses`, () =>
    Effect.gen(function* () {
      const error = yield* decideWithJev(input, respond(response)).pipe(Effect.flip);
      expect(error._tag).toBe("JevDecideError");
    }),
  );
}

it.effect("rejects options outside the rubric and incomplete probability distributions", () =>
  Effect.gen(function* () {
    const choice = {
      ...input,
      questions: {
        category: {
          type: "choice" as const,
          instructions: "Classify",
          criteria: { a: null, b: null },
        },
      },
    };
    for (const answer of [
      { choice: "c", probabilities: { a: 0.2, b: 0.8 } },
      { choice: "a", probabilities: { a: 1 } },
      { choice: "a", probabilities: { a: 0.1, b: 0.1 } },
    ]) {
      const error = yield* decideWithJev(
        choice,
        respond({
          ...result,
          answers: { category: { type: "choice", confidence: 0.5, ...answer } },
        }),
      ).pipe(Effect.flip);
      expect(error._tag).toBe("JevDecideError");
    }
  }),
);

it.effect("bounds request and response sizes and handles malformed JSON", () =>
  Effect.gen(function* () {
    for (const text of ["not json", "x".repeat(256 * 1024 + 1)]) {
      expect(
        (yield* decideWithJev(input, async () => new Response(text)).pipe(Effect.flip))._tag,
      ).toBe("JevDecideError");
    }
    let calls = 0;
    const large = {
      ...input,
      questions: Object.fromEntries(
        Array.from({ length: 32 }, (_, i) => [
          String(i),
          { type: "noul" as const, instructions: "x".repeat(8192) },
        ]),
      ),
    };
    const error = yield* decideWithJev(large, async () => {
      calls++;
      return new Response();
    }).pipe(Effect.flip);
    expect(error.message).toContain("256 KiB");
    expect(calls).toBe(0);
  }),
);

it("rejects empty questions and invalid rubric sizes before sending", () => {
  for (const questions of [
    {},
    { q: { type: "choice", instructions: "Choose", criteria: {} } },
    { q: { type: "score", instructions: "Score", criteria: ["Only"] } },
    { q: { type: "score", instructions: "Score", criteria: Array(11).fill("Level") } },
    {
      q: {
        type: "choice",
        instructions: "Choose",
        criteria: Object.fromEntries(Array.from({ length: 256 }, (_, i) => [String(i), null])),
      },
    },
  ])
    expect(() => decodeInput({ state: "test", questions })).toThrow();
});

it.effect("aborts an in-flight request when its caller is interrupted", () =>
  Effect.gen(function* () {
    let started!: () => void;
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    let signal: AbortSignal | undefined;
    const fiber = yield* decideWithJev(input, async (_, init) => {
      signal = init?.signal ?? undefined;
      started();
      return await new Promise<Response>((_, reject) => {
        signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      });
    }).pipe(Effect.forkChild);
    yield* Effect.promise(() => ready);
    yield* Fiber.interrupt(fiber);
    expect(signal?.aborted).toBe(true);
  }),
);
