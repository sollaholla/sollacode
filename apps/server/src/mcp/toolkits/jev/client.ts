import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { JEV_FREE_MODEL, JevDecideError, JevDecideInput, JevDecideResult } from "./types.ts";

const ENDPOINT = "https://opencode.ai/zen/v1/systemone";
const MAX_BYTES = 256 * 1024;
const decodeInput = Schema.decodeUnknownEffect(JevDecideInput);
const encodeJson = Schema.encodeEffect(Schema.UnknownFromJsonString);
const isJevError = Schema.is(JevDecideError);
const decodeResult = Schema.decodeUnknownEffect(Schema.fromJsonString(JevDecideResult));
export type JevFetch = (url: string | URL | Request, init?: RequestInit) => Promise<Response>;

/** Validate correspondence as well as shape before an agent can rely on a decision. */
function matchesQuestions(input: JevDecideInput, result: JevDecideResult): boolean {
  if (Object.keys(result.answers).length !== Object.keys(input.questions).length) return false;
  return Object.entries(input.questions).every(([id, question]) => {
    const answer = result.answers[id];
    if (!answer || answer.type !== question.type) return false;
    if (answer.type === "noul") return true;
    const keys =
      question.type === "choice"
        ? Object.keys(question.criteria)
        : question.type === "score"
          ? question.criteria.map((_, index) => String(index))
          : [];
    if (
      Object.keys(answer.probabilities).length !== keys.length ||
      !keys.every((key) => Object.hasOwn(answer.probabilities, key))
    )
      return false;
    const sum = Object.values(answer.probabilities).reduce((a, b) => a + b, 0);
    if (Math.abs(sum - 1) > 0.01) return false;
    if (answer.type === "choice") return keys.includes(answer.choice);
    return (
      answer.score >= 0 &&
      answer.score <= keys.length - 1 &&
      Object.keys(answer.legend).length === keys.length &&
      keys.every((key) => Object.hasOwn(answer.legend, key))
    );
  });
}

/** One bounded, cancellable request to the free model. Never retries or falls back to a paid model. */
export const decideWithJev = Effect.fn("decideWithJev")(function* (
  rawInput: JevDecideInput,
  fetcher: JevFetch = globalThis.fetch,
) {
  const input = yield* decodeInput(rawInput).pipe(
    Effect.mapError(() => new JevDecideError({ message: "Invalid Jev state or questions." })),
  );
  const body = yield* encodeJson({
    ...input,
    model: JEV_FREE_MODEL,
  }).pipe(Effect.mapError(() => new JevDecideError({ message: "Invalid Jev request." })));
  if (Buffer.byteLength(body) > MAX_BYTES) {
    return yield* new JevDecideError({ message: "Jev request exceeds the 256 KiB limit." });
  }
  const raw = yield* Effect.tryPromise({
    try: async (signal) => {
      const response = await fetcher(ENDPOINT, {
        method: "POST",
        redirect: "error",
        headers: { "Content-Type": "application/json" },
        body,
        signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw new JevDecideError({
          status: response.status,
          message: `OpenCode Jev Free returned HTTP ${response.status}. The free endpoint may be unavailable or require OpenCode access. No paid model was attempted.`,
        });
      }
      const reader = response.body?.getReader();
      if (!reader) throw new Error("Missing response body");
      try {
        const chunks: Uint8Array[] = [];
        let size = 0;
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) break;
          size += chunk.value.byteLength;
          if (size > MAX_BYTES) throw new Error("Response too large");
          chunks.push(chunk.value);
        }
        return Buffer.concat(chunks).toString("utf8");
      } finally {
        await reader.cancel().catch(() => undefined);
        reader.releaseLock();
      }
    },
    catch: (cause) =>
      isJevError(cause)
        ? cause
        : new JevDecideError({
            message:
              "Jev request failed, timed out, or returned an invalid response. No paid model was attempted.",
          }),
  });
  const result = yield* decodeResult(raw).pipe(
    Effect.mapError(
      () => new JevDecideError({ message: "Jev returned an invalid decision response." }),
    ),
  );
  if (
    !matchesQuestions(input, result) ||
    !/^jev-1\.13(?:\.\d+)?(?:-free)?$/.test(result.model) ||
    (result.cost !== undefined && Number(result.cost) !== 0)
  ) {
    return yield* new JevDecideError({
      message:
        "Jev returned mismatched answers, an unexpected model, or a nonzero cost. The result was not accepted.",
    });
  }
  return result;
});
