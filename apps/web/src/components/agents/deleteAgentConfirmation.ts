/**
 * Type-the-name confirmation for deleting an agent.
 *
 * Deleting an agent destroys its persistent VM and its whole history, and it
 * is offered from a list where the rows look alike — a hover X on one row and
 * a swipe on another are both one slip away from the wrong agent. A
 * click-twice confirm does not help there: the second click lands in the same
 * place as the first, so the gesture that made the mistake also confirms it.
 *
 * Typing the name is the cheapest control that actually requires knowing which
 * row is under the cursor.
 */

/**
 * Whether the typed text authorises deleting this agent.
 *
 * Surrounding whitespace is forgiven because it is invisible and never
 * intentional; case is not, because two agents differing only in case are two
 * different agents and the point is to name one of them exactly.
 */
export function canConfirmAgentDeletion(input: {
  readonly agentName: string;
  readonly typed: string;
}): boolean {
  const expected = input.agentName.trim();
  if (expected.length === 0) return false;
  return input.typed.trim() === expected;
}

/** Progress hint shown under the field, or null while it is untouched. */
export function agentDeletionMismatchHint(input: {
  readonly agentName: string;
  readonly typed: string;
}): string | null {
  if (input.typed.length === 0) return null;
  if (canConfirmAgentDeletion(input)) return null;
  return `Type ${input.agentName.trim()} exactly to confirm.`;
}
