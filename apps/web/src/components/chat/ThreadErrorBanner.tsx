import { memo } from "react";
import { Alert, AlertAction, AlertDescription } from "../ui/alert";
import { Button } from "../ui/button";
import { CircleAlertIcon, XIcon } from "lucide-react";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { describeThreadErrorAge } from "../ChatView.logic";

export const ThreadErrorBanner = memo(function ThreadErrorBanner({
  error,
  occurredAt,
  onDismiss,
}: {
  error: string | null;
  /** When the provider recorded it, so an old failure cannot read as a live one. */
  occurredAt?: string | null;
  onDismiss?: () => void;
}) {
  if (!error) return null;
  const age = describeThreadErrorAge(occurredAt, Date.now());
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
        </AlertDescription>
        {onDismiss && (
          <AlertAction>
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
          </AlertAction>
        )}
      </Alert>
    </div>
  );
});
