import type { ProviderAccountSwitchState, ServerProvider } from "@t3tools/contracts";
import {
  CheckCircle2Icon,
  ExternalLinkIcon,
  LoaderCircleIcon,
  TriangleAlertIcon,
} from "lucide-react";
import { memo } from "react";

import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { ProviderInstanceIcon } from "./ProviderInstanceIcon";

const activeStatuses = new Set<ProviderAccountSwitchState["status"]>([
  "logging_out",
  "starting_login",
  "waiting_for_authentication",
  "waiting_for_code",
  "refreshing_account",
]);

export function isProviderAccountSwitchActive(state: ProviderAccountSwitchState): boolean {
  return activeStatuses.has(state.status);
}

function statusTitle(state: ProviderAccountSwitchState): string {
  switch (state.status) {
    case "logging_out":
      return "Signing out";
    case "starting_login":
      return "Opening provider login";
    case "waiting_for_authentication":
      return "Waiting for authentication";
    case "waiting_for_code":
      return "Enter authentication code";
    case "refreshing_account":
      return "Refreshing account";
    case "succeeded":
      return "Account switched";
    case "cancelled":
      return "Account switch cancelled";
    case "failed":
      return "Could not switch account";
  }
}

export const ProviderAccountSwitchOverlay = memo(function ProviderAccountSwitchOverlay(props: {
  readonly state: ProviderAccountSwitchState;
  readonly provider: ServerProvider | null;
  readonly cancelling: boolean;
  readonly submittingCode: boolean;
  readonly onCancel: () => void;
  readonly onDismiss: () => void;
  readonly onOpenAuthLink: () => void;
  readonly onRetry: () => void;
  readonly onSubmitAuthCode: (code: string) => Promise<boolean>;
}) {
  const active = isProviderAccountSwitchActive(props.state);
  const succeeded = props.state.status === "succeeded";
  const providerName =
    props.provider?.displayName?.trim() ||
    (props.state.driver === "claudeAgent" ? "Claude" : "Codex");

  return (
    <div
      className="absolute inset-0 z-[80] flex items-center justify-center bg-background/92 px-5 pt-safe pb-safe backdrop-blur-sm"
      data-provider-account-switch-overlay
      role={active ? "status" : "alert"}
      aria-live="assertive"
    >
      <div className="w-full max-w-sm rounded-2xl border border-border/75 bg-popover p-5 shadow-2xl">
        <div className="flex items-start gap-3">
          <div className="flex shrink-0 items-center gap-2">
            <div className="flex size-10 shrink-0 items-center justify-center rounded-full bg-muted">
              {succeeded ? (
                <CheckCircle2Icon className="size-6 text-success" aria-hidden />
              ) : props.state.status === "failed" ? (
                <TriangleAlertIcon className="size-6 text-destructive" aria-hidden />
              ) : (
                <ProviderInstanceIcon
                  driverKind={props.state.driver}
                  displayName={providerName}
                  accentColor={props.provider?.accentColor}
                  className="size-5"
                  iconClassName="size-5"
                />
              )}
            </div>
            {active ? (
              <span
                className="flex size-5 shrink-0 items-center justify-center text-muted-foreground"
                data-provider-login-spinner
              >
                <LoaderCircleIcon className="size-4 animate-spin" aria-hidden />
              </span>
            ) : null}
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-semibold">{statusTitle(props.state)}</p>
            <p className="mt-1 text-sm leading-relaxed text-muted-foreground">
              {props.state.message ??
                (active
                  ? `Complete the ${providerName} login in your browser.`
                  : "The account switch has finished.")}
            </p>
            {props.state.status === "waiting_for_authentication" ? (
              <p className="mt-2 text-xs text-muted-foreground">
                Solla Code is checking the provider login status automatically.
              </p>
            ) : null}
            {props.state.status === "waiting_for_code" ? (
              <form
                className="mt-3 space-y-2"
                onSubmit={(event) => {
                  event.preventDefault();
                  const form = event.currentTarget;
                  const code = new FormData(form).get("authenticationCode");
                  if (typeof code !== "string" || code.trim().length === 0) return;
                  void props.onSubmitAuthCode(code).then((submitted) => {
                    if (submitted) form.reset();
                  });
                }}
              >
                <Input
                  nativeInput
                  name="authenticationCode"
                  aria-label="Claude Code authentication code"
                  autoComplete="one-time-code"
                  autoFocus
                  disabled={props.submittingCode}
                  placeholder="Paste authentication code"
                  spellCheck={false}
                />
                <Button type="submit" size="sm" className="w-full" disabled={props.submittingCode}>
                  {props.submittingCode ? "Submitting…" : "Continue sign-in"}
                </Button>
              </form>
            ) : null}
            {props.state.authUrl ? (
              <Button
                type="button"
                variant="link"
                size="sm"
                className="mt-2 h-auto justify-start px-0 text-xs"
                onClick={props.onOpenAuthLink}
              >
                Don’t see the browser? Open sign-in link
                <ExternalLinkIcon className="size-3" aria-hidden />
              </Button>
            ) : null}
          </div>
        </div>

        <div className="mt-5 flex justify-end gap-2">
          {active ? (
            <Button
              type="button"
              variant="outline"
              disabled={props.cancelling}
              onClick={props.onCancel}
            >
              {props.cancelling ? "Cancelling…" : "Cancel"}
            </Button>
          ) : props.state.status === "failed" ? (
            <>
              <Button type="button" variant="ghost" onClick={props.onDismiss}>
                Close
              </Button>
              <Button type="button" onClick={props.onRetry}>
                Try again
              </Button>
            </>
          ) : (
            <Button type="button" variant="outline" onClick={props.onDismiss}>
              Done
            </Button>
          )}
        </div>
      </div>
    </div>
  );
});
