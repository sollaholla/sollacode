import { useAtomValue } from "@effect/atom-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  CommandId,
  MessageId,
  type EnvironmentId,
  type ModelSelection,
  type OrchestrationMessage,
  type OrchestrationThreadActivity,
  type OrchestrationThreadHistoryWindow,
  type ProviderInteractionMode,
  type RuntimeMode,
  type ThreadId,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/unstable/reactivity";
import { safeErrorLogAttributes } from "@t3tools/client-runtime/errors";
import { deriveActiveWorkStartedAt } from "@t3tools/shared/orchestrationTiming";

import { makeQueuedMessageMetadata } from "../lib/commandMetadata";
import { uuidv4 } from "../lib/uuid";
import {
  convertPastedImagesToAttachments,
  pasteComposerClipboard,
  pickComposerImages,
} from "../lib/composerImages";
import type { DraftComposerImageAttachment } from "../lib/composerImages";
import { scopedThreadKey } from "../lib/scopedEntities";
import { buildThreadFeed } from "../lib/threadActivity";
import { appAtomRegistry } from "../state/atom-registry";
import {
  appendComposerDraftAttachments,
  appendComposerDraftText,
  clearComposerDraftContent,
  composerDraftsAtom,
  ensureComposerDraftsLoaded,
  getComposerDraftSnapshot,
  removeComposerDraftAttachment,
  setComposerDraftText,
  updateComposerDraftSettings,
  useComposerDraft,
} from "./use-composer-drafts";
import { setPendingConnectionError } from "../state/use-remote-environment-registry";
import { useSelectedThreadDetailState } from "../state/use-thread-detail";
import { useAtomCommand } from "./use-atom-command";
import { loadThreadHistory } from "./threads";
import { useThreadSelection } from "../state/use-thread-selection";
import { enqueueThreadOutboxMessage } from "./thread-outbox";
import { useThreadOutboxMessages } from "./use-thread-outbox";
import { composerFocusRequestsAtom, consumeComposerFocusRequest } from "./composer-focus-requests";
import {
  clearQueuedTurnPromotionRequest,
  collectDeliveredMessageIds,
  nextQueuedMessageToPromote,
  orderedQueuedTurnPromotionMessageIds,
  queuedMessageAutoPromoteDelayMs,
  queuedTurnMessageIds,
  queuedTurnPromotionRequestsAtom,
  queuedTurnPromotionOutcome,
  requestQueuedTurnPromotion,
} from "./thread-queued-turn-promotion";

export function appendReviewCommentToDraft(input: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly text: string;
  readonly attachments?: ReadonlyArray<DraftComposerImageAttachment>;
}): void {
  const threadKey = scopedThreadKey(input.environmentId, input.threadId);
  const existing = appAtomRegistry.get(composerDraftsAtom)[threadKey]?.text ?? "";
  const separator = existing.trim().length > 0 && !existing.endsWith("\n") ? "\n\n" : "";
  setComposerDraftText(threadKey, `${existing}${separator}${input.text}`);
  if (input.attachments && input.attachments.length > 0) {
    appendComposerDraftAttachments(threadKey, input.attachments);
  }
}

export function useThreadDraftForThread(input: {
  readonly environmentId?: EnvironmentId;
  readonly threadId?: ThreadId;
}) {
  const threadKey =
    input.environmentId && input.threadId
      ? scopedThreadKey(input.environmentId, input.threadId)
      : null;
  const draft = useComposerDraft(threadKey);

  return {
    draftMessage: draft.text,
    draftAttachments: draft.attachments,
  };
}

export function useThreadComposerState() {
  const { selectedThread: selectedThreadShell } = useThreadSelection();
  const selectedThreadDetailState = useSelectedThreadDetailState();
  const recentSelectedThreadDetail = Option.getOrNull(selectedThreadDetailState.data);
  const loadThreadHistoryCommand = useAtomCommand(loadThreadHistory, { reportFailure: false });
  const selectedHistoryKey = selectedThreadShell
    ? scopedThreadKey(selectedThreadShell.environmentId, selectedThreadShell.id)
    : null;
  const [loadedHistory, setLoadedHistory] = useState<{
    readonly key: string | null;
    readonly messages: ReadonlyArray<OrchestrationMessage>;
    readonly activities: ReadonlyArray<OrchestrationThreadActivity>;
    readonly window: OrchestrationThreadHistoryWindow | null;
  }>(() => ({
    key: selectedHistoryKey,
    messages: [],
    activities: [],
    window: selectedThreadDetailState.history ?? null,
  }));
  const historyLoadInFlightRef = useRef(false);
  const selectedHistoryKeyRef = useRef(selectedHistoryKey);
  selectedHistoryKeyRef.current = selectedHistoryKey;
  useEffect(() => {
    historyLoadInFlightRef.current = false;
    setLoadedHistory((current) => {
      if (current.key !== selectedHistoryKey) {
        return {
          key: selectedHistoryKey,
          messages: [],
          activities: [],
          window: selectedThreadDetailState.history ?? null,
        };
      }
      if (current.messages.length === 0 && current.activities.length === 0) {
        return { ...current, window: selectedThreadDetailState.history ?? null };
      }
      return current;
    });
  }, [selectedHistoryKey, selectedThreadDetailState.history]);
  const selectedThreadDetail = useMemo(() => {
    if (
      recentSelectedThreadDetail === null ||
      loadedHistory.key !== selectedHistoryKey ||
      (loadedHistory.messages.length === 0 && loadedHistory.activities.length === 0)
    ) {
      return recentSelectedThreadDetail;
    }
    const recentMessageIds = new Set(
      recentSelectedThreadDetail.messages.map((message) => message.id),
    );
    const recentActivityIds = new Set(
      recentSelectedThreadDetail.activities.map((activity) => activity.id),
    );
    return {
      ...recentSelectedThreadDetail,
      messages: [
        ...loadedHistory.messages.filter((message) => !recentMessageIds.has(message.id)),
        ...recentSelectedThreadDetail.messages,
      ],
      activities: [
        ...loadedHistory.activities.filter((activity) => !recentActivityIds.has(activity.id)),
        ...recentSelectedThreadDetail.activities,
      ],
    };
  }, [loadedHistory, recentSelectedThreadDetail, selectedHistoryKey]);
  const olderHistoryWindow =
    loadedHistory.key === selectedHistoryKey
      ? loadedHistory.window
      : (selectedThreadDetailState.history ?? null);
  const hasOlderHistory =
    olderHistoryWindow !== null &&
    (olderHistoryWindow.messageCursor !== null || olderHistoryWindow.activityCursor !== null);
  const olderHistoryMessageCount = Math.max(
    0,
    (olderHistoryWindow?.totalMessages ?? 0) -
      (recentSelectedThreadDetail?.messages.length ?? 0) -
      loadedHistory.messages.length,
  );
  const [olderHistoryLoading, setOlderHistoryLoading] = useState(false);
  const onLoadOlderHistory = useCallback(async () => {
    if (
      selectedThreadShell === null ||
      olderHistoryWindow === null ||
      historyLoadInFlightRef.current ||
      (olderHistoryWindow.messageCursor === null && olderHistoryWindow.activityCursor === null)
    ) {
      return;
    }
    historyLoadInFlightRef.current = true;
    setOlderHistoryLoading(true);
    const requestedKey = selectedHistoryKey;
    try {
      const result = await loadThreadHistoryCommand({
        environmentId: selectedThreadShell.environmentId,
        input: {
          threadId: selectedThreadShell.id,
          page: {
            ...(olderHistoryWindow.messageCursor === null
              ? {}
              : {
                  beforeMessageCreatedAt: olderHistoryWindow.messageCursor.createdAt,
                  beforeMessageId: olderHistoryWindow.messageCursor.messageId,
                }),
            ...(olderHistoryWindow.activityCursor === null
              ? {}
              : {
                  beforeActivityCreatedAt: olderHistoryWindow.activityCursor.createdAt,
                  beforeActivityId: olderHistoryWindow.activityCursor.activityId,
                }),
            limit: 150,
          },
        },
      });
      const commandValue = AsyncResult.value(result);
      if (Option.isNone(commandValue) || Option.isNone(commandValue.value)) return;
      const page = commandValue.value.value;
      if (selectedHistoryKeyRef.current !== requestedKey) return;
      setLoadedHistory((current) => {
        if (current.key !== requestedKey) return current;
        const knownMessages = new Set(current.messages.map((message) => message.id));
        const knownActivities = new Set(current.activities.map((activity) => activity.id));
        return {
          ...current,
          messages: [
            ...page.messages.filter((message) => !knownMessages.has(message.id)),
            ...current.messages,
          ],
          activities: [
            ...page.activities.filter((activity) => !knownActivities.has(activity.id)),
            ...current.activities,
          ],
          window: page.history,
        };
      });
    } finally {
      historyLoadInFlightRef.current = false;
      if (selectedHistoryKeyRef.current === requestedKey) setOlderHistoryLoading(false);
    }
  }, [loadThreadHistoryCommand, olderHistoryWindow, selectedHistoryKey, selectedThreadShell]);
  const composerDrafts = useAtomValue(composerDraftsAtom);
  const queuedMessagesByThreadKey = useThreadOutboxMessages();
  const queuedTurnPromotionRequests = useAtomValue(queuedTurnPromotionRequestsAtom);
  const composerFocusRequests = useAtomValue(composerFocusRequestsAtom);

  useEffect(() => {
    ensureComposerDraftsLoaded();
  }, []);

  const selectedThreadKey = selectedThreadShell
    ? scopedThreadKey(selectedThreadShell.environmentId, selectedThreadShell.id)
    : null;
  const selectedThreadQueuedMessages = useMemo(
    () => (selectedThreadKey ? (queuedMessagesByThreadKey[selectedThreadKey] ?? []) : []),
    [queuedMessagesByThreadKey, selectedThreadKey],
  );
  const selectedThreadFeed = useMemo(
    () => (selectedThreadDetail ? buildThreadFeed(selectedThreadDetail) : []),
    [selectedThreadDetail],
  );

  const selectedDraft = selectedThreadKey ? composerDrafts[selectedThreadKey] : null;
  const draftMessage = selectedDraft?.text ?? "";
  const draftAttachments = selectedDraft?.attachments ?? [];
  const selectedThreadQueueCount = selectedThreadQueuedMessages.length;
  const selectedThread = selectedThreadDetail ?? selectedThreadShell;
  const composerFocusRequest = selectedThreadKey
    ? (composerFocusRequests[selectedThreadKey] ?? null)
    : null;
  const onConsumeComposerFocusRequest = useCallback(() => {
    if (selectedThreadKey && composerFocusRequest !== null) {
      consumeComposerFocusRequest(selectedThreadKey, composerFocusRequest);
    }
  }, [composerFocusRequest, selectedThreadKey]);
  const modelSelection = selectedDraft?.modelSelection ?? selectedThread?.modelSelection ?? null;
  const runtimeMode = selectedDraft?.runtimeMode ?? selectedThread?.runtimeMode ?? null;
  const interactionMode = selectedDraft?.interactionMode ?? selectedThread?.interactionMode ?? null;

  const selectedThreadSessionActivity = useMemo(() => {
    const selectedThread = selectedThreadDetail ?? selectedThreadShell;
    if (!selectedThread?.session) {
      return null;
    }

    return {
      orchestrationStatus: selectedThread.session.status,
      activeTurnId: selectedThread.session.activeTurnId ?? undefined,
    };
  }, [selectedThreadDetail, selectedThreadShell]);

  const activeWorkStartedAt = useMemo(() => {
    const selectedThread = selectedThreadDetail ?? selectedThreadShell;
    if (!selectedThread) {
      return null;
    }

    return deriveActiveWorkStartedAt(
      selectedThread.latestTurn,
      selectedThreadSessionActivity,
      null,
    );
  }, [selectedThreadDetail, selectedThreadSessionActivity, selectedThreadShell]);

  const activeThreadBusy =
    !!selectedThread &&
    (selectedThread.session?.status === "running" || selectedThread.session?.status === "starting");
  const serverQueuedMessageIds = useMemo(
    () =>
      selectedThreadDetail
        ? queuedTurnMessageIds({
            messages: selectedThreadDetail.messages,
            activities: selectedThreadDetail.activities,
            activeWorkStartedAt,
          })
        : [],
    [activeWorkStartedAt, selectedThreadDetail],
  );
  const localQueuedMessageIds = useMemo(
    () => selectedThreadQueuedMessages.map((message) => message.messageId),
    [selectedThreadQueuedMessages],
  );
  const serverProjectedMessageIds = useMemo(
    () => selectedThreadDetail?.messages.map((message) => message.id) ?? [],
    [selectedThreadDetail],
  );
  const hasQueuedSendNow =
    activeThreadBusy &&
    selectedThread?.session?.providerName?.toLowerCase() === "grok" &&
    (selectedThreadQueueCount > 0 || serverQueuedMessageIds.length > 0);
  const queuedSendNowMessageIds = useMemo(
    () =>
      orderedQueuedTurnPromotionMessageIds({
        localMessages: selectedThreadQueuedMessages,
        serverMessages: selectedThreadDetail?.messages ?? [],
        serverQueuedMessageIds,
      }),
    [selectedThreadDetail, selectedThreadQueuedMessages, serverQueuedMessageIds],
  );
  const queuedTurnPromotionState =
    selectedThreadKey !== null ? queuedTurnPromotionRequests[selectedThreadKey] : undefined;
  const queuedMessagePromotionInFlight = queuedTurnPromotionState !== undefined;
  const deliveredQueuedMessageIds = useMemo(
    () => collectDeliveredMessageIds(selectedThreadDetail?.activities ?? []),
    [selectedThreadDetail],
  );
  const awaitingQueuedDeliveryIdsRef = useRef<string[]>([]);
  const [queuedGrokDrainActive, setQueuedGrokDrainActive] = useState(false);
  const isPromotingQueuedMessages =
    queuedMessagePromotionInFlight || (queuedGrokDrainActive && hasQueuedSendNow);
  useEffect(() => {
    awaitingQueuedDeliveryIdsRef.current = [];
    setQueuedGrokDrainActive(false);
  }, [selectedThreadKey]);

  useEffect(() => {
    if (!selectedThreadShell || !selectedThreadDetail || !queuedTurnPromotionState) {
      return;
    }
    const outcome = queuedTurnPromotionOutcome({
      state: queuedTurnPromotionState,
      projectedMessageIds: serverProjectedMessageIds,
      activities: selectedThreadDetail.activities,
    });
    if (outcome === null) return;
    clearQueuedTurnPromotionRequest(queuedTurnPromotionState);
    if (outcome.status === "failed") {
      setQueuedGrokDrainActive(false);
      awaitingQueuedDeliveryIdsRef.current = [];
      setPendingConnectionError(outcome.detail);
    }
  }, [
    queuedTurnPromotionState,
    selectedThreadDetail,
    selectedThreadShell,
    serverProjectedMessageIds,
  ]);

  const onPromoteQueuedMessages = useCallback(() => {
    if (!selectedThreadShell || !hasQueuedSendNow) return;
    const nextMessageId = nextQueuedMessageToPromote({
      queuedMessageIds: queuedSendNowMessageIds,
      deliveredMessageIds: deliveredQueuedMessageIds,
      promotionInFlight: queuedMessagePromotionInFlight,
      awaitingDeliveryMessageIds: awaitingQueuedDeliveryIdsRef.current,
    });
    if (nextMessageId === null) return;
    awaitingQueuedDeliveryIdsRef.current = [nextMessageId];
    setQueuedGrokDrainActive(true);
    requestQueuedTurnPromotion({
      commandId: CommandId.make(uuidv4()),
      environmentId: selectedThreadShell.environmentId,
      messageIds: [MessageId.make(nextMessageId)],
      serverProjectionRequiredMessageIds: localQueuedMessageIds.some(
        (messageId) => messageId === nextMessageId,
      )
        ? [MessageId.make(nextMessageId)]
        : [],
      threadId: selectedThreadShell.id,
    });
  }, [
    deliveredQueuedMessageIds,
    hasQueuedSendNow,
    localQueuedMessageIds,
    queuedMessagePromotionInFlight,
    queuedSendNowMessageIds,
    selectedThreadShell,
  ]);

  useEffect(() => {
    awaitingQueuedDeliveryIdsRef.current = awaitingQueuedDeliveryIdsRef.current.filter(
      (messageId) => !deliveredQueuedMessageIds.has(messageId),
    );
    if (!hasQueuedSendNow && awaitingQueuedDeliveryIdsRef.current.length === 0) {
      if (queuedGrokDrainActive) setQueuedGrokDrainActive(false);
      return;
    }
    const nextMessageId = nextQueuedMessageToPromote({
      queuedMessageIds: queuedSendNowMessageIds,
      deliveredMessageIds: deliveredQueuedMessageIds,
      promotionInFlight: queuedMessagePromotionInFlight,
      awaitingDeliveryMessageIds: awaitingQueuedDeliveryIdsRef.current,
    });
    if (nextMessageId === null) return;
    const delayMs = queuedMessageAutoPromoteDelayMs(queuedGrokDrainActive);
    const timer = setTimeout(() => {
      onPromoteQueuedMessages();
    }, delayMs);
    return () => clearTimeout(timer);
  }, [
    deliveredQueuedMessageIds,
    hasQueuedSendNow,
    onPromoteQueuedMessages,
    queuedGrokDrainActive,
    queuedMessagePromotionInFlight,
    queuedSendNowMessageIds,
  ]);

  const onSendMessage = useCallback(async () => {
    if (!selectedThreadShell) {
      return null;
    }

    const threadKey = scopedThreadKey(selectedThreadShell.environmentId, selectedThreadShell.id);
    const draft = getComposerDraftSnapshot(threadKey);
    const thread = selectedThreadDetail ?? selectedThreadShell;
    const text = draft.text.trim();
    const attachments = draft.attachments;
    if (text.length === 0 && attachments.length === 0) {
      onPromoteQueuedMessages();
      return null;
    }

    const metadata = makeQueuedMessageMetadata();
    const messageId = MessageId.make(metadata.messageId);
    try {
      await enqueueThreadOutboxMessage({
        environmentId: selectedThreadShell.environmentId,
        threadId: selectedThreadShell.id,
        messageId,
        commandId: CommandId.make(metadata.commandId),
        text,
        attachments,
        modelSelection: draft.modelSelection ?? thread.modelSelection,
        runtimeMode: draft.runtimeMode ?? thread.runtimeMode,
        interactionMode: draft.interactionMode ?? thread.interactionMode,
        createdAt: metadata.createdAt,
      });
      clearComposerDraftContent(threadKey);
      return messageId;
    } catch (error) {
      setPendingConnectionError(
        error instanceof Error ? error.message : "Failed to save the queued message.",
      );
      return null;
    }
  }, [onPromoteQueuedMessages, selectedThreadDetail, selectedThreadShell]);

  const onChangeDraftMessage = useCallback(
    (value: string) => {
      if (!selectedThreadShell) {
        return;
      }

      const threadKey = scopedThreadKey(selectedThreadShell.environmentId, selectedThreadShell.id);
      setComposerDraftText(threadKey, value);
    },
    [selectedThreadShell],
  );

  const onPickDraftImages = useCallback(async () => {
    if (!selectedThreadShell) {
      return;
    }

    const threadKey = scopedThreadKey(selectedThreadShell.environmentId, selectedThreadShell.id);
    const result = await pickComposerImages({
      existingCount: composerDrafts[threadKey]?.attachments.length ?? 0,
    });
    if (result.images.length > 0) {
      appendComposerDraftAttachments(threadKey, result.images);
    }
    if (result.error) {
      setPendingConnectionError(result.error);
    }
  }, [composerDrafts, selectedThreadShell]);

  const onPasteIntoDraft = useCallback(async () => {
    if (!selectedThreadShell) {
      return;
    }

    const threadKey = scopedThreadKey(selectedThreadShell.environmentId, selectedThreadShell.id);
    const result = await pasteComposerClipboard({
      existingCount: composerDrafts[threadKey]?.attachments.length ?? 0,
    });
    if (result.images.length > 0) {
      appendComposerDraftAttachments(threadKey, result.images);
    }
    if (result.text) {
      appendComposerDraftText(threadKey, result.text);
    }
    if (result.error) {
      setPendingConnectionError(result.error);
    }
  }, [composerDrafts, selectedThreadShell]);

  const onNativePasteImages = useCallback(
    async (uris: ReadonlyArray<string>) => {
      if (!selectedThreadShell || uris.length === 0) {
        return;
      }

      const threadKey = scopedThreadKey(selectedThreadShell.environmentId, selectedThreadShell.id);
      try {
        const images = await convertPastedImagesToAttachments({
          uris,
          existingCount: composerDrafts[threadKey]?.attachments.length ?? 0,
        });
        if (images.length > 0) {
          appendComposerDraftAttachments(threadKey, images);
        }
      } catch (error) {
        console.error("[native paste] error converting images", {
          environmentId: selectedThreadShell.environmentId,
          threadId: selectedThreadShell.id,
          uriCount: uris.length,
          ...safeErrorLogAttributes(error),
        });
      }
    },
    [composerDrafts, selectedThreadShell],
  );

  const onRemoveDraftImage = useCallback(
    (imageId: string) => {
      if (!selectedThreadShell) {
        return;
      }

      const threadKey = scopedThreadKey(selectedThreadShell.environmentId, selectedThreadShell.id);
      removeComposerDraftAttachment(threadKey, imageId);
    },
    [selectedThreadShell],
  );

  const onUpdateModelSelection = useCallback(
    (value: ModelSelection) => {
      if (!selectedThreadKey) {
        return;
      }
      updateComposerDraftSettings(selectedThreadKey, { modelSelection: value });
    },
    [selectedThreadKey],
  );

  const onUpdateRuntimeMode = useCallback(
    (value: RuntimeMode) => {
      if (!selectedThreadKey) {
        return;
      }
      updateComposerDraftSettings(selectedThreadKey, { runtimeMode: value });
    },
    [selectedThreadKey],
  );

  const onUpdateInteractionMode = useCallback(
    (value: ProviderInteractionMode) => {
      if (!selectedThreadKey) {
        return;
      }
      updateComposerDraftSettings(selectedThreadKey, { interactionMode: value });
    },
    [selectedThreadKey],
  );

  return {
    selectedThreadFeed,
    hasOlderHistory,
    olderHistoryMessageCount,
    olderHistoryLoading,
    onLoadOlderHistory,
    selectedThreadQueueCount: selectedThreadQueueCount + serverQueuedMessageIds.length,
    hasQueuedSendNow,
    isPromotingQueuedMessages,
    composerFocusRequest,
    onConsumeComposerFocusRequest,
    activeWorkStartedAt,
    draftMessage,
    draftAttachments,
    modelSelection,
    runtimeMode,
    interactionMode,
    activeThreadBusy,
    onChangeDraftMessage,
    onPickDraftImages,
    onPasteIntoDraft,
    onNativePasteImages,
    onRemoveDraftImage,
    onSendMessage,
    onPromoteQueuedMessages,
    onUpdateModelSelection,
    onUpdateRuntimeMode,
    onUpdateInteractionMode,
  };
}
