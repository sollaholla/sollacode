import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { McpServer, McpSchema } from "effect/unstable/ai";

import type { DesktopAppUpdateInspection } from "./DesktopAppUpdater.ts";

const ConfirmationResponse = Schema.Struct({
  confirmation: Schema.Literals(["yes", "no"]).annotate({
    title: "Update app",
    description: "Choose Yes to install and restart, or No to keep the current version.",
  }),
});

/**
 * Outcome of asking the user to approve an update.
 *
 * `unsupported` is its own answer rather than a decline: the user never said
 * no, they were never asked. The confirmation is an MCP *elicitation*, which
 * travels to the calling client — not to a dialog in the Solla Code window —
 * so a client that does not implement elicitation leaves the request
 * unanswered until the call times out. From the user's side nothing appears
 * anywhere and the update simply never happens, which is indistinguishable
 * from a broken updater. Reporting it tells the caller to get approval
 * out-of-band and re-run with `force`.
 */
export type DesktopAppUpdateConfirmationOutcome = "confirmed" | "declined" | "unsupported";

export class DesktopAppUpdateConfirmation extends Context.Service<
  DesktopAppUpdateConfirmation,
  {
    readonly confirm: (
      inspection: DesktopAppUpdateInspection,
    ) => Effect.Effect<DesktopAppUpdateConfirmationOutcome, never, McpSchema.McpServerClient>;
  }
>()("t3/mcp/toolkits/appUpdate/confirmation/DesktopAppUpdateConfirmation") {}

const confirm: DesktopAppUpdateConfirmation["Service"]["confirm"] = (inspection) =>
  Effect.gen(function* () {
    // Checked before asking, not after waiting: an elicitation sent to a client
    // that never advertised the capability is not refused, it is ignored.
    const capabilities = yield* McpServer.clientCapabilities;
    if (capabilities.elicitation === undefined) return "unsupported" as const;

    return yield* McpServer.elicit({
      message: `Install Solla Code ${inspection.version} from ${inspection.artifactPath}? The app will close, install the update, and restart with auto-resume.`,
      schema: ConfirmationResponse,
    }).pipe(
      Effect.matchCause({
        onFailure: () => "declined" as const,
        onSuccess: (response) =>
          response.confirmation === "yes" ? ("confirmed" as const) : ("declined" as const),
      }),
    );
  });

export const layer = Layer.succeed(
  DesktopAppUpdateConfirmation,
  DesktopAppUpdateConfirmation.of({ confirm }),
);
