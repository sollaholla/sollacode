import type { EnvironmentId, ScopedThreadRef } from "@t3tools/contracts";
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import * as Cause from "effect/Cause";
import {
  BellIcon,
  CheckIcon,
  ExternalLinkIcon,
  HandIcon,
  MessageSquareReplyIcon,
  XIcon,
} from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";

import { useComposerHandleContext } from "~/composerHandleContext";
import { openUrlInThreadPreview } from "~/components/preview/openUrlInThreadPreview";
import {
  ComposerBannerStack,
  type ComposerBannerStackItem,
} from "~/components/chat/ComposerBannerStack";
import { Button } from "~/components/ui/button";
import {
  Dialog,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "~/components/ui/dialog";
import ChatMarkdown from "~/components/ChatMarkdown";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { previewEnvironment } from "~/state/preview";
import { useAtomCommand } from "~/state/use-atom-command";
import { vmAgentEnvironment } from "~/state/vmAgents";

import type { InlineAgentAttention } from "./agentNotifications";
import { focusComposerWhenReady } from "./agentAttentionFollowUp";
import { attachWaitingOnYou } from "./waitingOnYouAttachment";

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

  /**
   * Tags the request onto the composer rather than typing about it.
   *
   * The old behavior — insert a lead-in sentence and focus — read as doing
   * nothing, because the request card stayed open and closing it was still a
   * separate click. The tag is the link between the two: it is visible, it can
   * be taken off, and sending the message closes the request out.
   */
  const followUpOnBlocker = (
    item: Extract<(typeof props.attention.items)[number], { readonly kind: "blocker" }>,
  ) => {
    props.onRevealChat();
    attachWaitingOnYou(scopedThreadKey(props.threadRef), {
      vmAgentId: item.blocker.vmAgentId,
      blockerId: item.blocker.blockerId,
      title: item.blocker.title,
    });
    cancelPendingFollowUpRef.current?.();
    cancelPendingFollowUpRef.current = focusComposerWhenReady(() => composerRef?.current ?? null);
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
        description: (
          <AttentionDescription
            text={item.notification.body}
            title={item.notification.title}
            error={error || null}
          />
        ),
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
      // Icon-only: the card already carries a title and a detail paragraph, and
      // three labelled buttons crowded them out. The label survives as the
      // tooltip and as the accessible name, so nothing is lost to a screen
      // reader or to anyone who hovers.
      actions: (
        <>
          <AttentionAction
            label="Follow up"
            icon={<MessageSquareReplyIcon />}
            disabled={busy !== null}
            onClick={() => followUpOnBlocker(item)}
          />
          {item.blocker.url ? (
            <AttentionAction
              label="Open"
              icon={<ExternalLinkIcon />}
              disabled={busy !== null}
              onClick={() => openBlockerUrl(item.blocker.url!)}
            />
          ) : null}
          <AttentionAction
            label={blockerBusy === "resolve" ? "Resolving…" : "Mark resolved"}
            icon={<CheckIcon />}
            disabled={busy !== null}
            onClick={() => void mutateBlocker(item, "resolve")}
          />
          <AttentionAction
            label="Dismiss without marking it done"
            icon={<XIcon />}
            variant="ghost"
            disabled={busy !== null}
            onClick={() => void mutateBlocker(item, "dismiss")}
          />
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

/**
 * One icon-only action on a waiting-on-you card.
 *
 * The visible label is gone, so the text has to survive in two places that are
 * easy to forget: the tooltip for a pointer, and `aria-label` for anyone who
 * never sees one.
 */
function AttentionAction(props: {
  readonly label: string;
  readonly icon: ReactNode;
  readonly disabled: boolean;
  readonly onClick: () => void;
  readonly variant?: "outline" | "ghost";
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            type="button"
            size="icon-xs"
            variant={props.variant ?? "outline"}
            disabled={props.disabled}
            aria-label={props.label}
            onClick={props.onClick}
          />
        }
      >
        {props.icon}
      </TooltipTrigger>
      <TooltipPopup>{props.label}</TooltipPopup>
    </Tooltip>
  );
}

/**
 * The card shows three lines; the notification is often much longer than that.
 *
 * Truncating was the whole story before — the rest of the message existed only
 * in a `title` tooltip, which a phone has no way to show at all, so on the
 * device most likely to receive a notification the text was simply gone. It is
 * also written as markdown by the model, so the preview showed raw `**bold**`
 * rather than bold.
 *
 * Tapping now opens the full text, scrollable and rendered. The preview stays
 * plain: markdown in three clamped lines reflows and shifts the card, and the
 * point of the preview is to be skimmed, not read.
 */
function AttentionDescription(props: {
  readonly text: string;
  readonly error: string | null;
  readonly title?: string | undefined;
}) {
  const [expanded, setExpanded] = useState(false);
  const text = props.text.trim();
  // Roughly what survives three clamped lines on a phone. The affordance is
  // only worth showing when there is something behind it: offering "Show more"
  // on a message that already fits reads as a broken link.
  const canExpand = text.length > 160 || text.includes("\n");

  return (
    <>
      {canExpand ? (
        <button
          type="button"
          className="w-full cursor-pointer text-left"
          aria-label="Show the full notification"
          onClick={(event) => {
            // The card behind this is itself clickable in some stacks.
            event.stopPropagation();
            setExpanded(true);
          }}
        >
          <p className="line-clamp-3 whitespace-pre-wrap break-words">{text}</p>
          <span className="mt-0.5 inline-block text-xs text-muted-foreground underline underline-offset-2">
            Show more
          </span>
        </button>
      ) : (
        <p className="line-clamp-3 whitespace-pre-wrap break-words">{text}</p>
      )}
      {props.error ? <p className="text-xs text-destructive">{props.error}</p> : null}
      <Dialog open={expanded} onOpenChange={setExpanded}>
        {/* DialogPopup renders its own viewport; nesting another one put a
            `fixed inset-0` grid inside the popup and collapsed it to a single
            clipped line. DialogPanel is the scrolling content slot. */}
        <DialogPopup className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>{props.title ?? "Notification"}</DialogTitle>
          </DialogHeader>
          <DialogPanel>
            <ChatMarkdown text={text} cwd={undefined} isStreaming={false} />
          </DialogPanel>
        </DialogPopup>
      </Dialog>
    </>
  );
}
