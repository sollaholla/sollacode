import type { ServerProviderSlashCommand } from "@t3tools/contracts";

import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { ProviderSlashCommandInfo } from "./ProviderSlashCommandInfo";

/** A sent message's leading slash command: link coloured, tap for what it does. */
export function ProviderSlashCommandLink({
  command,
}: {
  readonly command: ServerProviderSlashCommand;
}) {
  return (
    <Popover>
      <PopoverTrigger
        className="provider-slash-command-link"
        aria-label={`/${command.name} — what this command does`}
        data-provider-slash-command={command.name}
      >
        /{command.name}
      </PopoverTrigger>
      <PopoverPopup side="top" align="start">
        <ProviderSlashCommandInfo command={command} />
      </PopoverPopup>
    </Popover>
  );
}
