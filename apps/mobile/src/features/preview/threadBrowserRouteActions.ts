import type { EnvironmentId, PreviewTabId, ThreadId } from "@t3tools/contracts";
import type * as Cause from "effect/Cause";

type CommandResult<A> =
  | { readonly _tag: "Success"; readonly value: A }
  | { readonly _tag: "Failure"; readonly cause: Cause.Cause<unknown> };

export async function openRemoteBrowserTab(input: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly open: (request: {
    readonly environmentId: EnvironmentId;
    readonly input: { readonly threadId: ThreadId };
  }) => Promise<CommandResult<{ readonly tabId: PreviewTabId }>>;
  readonly onOpened: (tabId: PreviewTabId) => void;
  readonly onFailure: (cause: Cause.Cause<unknown>) => void;
  readonly refresh: () => void;
}): Promise<void> {
  const result = await input.open({
    environmentId: input.environmentId,
    input: { threadId: input.threadId },
  });
  if (result._tag === "Failure") {
    input.onFailure(result.cause);
    return;
  }
  input.onOpened(result.value.tabId);
  input.refresh();
}

export async function closeRemoteBrowserTab(input: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly tabId: PreviewTabId;
  readonly close: (request: {
    readonly environmentId: EnvironmentId;
    readonly input: { readonly threadId: ThreadId; readonly tabId: PreviewTabId };
  }) => Promise<CommandResult<unknown>>;
  readonly onClosed: () => void;
  readonly onFailure: (cause: Cause.Cause<unknown>) => void;
  readonly refresh: () => void;
}): Promise<void> {
  const result = await input.close({
    environmentId: input.environmentId,
    input: { threadId: input.threadId, tabId: input.tabId },
  });
  if (result._tag === "Failure") {
    input.onFailure(result.cause);
    return;
  }
  input.onClosed();
  input.refresh();
}
