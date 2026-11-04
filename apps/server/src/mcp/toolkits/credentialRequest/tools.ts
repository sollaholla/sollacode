import {
  ApprovalRequestId,
  PreviewAutomationCredentialRequestInput,
  PreviewAutomationError,
  PreviewCredentialSummary,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/unstable/ai";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as PreviewAutomationBroker from "../../PreviewAutomationBroker.ts";
import { ProjectionSnapshotQuery } from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as ActionApprovalBroker from "../actionApproval/ActionApprovalBroker.ts";
import * as CredentialRequestPrompt from "./prompt.ts";

export const CredentialRequestResult = Schema.Struct({
  status: Schema.Literals(["already_saved", "pending", "unavailable"]),
  origin: Schema.optional(Schema.String),
  mode: Schema.optional(Schema.Literals(["password", "code", "person", "passkey"])),
  requestId: Schema.optional(ApprovalRequestId),
  credentials: Schema.optional(Schema.Array(PreviewCredentialSummary)),
  message: Schema.String,
});
export type CredentialRequestResult = typeof CredentialRequestResult.Type;

export const CredentialRequestTool = Tool.make("preview_request_credentials", {
  description:
    "Ask the person to sign in for you. Open the page that wants the login first: the site is read from that tab, and whatever they enter is filed under exactly that site. They get a card asking for a username and password (kind password), a PIN or one-time code (kind code), to turn on passkeys Solla holds for the site (kind passkey, when it wants a passkey), or to finish on the page themselves (kind person: single sign-on, a phone approval). They may save it or use it once. Google sign-in pages always use person, since Google refuses automated sign-ins. Returns already_saved with entries when the site has a matching saved login, so use it with preview_fill_credential. Otherwise returns pending: end the turn without retrying, and in Agent mode emit AGENT_STOP. A fresh turn tells you the outcome and the credentialId to fill. You never see the secret, and you must never ask for one in chat. Always reaches the person, including in Agent mode.",
  parameters: PreviewAutomationCredentialRequestInput,
  success: CredentialRequestResult,
  failure: PreviewAutomationError,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    PreviewAutomationBroker.PreviewAutomationBroker,
    ProjectionSnapshotQuery,
    ActionApprovalBroker.ActionApprovalBroker,
    CredentialRequestPrompt.CredentialRequestPrompt,
  ],
})
  .annotate(Tool.Title, "Request sign-in from the person")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, false)
  .annotate(Tool.Meta, { "anthropic/alwaysLoad": true });

export const CredentialRequestToolkit = Toolkit.make(CredentialRequestTool);
