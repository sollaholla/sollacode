import { memo } from "react";
import { Alert, AlertAction, AlertDescription } from "../ui/alert";
import { Button } from "../ui/button";
import { CircleAlertIcon, LoaderCircleIcon, SparklesIcon, XIcon } from "lucide-react";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { describeThreadErrorAge } from "../ChatView.logic";

const HOST_REPAIR_ERROR_PATTERNS = [
  "did not respond to 'thread/resume'",
  "provider startup timed out",
  "no space left on device",
  "enospc",
  "out of memory",
] as const;

export function isHostRepairEligibleThreadError(error: string | null): boolean {
  if (!error) return false;
  const normalized = error.toLowerCase();
  return HOST_REPAIR_ERROR_PATTERNS.some((pattern) => normalized.includes(pattern));
}

/**
 * A provider payload that fails to decode means the CLI speaks a protocol this
 * build does not know — almost always because the CLI updated itself underneath
 * us. On its own the raw message ("Invalid payload for method 'thread/resume'
 * during 'decode-payload'") names no cause and no remedy, so it reads as the
 * app being broken with nothing to try.
 *
 * Deliberately not host-repair eligible: nothing is wrong with this computer,
 * and pointing a repair agent at it would waste the user's time.
 */
const PROTOCOL_PAYLOAD_DRIFT_PATTERN =
  /invalid payload for method '[^']+' during '(?:de|en)code-payload'/;

export function describeThreadErrorGuidance(error: string | null): string | null {
  if (!error) return null;
  if (!PROTOCOL_PAYLOAD_DRIFT_PATTERN.test(error.toLowerCase())) return null;
  return "The provider CLI updated to a protocol this build of Solla Code does not understand yet. Starting a new thread on it still works — only resuming an existing one fails. Update Solla Code, or point Settings → Providers at an earlier CLI binary.";
}

export const ThreadErrorBanner = memo(function ThreadErrorBanner({
  error,
  occurredAt,
  onDismiss,
  onFixWithAi,
  fixingWithAi = false,
}: {
  error: string | null;
  /** When the provider recorded it, so an old failure cannot read as a live one. */
  occurredAt?: string | null;
  onDismiss?: () => void;
  onFixWithAi?: () => void;
  fixingWithAi?: boolean;
}) {
  if (!error) return null;
  const age = describeThreadErrorAge(occurredAt, Date.now());
  const guidance = describeThreadErrorGuidance(error);
  return (
    <div
      className="pointer-events-auto relative z-30 mx-auto w-fit max-w-[min(48rem,calc(100%-2rem))] pt-3"
      data-chat-thread-error-banner="true"
    >
      <Alert variant="error">
        <CircleAlertIcon />
        <AlertDescription>
          <Tooltip>
            <TooltipTrigger render={<div className="line-clamp-3" />}>{error}</TooltipTrigger>
            <TooltipPopup side="top" className="max-w-96 whitespace-pre-wrap">
              {error}
            </TooltipPopup>
          </Tooltip>
          {age === null ? null : (
            // Without this the banner reads as "this is happening now", which
            // is how a long-stopped thread sends people debugging a live system.
            <p className="mt-1 text-xs opacity-80">Last failed {age}.</p>
          )}
          {guidance === null ? null : (
            <p className="mt-1 text-xs opacity-80" data-chat-thread-error-guidance="true">
              {guidance}
            </p>
          )}
          {onFixWithAi ? (
            <p className="text-xs opacity-80">
              Solla stopped the unresponsive worker. Start a guarded background agent to diagnose
              the app and this computer.
            </p>
          ) : null}
        </AlertDescription>
        {onDismiss || onFixWithAi ? (
          <AlertAction>
            {onFixWithAi ? (
              <Button
                variant="destructive-outline"
                size="sm"
                className="h-11 touch-manipulation gap-1.5 sm:h-8"
                disabled={fixingWithAi}
                aria-label="Fix computer performance with AI"
                data-chat-thread-error-fix-with-ai="true"
                onPointerDown={(event) => event.stopPropagation()}
                onClick={onFixWithAi}
              >
                {fixingWithAi ? (
                  <LoaderCircleIcon className="animate-spin motion-reduce:animate-none" />
                ) : (
                  <SparklesIcon />
                )}
                {fixingWithAi ? "Starting…" : "Fix with AI"}
              </Button>
            ) : null}
            {onDismiss ? (
              <Button
                variant="destructive-outline"
                size="icon-xs"
                className="size-11 touch-manipulation text-destructive opacity-100 sm:size-6"
                aria-label="Dismiss error and reset the session"
                data-chat-thread-error-dismiss="true"
                onPointerDown={(event) => event.stopPropagation()}
                onClick={onDismiss}
              >
                <XIcon className="text-destructive" />
              </Button>
            ) : null}
          </AlertAction>
        ) : null}
      </Alert>
    </div>
  );
});
