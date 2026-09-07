import { create } from "zustand";

export interface HeldMessageContent {
  readonly text: string;
  readonly attachments: readonly {
    type: "image";
    name: string;
    mimeType: string;
    sizeBytes: number;
    dataUrl: string;
  }[];
}

export interface HeldMessage {
  readonly id: string;
  readonly threadKey: string;
  readonly text: string;
  readonly attachmentCount: number;
  readonly prepare: () => Promise<HeldMessageContent>;
  readonly send: (content: HeldMessageContent) => Promise<void>;
  readonly accepted?: () => void;
  readonly restore: () => void;
  readonly dispose: () => void;
  readonly status: "queued" | "sending" | "failed";
  readonly error?: string | undefined;
}

/** Owns captured messages independently of the mounted chat and its editable draft. */
export function createHeldMessageQueue() {
  const store = create<{ messages: readonly HeldMessage[] }>(() => ({ messages: [] }));
  const watches = new Map<string, () => void>();
  const signals = new Map<string, { ready: boolean; idle: boolean; revision: number }>();
  const busy = new Set<string>();
  const awaitingIdle = new Set<string>();
  const update = (id: string, change: Partial<HeldMessage>) =>
    store.setState(({ messages }) => ({
      messages: messages.map((message) =>
        message.id === id ? { ...message, ...change } : message,
      ),
    }));
  const remove = (id: string) => {
    const message = store.getState().messages.find((entry) => entry.id === id);
    if (!message) return;
    store.setState(({ messages }) => ({ messages: messages.filter((entry) => entry.id !== id) }));
    message.dispose();
    if (!store.getState().messages.some((entry) => entry.threadKey === message.threadKey)) {
      watches.get(message.threadKey)?.();
      watches.delete(message.threadKey);
      awaitingIdle.delete(message.threadKey);
      signals.delete(message.threadKey);
    }
  };
  const drain = async (threadKey: string, ready: boolean, idle: boolean) => {
    if (busy.has(threadKey) || !ready) return;
    if (awaitingIdle.has(threadKey) && !idle) return;
    const message = store.getState().messages.find((entry) => entry.threadKey === threadKey);
    if (!message || message.status !== "queued") return;
    const batch = store.getState().messages.filter((entry) => entry.threadKey === threadKey);
    if (batch.some((entry) => entry.status !== "queued")) return;
    const revision = signals.get(threadKey)?.revision;
    busy.add(threadKey);
    for (const entry of batch) update(entry.id, { status: "sending", error: undefined });
    try {
      const contents = await Promise.all(batch.map((entry) => entry.prepare()));
      await message.send({
        text: contents.map((content) => content.text).join("\n\n"),
        attachments: contents.flatMap((content) => content.attachments),
      });
      awaitingIdle.add(threadKey);
      for (const entry of batch) {
        entry.accepted?.();
        remove(entry.id);
      }
    } catch (error) {
      for (const entry of batch)
        update(entry.id, {
          status: "failed",
          error:
            error instanceof Error ? error.message : "Could not send message. Retry or edit it.",
        });
    } finally {
      busy.delete(threadKey);
      const signal = signals.get(threadKey);
      if (signal && signal.revision !== revision) void drain(threadKey, signal.ready, signal.idle);
    }
  };
  return {
    store,
    enqueue(
      message: Omit<HeldMessage, "status">,
      watch: (notify: (ready: boolean, idle: boolean) => void) => () => void,
    ) {
      store.setState(({ messages }) => ({
        messages: [...messages, { ...message, status: "queued" }],
      }));
      if (!watches.has(message.threadKey)) {
        watches.set(
          message.threadKey,
          watch((ready, idle) => {
            signals.set(message.threadKey, {
              ready,
              idle,
              revision: (signals.get(message.threadKey)?.revision ?? 0) + 1,
            });
            void drain(message.threadKey, ready, idle);
          }),
        );
      }
    },
    retry(id: string) {
      const message = store.getState().messages.find((entry) => entry.id === id);
      if (message)
        for (const entry of store.getState().messages) {
          if (entry.threadKey === message.threadKey && entry.status === "failed")
            update(entry.id, { status: "queued", error: undefined });
        }
      const signal = message && signals.get(message.threadKey);
      if (message && signal) void drain(message.threadKey, signal.ready, signal.idle);
    },
    remove(id: string) {
      if (store.getState().messages.find((entry) => entry.id === id)?.status === "sending") return;
      const message = store.getState().messages.find((entry) => entry.id === id);
      remove(id);
      const signal = message && signals.get(message.threadKey);
      if (message && signal) void drain(message.threadKey, signal.ready, signal.idle);
    },
    edit(id: string) {
      const message = store.getState().messages.find((entry) => entry.id === id);
      if (!message || message.status === "sending") return;
      message.restore();
      remove(id);
      const signal = signals.get(message.threadKey);
      if (signal) void drain(message.threadKey, signal.ready, signal.idle);
    },
  };
}

export const heldMessageQueue = createHeldMessageQueue();
