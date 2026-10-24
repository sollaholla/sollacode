import { describe, expect, it } from "vite-plus/test";
import * as Cause from "effect/Cause";
import * as EffectAcpErrors from "effect-acp/errors";
import type * as EffectAcpSchema from "effect-acp/schema";

import {
  classifyKimiPermissionRequest,
  isKimiAuthRequiredFailure,
  isKimiFileEditPermission,
  kimiModeForTurn,
  kimiPlanMarkdownFromPermission,
  kimiQuestionAnswerOptionId,
  kimiQuestionFromPermission,
  parseKimiDefaultModel,
  parseKimiProviderListJson,
  selectKimiPermissionOptionId,
} from "./KimiAcpSupport.ts";

const text = (value: string) =>
  ({ type: "content", content: { type: "text", text: value } }) as const;

/** Kimi 0.28.1's canonical approval options (`CANONICAL_OPTIONS`). */
const APPROVAL_OPTIONS: ReadonlyArray<EffectAcpSchema.PermissionOption> = [
  { optionId: "approve_once", name: "Approve once", kind: "allow_once" },
  { optionId: "approve_always", name: "Approve for this session", kind: "allow_always" },
  { optionId: "reject", name: "Reject", kind: "reject_once" },
];

function permission(
  options: ReadonlyArray<EffectAcpSchema.PermissionOption>,
  toolCall: Partial<EffectAcpSchema.RequestPermissionRequest["toolCall"]> = {},
): EffectAcpSchema.RequestPermissionRequest {
  return {
    sessionId: "session_1",
    options: [...options],
    toolCall: { toolCallId: "0:call-1", ...toolCall },
  };
}

const question = permission(
  [
    { optionId: "q0_opt_0", name: "Red", kind: "allow_once" },
    { optionId: "q0_opt_1", name: "Blue", kind: "allow_once" },
    { optionId: "q0_skip", name: "Skip", kind: "reject_once" },
  ],
  { title: "AskUserQuestion", content: [text("Which color?")] },
);

const planReview = permission(
  [
    { optionId: "plan_approve", name: "Approve", kind: "allow_once" },
    { optionId: "plan_revise", name: "Revise", kind: "reject_once" },
    { optionId: "plan_reject_and_exit", name: "Reject and Exit", kind: "reject_once" },
  ],
  {
    title: "ExitPlanMode",
    content: [
      text("Plan saved to: /Users/me/.kimi-code/plans/p.md\n\n# Plan\n\n1. Do it"),
      text("Requesting approval to Presenting plan and exiting plan mode"),
    ],
  },
);

describe("Kimi model catalog", () => {
  // `kimi provider list --json` from a real home, credentials replaced.
  const LIST_JSON = JSON.stringify({
    providers: {
      "managed:kimi-code": {
        type: "kimi",
        apiKey: "sk-secret",
        baseUrl: "https://api.kimi.com/coding/v1",
        oauth: { storage: "file", key: "oauth/kimi-code" },
      },
    },
    models: {
      "kimi-code/kimi-for-coding": {
        provider: "managed:kimi-code",
        model: "kimi-for-coding",
        maxContextSize: 262144,
        capabilities: ["thinking", "always_thinking", "image_in", "video_in", "tool_use"],
        displayName: "K2.7 Coding",
      },
      "kimi-code/k3": {
        provider: "managed:kimi-code",
        model: "k3",
        maxContextSize: 1048576,
        capabilities: ["thinking", "always_thinking", "image_in", "video_in", "tool_use"],
        displayName: "K3",
        supportEfforts: ["low", "high", "max"],
        defaultEffort: "high",
      },
      "  ": { displayName: "dropped" },
    },
  });

  it("reads models and keeps nothing from the provider table", () => {
    const models = parseKimiProviderListJson(LIST_JSON);
    expect(models.map((model) => model.alias)).toEqual([
      "kimi-code/kimi-for-coding",
      "kimi-code/k3",
    ]);
    expect(models[1]).toEqual({
      alias: "kimi-code/k3",
      displayName: "K3",
      maxContextSize: 1048576,
      capabilities: ["thinking", "always_thinking", "image_in", "video_in", "tool_use"],
    });
    expect(JSON.stringify(models)).not.toContain("sk-secret");
  });

  it("treats unparseable output as an empty catalog", () => {
    expect(parseKimiProviderListJson("not json")).toEqual([]);
    expect(parseKimiProviderListJson(JSON.stringify({ providers: {} }))).toEqual([]);
  });

  it("reads the default model from the plain listing", () => {
    expect(
      parseKimiDefaultModel(
        "managed:kimi-code  type=kimi  models=3  source=oauth\n\nDefault model: kimi-code/k3\n",
      ),
    ).toBe("kimi-code/k3");
    expect(parseKimiDefaultModel("No providers configured.\n")).toBeUndefined();
  });
});

describe("Kimi permission requests", () => {
  it("tells questions, plan reviews, and approvals apart by option id", () => {
    expect(classifyKimiPermissionRequest(question)).toBe("question");
    expect(classifyKimiPermissionRequest(planReview)).toBe("plan-review");
    expect(classifyKimiPermissionRequest(permission(APPROVAL_OPTIONS, { title: "Bash" }))).toBe(
      "approval",
    );
  });

  it("answers approvals with Kimi's own ids, chosen by kind", () => {
    expect(selectKimiPermissionOptionId(APPROVAL_OPTIONS, "accept")).toBe("approve_once");
    expect(selectKimiPermissionOptionId(APPROVAL_OPTIONS, "acceptForSession")).toBe(
      "approve_always",
    );
    expect(selectKimiPermissionOptionId(APPROVAL_OPTIONS, "decline")).toBe("reject");
    expect(selectKimiPermissionOptionId(APPROVAL_OPTIONS, "cancel")).toBeUndefined();
  });

  it("maps a question answer onto its option, and anything else onto skip", () => {
    const parsed = kimiQuestionFromPermission(question);
    expect(parsed.question).toBe("Which color?");
    expect(parsed.options.map((option) => option.label)).toEqual(["Red", "Blue"]);
    expect(kimiQuestionAnswerOptionId(parsed, "Blue")).toBe("q0_opt_1");
    expect(kimiQuestionAnswerOptionId(parsed, ["Red"])).toBe("q0_opt_0");
    expect(kimiQuestionAnswerOptionId(parsed, "something I typed")).toBe("q0_skip");
    expect(kimiQuestionAnswerOptionId(parsed, undefined)).toBe("q0_skip");
  });

  it("reads the plan without Kimi's path line or approval summary", () => {
    expect(kimiPlanMarkdownFromPermission(planReview)).toBe("# Plan\n\n1. Do it");
    expect(
      kimiPlanMarkdownFromPermission(
        permission(planReview.options, { content: [text("Requesting approval to x")] }),
      ),
    ).toBeUndefined();
  });

  it("recognises Kimi's file-writing tools as edits", () => {
    expect(isKimiFileEditPermission(permission(APPROVAL_OPTIONS, { title: "Write" }))).toBe(true);
    expect(isKimiFileEditPermission(permission(APPROVAL_OPTIONS, { title: "Bash" }))).toBe(false);
  });
});

describe("Kimi session configuration", () => {
  it("keeps questions possible in Solla's auto-approving modes", () => {
    expect(kimiModeForTurn({ interactionMode: "plan", runtimeMode: "full-access" })).toBe("plan");
    expect(kimiModeForTurn({ interactionMode: "default", runtimeMode: "full-access" })).toBe(
      "yolo",
    );
    expect(kimiModeForTurn({ interactionMode: undefined, runtimeMode: "auto" })).toBe("yolo");
    expect(kimiModeForTurn({ interactionMode: "agent", runtimeMode: "approval-required" })).toBe(
      "default",
    );
    expect(kimiModeForTurn({ interactionMode: "default", runtimeMode: "auto-accept-edits" })).toBe(
      "default",
    );
  });

  it("treats Kimi's 'Authentication required' as a sign-in problem", () => {
    const signedOut = new EffectAcpErrors.AcpRequestError({
      code: -32000,
      errorMessage: "Authentication required",
      method: "authenticate",
    });
    const other = new EffectAcpErrors.AcpRequestError({
      code: -32603,
      errorMessage: "session prompt failed",
      method: "session/prompt",
    });
    expect(isKimiAuthRequiredFailure(Cause.fail(signedOut))).toBe(true);
    expect(isKimiAuthRequiredFailure(Cause.fail(other))).toBe(false);
  });
});
