import { memo } from "react";
import { Alert, AlertAction, AlertDescription } from "../ui/alert";
import { Button } from "../ui/button";
import { CircleAlertIcon, XIcon } from "lucide-react";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

export const ThreadErrorBanner = memo(function ThreadErrorBanner({
  error,
  onDismiss,
}: {
  error: string | null;
  onDismiss?: () => void;
}) {
  if (!error) return null;
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
        </AlertDescription>
        {onDismiss && (
          <AlertAction>
            <Button
              variant="destructive-outline"
              size="icon-xs"
              className="size-11 touch-manipulation text-destructive opacity-100 sm:size-6"
              aria-label="Dismiss error"
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
