import { expect, it } from "vite-plus/test";
import { openCodeSessionUsage, openCodeTokenUsage } from "./opencodeUsage.ts";

const tokens = { input: 100, output: 30, reasoning: 10, cache: { read: 50, write: 20 } };
it("preserves a real zero-cost session and refuses missing or invalid cumulative cost", () => {
  expect(openCodeSessionUsage({ id: "session", cost: 0, time: { updated: 10 } })).toEqual({
    source: "opencode-session",
    sessionId: "session",
    sessionCost: 0,
    updatedAt: 10,
  });
  for (const cost of [undefined, null, "0", -1, NaN, Infinity]) {
    expect(openCodeSessionUsage({ id: "session", cost, time: { updated: 10 } })).toBeUndefined();
  }
  expect(openCodeSessionUsage({ id: "session", cost: 0 })).toBeUndefined();
});
it("counts cached input once and preserves reasoning as an output breakdown", () => {
  expect(openCodeTokenUsage(tokens)).toMatchObject({
    usedTokens: 210,
    inputTokens: 170,
    cachedInputTokens: 50,
    outputTokens: 40,
    reasoningOutputTokens: 10,
  });
});
it("uses the provider total when supplied without inventing a context limit", () => {
  expect(openCodeTokenUsage({ ...tokens, total: 222 })?.usedTokens).toBe(222);
  expect(openCodeTokenUsage({ ...tokens, total: 0 })?.usedTokens).toBe(210);
  expect(openCodeTokenUsage(tokens)?.maxTokens).toBeUndefined();
});
it("ignores zero, malformed, fractional and non-finite usage", () => {
  for (const value of [
    undefined,
    {},
    { ...tokens, input: -1 },
    { ...tokens, output: NaN },
    { ...tokens, total: Infinity },
    { ...tokens, input: 1.5 },
    { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  ])
    expect(openCodeTokenUsage(value)).toBeUndefined();
});
