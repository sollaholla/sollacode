/**
 * A question a provider asked without waiting for the answer. No request is
 * parked on the provider's side, so it has nothing to resolve: the answer goes
 * back as the person's own message, which joins the turn if it is still running.
 */
const ASYNC_QUESTION_REQUEST_PREFIX = "async-question:";

export const asyncQuestionRequestId = (itemId: string) =>
  `${ASYNC_QUESTION_REQUEST_PREFIX}${itemId}`;

export const isAsyncQuestionRequestId = (requestId: string) =>
  requestId.startsWith(ASYNC_QUESTION_REQUEST_PREFIX);
