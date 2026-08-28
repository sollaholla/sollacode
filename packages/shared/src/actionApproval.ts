import type { UserInputQuestion } from "@t3tools/contracts";

/** Reserved MCP elicitation field used for Solla's external-action approval UI. */
export const ACTION_APPROVAL_QUESTION_ID = "t3_action_approval";
export const ACTION_APPROVAL_CHOICE = "Approve";
export const ACTION_APPROVAL_REQUEST_ID_PREFIX = "action-approval:";

export function isActionApprovalRequestId(requestId: string): boolean {
  return requestId.startsWith(ACTION_APPROVAL_REQUEST_ID_PREFIX);
}

export type ActionApprovalAnswer =
  | { readonly status: "approved" }
  | { readonly status: "changes_requested"; readonly feedback: string }
  | { readonly status: "cancelled" };

export function actionApprovalAnswerFromUnknown(
  answers: Readonly<Record<string, unknown>>,
): ActionApprovalAnswer {
  const raw = answers[ACTION_APPROVAL_QUESTION_ID];
  if (typeof raw !== "string" || raw.trim().length === 0) return { status: "cancelled" };
  const answer = raw.trim();
  return answer.toLowerCase() === ACTION_APPROVAL_CHOICE.toLowerCase()
    ? { status: "approved" }
    : { status: "changes_requested", feedback: answer };
}

export function isActionApprovalQuestion(
  question: Pick<UserInputQuestion, "id"> | null | undefined,
): boolean {
  return question?.id === ACTION_APPROVAL_QUESTION_ID;
}

export function actionApprovalFingerprint(input: {
  readonly actionKind: string;
  readonly summary: string;
  readonly preview: string;
}): string {
  return `${input.actionKind}\n${input.summary}\n${input.preview}`;
}
