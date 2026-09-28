import { CircleAlertIcon } from "lucide-react";
import { useState } from "react";
import { Button } from "../ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";

export function RemoteBrowserErrorChip(props: {
  error: string | null;
  onRetry: () => Promise<unknown>;
}) {
  const [retrying, setRetrying] = useState(false);
  if (!props.error) return null;
  return (
    <Popover>
      <PopoverTrigger
        aria-label="Browser error: show details"
        title="Browser error"
        className="pointer-events-auto flex h-7 min-w-7 shrink-0 items-center justify-center rounded-full border border-destructive/40 bg-background/95 p-1.5 text-destructive"
      >
        <CircleAlertIcon className="size-3" aria-hidden />
      </PopoverTrigger>
      <PopoverPopup
        side="top"
        align="end"
        aria-label="Browser error details"
        className="w-[min(22rem,calc(100vw-2rem))]"
      >
        <div className="space-y-3 text-xs">
          <p className="font-medium">Browser preview error</p>
          <p className="max-h-[40dvh] overflow-y-auto whitespace-pre-wrap break-words text-muted-foreground">
            {props.error}
          </p>
          <div className="flex justify-end">
            <Button
              type="button"
              size="xs"
              disabled={retrying}
              onClick={async () => {
                setRetrying(true);
                try {
                  await props.onRetry();
                } finally {
                  setRetrying(false);
                }
              }}
            >
              {retrying ? "Retrying…" : "Retry"}
            </Button>
          </div>
        </div>
      </PopoverPopup>
    </Popover>
  );
}
