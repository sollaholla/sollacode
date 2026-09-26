import type { ServerProviderSlashCommand } from "@t3tools/contracts";

import { describeProviderSlashCommand } from "~/providerSlashCommands";

/** The explanation shown when a provider slash command is tapped or clicked. */
export function ProviderSlashCommandInfo({
  command,
}: {
  readonly command: ServerProviderSlashCommand;
}) {
  return (
    <div className="flex max-w-72 flex-col gap-1.5 text-sm" data-provider-slash-command-info="">
      <p className="font-mono font-medium text-info-foreground">/{command.name}</p>
      <p className="text-foreground">{describeProviderSlashCommand(command)}</p>
      {command.input?.hint ? (
        <p className="text-xs text-muted-foreground">
          Takes: <span className="font-mono">{command.input.hint}</span>
        </p>
      ) : null}
      <p className="text-xs text-muted-foreground">
        Sent to the model as a command when the message starts with it.
      </p>
    </div>
  );
}
