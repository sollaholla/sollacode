import type { EnvironmentId, ScopedThreadRef } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { BellIcon, ExternalLinkIcon, HandIcon, MessageSquareReplyIcon, XIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { useComposerHandleContext } from "~/composerHandleContext";
import { openUrlInThreadPreview } from "~/components/preview/openUrlInThreadPreview";
import {
  ComposerBannerStack,
  type ComposerBannerStackItem,
} from "~/components/chat/ComposerBannerStack";
import { Button } from "~/components/ui/button";
import { previewEnvironment } from "~/state/preview";
import { useAtomCommand } from "~/state/use-atom-command";
import { vmAgentEnvironment } from "~/state/vmAgents";

import type { InlineAgentAttention } from "./agentNotifications";
import { beginWaitingOnYouFollowUpWhenReady } from "./agentAttentionFollowUp";

const commandError = (cause: Cause.Cause<unknown>, fallback: string) => {
  const squashed = Cause.squash(cause);
  return squashed instanceof Error && squashed.message.trim().length > 0
    ? squashed.message
    : fallback;
};

/**
 * The agent's compact attention surface at the live end of Chat. The newest
 * card stays visible and one more opens on hover/focus, using the same stacked
 * behavior as composer connection warnings without pinning a banner across
 * the entire top of the workspace.
 */
export function AgentAttentionStack(props: {
  readonly environmentId: EnvironmentId;
  readonly attention: InlineAgentAttention;
  readonly threadRef: ScopedThreadRef;
  readonly onRevealChat: () => void;
}) {
  const markRead = useAtomCommand(vmAgentEnvironment.markNotificationRead, {
    reportFailure: false,
  });
  const updateNotification = useAtomCommand(vmAgentEnvironment.updateNotification, {
    reportFailure: false,
  });
  const resolveBlocker = useAtomCommand(vmAgentEnvironment.resolveBlocker, {
    reportFailure: false,
  });
  const openPreview = useAtomCommand(previewEnvironment.open, { reportFailure: false });
  const composerRef = useComposerHandleContext();
  const cancelPendingFollowUpRef = useRef<(() => void) | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [busy, setBusy] = useState<{ readonly id: string; readonly action: string } | null>(null);
  const [errors, setErrors] = useState<Readonly<Record<string, string>>>({});

  const notificationIndex = props.attention.items.findIndex((item) => item.kind === "notification");
  const notificationItem =
    notificationIndex < 0 ? null : (props.attention.items[notificationIndex] ?? null);
  const visibleNotification = notificationIndex === 0 || (notificationIndex > 0 && expanded);

  useEffect(() => {
    if (
      notificationItem?.kind !== "notification" ||
      notificationItem.notification.readAt !== null ||
      !visibleNotification
    ) {
      return;
    }
    let active = true;
    void markRead({
      environmentId: props.environmentId,
      input: {
        vmAgentId: notificationItem.notification.vmAgentId,
        notificationId: notificationItem.notification.notificationId,
      },
    }).then((result) => {
      if (!active || result._tag !== "Failure") return;
      setErrors((current) => ({
        ...current,
        [notificationItem.id]: commandError(
          result.cause,
          "This alert could not be marked as read.",
        ),
      }));
    });
    return () => {
      active = false;
    };
  }, [markRead, notificationItem, props.environmentId, visibleNotification]);

  const openBlockerUrl = (url: string) => {
    const openExternally = () => window.open(url, "_blank", "noopener,noreferrer");
    props.onRevealChat();
    void openUrlInThreadPreview({
      threadRef: props.threadRef,
      url,
      openPreview,
      openExternally,
    });
  };

  const followUpOnBlocker = (title: string) => {
    props.onRevealChat();
    cancelPendingFollowUpRef.current?.();
    cancelPendingFollowUpRef.current = beginWaitingOnYouFollowUpWhenReady(
      () => composerRef?.current ?? null,
      title,
    );
  };

  useEffect(
    () => () => {
      cancelPendingFollowUpRef.current?.();
    },
    [],
  );

  const mutateBlocker = async (
    item: Extract<(typeof props.attention.items)[number], { readonly kind: "blocker" }>,
    action: "resolve" | "dismiss",
  ) => {
    if (busy !== null) return;
    setBusy({ id: item.id, action });
    setErrors((current) => ({ ...current, [item.id]: "" }));
    const result = await resolveBlocker({
      environmentId: props.environmentId,
      input: {
        vmAgentId: item.blocker.vmAgentId,
        blockerId: item.blocker.blockerId,
        ...(action === "dismiss" ? { dismissed: true } : {}),
      },
    });
    if (result._tag === "Failure") {
      setErrors((current) => ({
        ...current,
        [item.id]: commandError(
          result.cause,
          action === "dismiss"
            ? "This request could not be dismissed."
            : "This request could not be marked resolved.",
        ),
      }));
    }
    setBusy(null);
  };

  const dismissNotification = async (
    item: Extract<(typeof props.attention.items)[number], { readonly kind: "notification" }>,
  ) => {
    if (busy !== null) return;
    setBusy({ id: item.id, action: "dismiss" });
    setErrors((current) => ({ ...current, [item.id]: "" }));
    const result = await updateNotification({
      environmentId: props.environmentId,
      input: {
        vmAgentId: item.notification.vmAgentId,
        notificationId: item.notification.notificationId,
        read: true,
        archived: true,
      },
    });
    if (result._tag === "Failure") {
      setErrors((current) => ({
        ...current,
        [item.id]: commandError(result.cause, "This alert could not be dismissed."),
      }));
    }
    setBusy(null);
  };

  const cards: ComposerBannerStackItem[] = props.attention.items.map((item, index) => {
    const hiddenLabel =
      index === 0 && props.attention.hiddenCount > 0 ? (
        <span className="shrink-0 rounded-full bg-foreground/8 px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground tabular-nums">
          +{props.attention.hiddenCount} more
        </span>
      ) : null;
    const error = errors[item.id];
    if (item.kind === "notification") {
      return {
        id: item.id,
        variant: "info",
        icon: <BellIcon />,
        title: (
          <span className="flex min-w-0 items-center gap-2">
            <span className="min-w-0 flex-1 truncate">{item.notification.title}</span>
            {hiddenLabel}
          </span>
        ),
        description: <AttentionDescription text={item.notification.body} error={error || null} />,
        actions: (
          <Button
            type="button"
            size="icon-xs"
            variant="ghost"
            disabled={busy !== null}
            aria-label="Dismiss agent alert"
            title="Dismiss"
            onClick={() => void dismissNotification(item)}
          >
            <XIcon />
          </Button>
        ),
      };
    }
    const blockerBusy = busy?.id === item.id ? busy.action : null;
    return {
      id: item.id,
      variant: "warning",
      icon: <HandIcon />,
      title: (
        <span className="flex min-w-0 items-center gap-2">
          <span className="min-w-0 flex-1 truncate">
            <span className="mr-1.5 text-warning">Waiting on you</span>
            <span>{item.blocker.title}</span>
          </span>
          {hiddenLabel}
        </span>
      ),
      description: <AttentionDescription text={item.blocker.detail} error={error || null} />,
      actions: (
        <>
          <Button
            type="button"
            size="xs"
            variant="outline"
            disabled={busy !== null}
            onClick={() => followUpOnBlocker(item.blocker.title)}
          >
            <MessageSquareReplyIcon /> Follow up
          </Button>
          {item.blocker.url ? (
            <Button
              type="button"
              size="xs"
              variant="outline"
              disabled={busy !== null}
              onClick={() => openBlockerUrl(item.blocker.url!)}
            >
              <ExternalLinkIcon /> Open
            </Button>
          ) : null}
          <Button
            type="button"
            size="xs"
            variant="outline"
            disabled={busy !== null}
            onClick={() => void mutateBlocker(item, "resolve")}
          >
            {blockerBusy === "resolve" ? "Resolving…" : "Mark resolved"}
          </Button>
          <Button
            type="button"
            size="icon-xs"
            variant="ghost"
            disabled={busy !== null}
            aria-label="Dismiss waiting-on-you request"
            title="Dismiss without marking it done"
            onClick={() => void mutateBlocker(item, "dismiss")}
          >
            <XIcon />
          </Button>
        </>
      ),
    };
  });

  return (
    <div data-agent-attention-stack="true">
      <ComposerBannerStack className="mx-1 my-3" items={cards} onExpandedChange={setExpanded} />
    </div>
  );
}

function AttentionDescription(props: { readonly text: string; readonly error: string | null }) {
  return (
    <>
      <p className="line-clamp-3 whitespace-pre-wrap break-words" title={props.text}>
        {props.text}
      </p>
      {props.error ? <p className="text-xs text-destructive">{props.error}</p> : null}
    </>
  );
}
