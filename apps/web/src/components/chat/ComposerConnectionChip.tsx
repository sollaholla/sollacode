import { WifiOffIcon } from "lucide-react";

import { cn } from "~/lib/utils";
import { Button } from "../ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import {
  COMPOSER_STATUS_ICON_CHIP_CLASS_NAME,
  COMPOSER_WAITING_CHIP_CLASS_NAME,
} from "./composerStatusIconChip";

export function ComposerConnectionChip(props: {
  readonly title: string;
  readonly description: string;
  readonly reconnecting: boolean;
  readonly onReconnect: () => void;
  readonly onConnections: () => void;
}) {
  return (
    <Popover>
      <PopoverTrigger
        aria-label={`${props.title} Show connection details.`}
        title={props.title}
        className={cn(COMPOSER_STATUS_ICON_CHIP_CLASS_NAME, COMPOSER_WAITING_CHIP_CLASS_NAME)}
        data-chat-composer-status-chip="connection"
      >
        <WifiOffIcon aria-hidden className="size-3" />
      </PopoverTrigger>
      <PopoverPopup side="top" align="end" className="w-[min(20rem,calc(100vw-2rem))]">
        <div className="space-y-3 text-xs">
          <p className="font-medium">{props.title}</p>
          <p className="text-muted-foreground">{props.description}</p>
          <div className="flex flex-wrap justify-end gap-1.5">
            <Button size="xs" disabled={props.reconnecting} onClick={props.onReconnect}>
              {props.reconnecting ? "Reconnecting…" : "Reconnect"}
            </Button>
            <Button size="xs" variant="outline" onClick={props.onConnections}>
              Connections
            </Button>
          </div>
        </div>
      </PopoverPopup>
    </Popover>
  );
}
