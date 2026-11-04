import {
  type PreviewAutomationCredentialListResult,
  type PreviewAutomationCredentialRequestInput,
  type PreviewAutomationStatus,
} from "@t3tools/contracts";
import {
  credentialRequestFingerprint,
  isPersonOnlySignInOrigin,
  type CredentialRequestMode,
} from "@t3tools/shared/credentialRequest";
import { isPasskeySiteRefused, passkeySiteForUrl } from "@t3tools/shared/passkeySites";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { ProjectionSnapshotQuery } from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as ActionApprovalBroker from "../actionApproval/ActionApprovalBroker.ts";
import { invokeTargeted } from "../preview/handlers.ts";
import * as CredentialRequestPrompt from "./prompt.ts";
import { CredentialRequestToolkit, type CredentialRequestResult } from "./tools.ts";

const PENDING_MESSAGE =
  "The person has this request. Do not retry it, drive that tab, or ask for the secret in chat. End the turn now; in Agent mode emit AGENT_STOP. A fresh turn will tell you the outcome.";

/** The site a request files under, or null where a secret must not be offered. */
export function credentialRequestOrigin(url: string | null): string | null {
  if (url === null) return null;
  try {
    const parsed = new URL(url);
    const loopback =
      parsed.hostname === "localhost" ||
      parsed.hostname.endsWith(".localhost") ||
      parsed.hostname === "127.0.0.1" ||
      parsed.hostname === "[::1]";
    return parsed.protocol === "https:" || (parsed.protocol === "http:" && loopback)
      ? parsed.origin
      : null;
  } catch {
    return null;
  }
}

export const handleCredentialRequest = Effect.fn("CredentialRequest.handle")(function* (
  input: PreviewAutomationCredentialRequestInput,
) {
  const unavailable = (message: string): CredentialRequestResult => ({
    status: "unavailable",
    message,
  });
  const { tabId } = input;
  const target = tabId ? { tabId } : {};
  const status = yield* invokeTargeted<PreviewAutomationStatus>("status", target);
  const origin = credentialRequestOrigin(status.url);
  if (origin === null) {
    return unavailable(
      "That tab is not on a secure website. Open the sign-in page over HTTPS first, then ask again.",
    );
  }

  const refused =
    isPersonOnlySignInOrigin(origin) ||
    (input.kind === "passkey" && isPasskeySiteRefused(passkeySiteForUrl(origin) ?? ""));
  const mode: CredentialRequestMode = refused ? "person" : (input.kind ?? "password");

  if ((mode === "password" || mode === "code") && input.retryAfterFailure !== true) {
    const { credentials } = yield* invokeTargeted<PreviewAutomationCredentialListResult>(
      "credentialList",
      target,
    );
    const matching = credentials.filter((entry) => (entry.kind ?? "password") === mode);
    if (matching.length > 0) {
      return {
        status: "already_saved",
        origin,
        mode,
        credentials: matching,
        message:
          "A login for this site is already saved. Type its username with preview_type and fill it with preview_fill_credential. If the site rejects it, ask again with retryAfterFailure true.",
      } satisfies CredentialRequestResult;
    }
  }

  const invocation = yield* McpInvocationContext.McpInvocationContext;
  const projection = yield* ProjectionSnapshotQuery;
  const thread = yield* projection
    .getThreadShellById(invocation.threadId)
    .pipe(Effect.orElseSucceed(() => Option.none()));
  if (Option.isNone(thread)) {
    return unavailable("This chat could not be found, so the person cannot be asked here.");
  }

  const broker = yield* ActionApprovalBroker.ActionApprovalBroker;
  const fingerprint = credentialRequestFingerprint({ origin, mode });
  const open = yield* broker.findOpen({ threadId: invocation.threadId, fingerprint });
  if (open !== null) {
    return {
      status: "pending",
      origin,
      mode,
      requestId: open,
      message: PENDING_MESSAGE,
    } satisfies CredentialRequestResult;
  }

  const prompt = yield* CredentialRequestPrompt.CredentialRequestPrompt;
  const requestId = yield* prompt.request(
    {
      origin,
      mode,
      reason: input.reason,
      ...(input.usernameHint ? { usernameHint: input.usernameHint } : {}),
    },
    {
      threadId: invocation.threadId,
      turnId: thread.value.session?.activeTurnId ?? thread.value.latestTurn?.turnId ?? null,
    },
  );
  yield* broker.rememberOpen({ threadId: invocation.threadId, requestId, fingerprint });
  return {
    status: "pending",
    origin,
    mode,
    requestId,
    message: PENDING_MESSAGE,
  } satisfies CredentialRequestResult;
});

export const CredentialRequestToolkitHandlersLive = CredentialRequestToolkit.toLayer({
  preview_request_credentials: handleCredentialRequest,
});
