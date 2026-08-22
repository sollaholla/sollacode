import type { UserInputQuestion } from "@t3tools/contracts";

/** Reserved MCP elicitation field used for Solla's external-action approval UI. */
export const ACTION_APPROVAL_QUESTION_ID = "t3_action_approval";
export const ACTION_APPROVAL_CHOICE = "Approve";

export function isActionApprovalQuestion(
  question: Pick<UserInputQuestion, "id"> | null | undefined,
): boolean {
  return question?.id === ACTION_APPROVAL_QUESTION_ID;
}
