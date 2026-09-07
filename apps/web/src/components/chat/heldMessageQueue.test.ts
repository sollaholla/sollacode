import { describe, expect, it, vi } from "vite-plus/test";
import { createHeldMessageQueue } from "./heldMessageQueue";

function setup() {
  const queue = createHeldMessageQueue();
  const signals = new Map<string, (ready: boolean, idle: boolean) => void>();
  const add = (id: string, threadKey = "a", send = vi.fn(async () => {})) => {
    const restore = vi.fn();
    const dispose = vi.fn();
    queue.enqueue(
      {
        id,
        threadKey,
        text: `text ${id}`,
        attachmentCount: 1,
        prepare: async () => ({
          text: `text ${id}`,
          attachments: [
            {
              type: "image" as const,
              name: id,
              mimeType: "image/png",
              sizeBytes: 1,
              dataUrl: `data:${id}`,
            },
          ],
        }),
        send,
        restore,
        dispose,
      },
      (notify) => {
        signals.set(threadKey, notify);
        return () => {
          signals.delete(threadKey);
        };
      },
    );
    return { send, restore, dispose };
  };
  return { queue, signals, add };
}
const settle = async () => {
  for (let i = 0; i < 8; i++) await Promise.resolve();
};

describe("captured message queue", () => {
  it("holds multiple messages and attachments and sends in order after work clears", async () => {
    const { queue, signals, add } = setup();
    const first = add("1");
    const second = add("2");
    signals.get("a")!(false, false);
    expect(queue.store.getState().messages.map((message) => message.text)).toEqual([
      "text 1",
      "text 2",
    ]);
    expect(first.send).not.toHaveBeenCalled();
    signals.get("a")!(true, false);
    signals.get("a")!(true, false);
    await settle();
    expect(first.send).toHaveBeenCalledTimes(1);
    expect(second.send).not.toHaveBeenCalled();
    expect(first.send).toHaveBeenCalledWith({
      text: "text 1\n\ntext 2",
      attachments: [expect.objectContaining({ name: "1" }), expect.objectContaining({ name: "2" })],
    });
    expect(queue.store.getState().messages).toEqual([]);
    expect(first.dispose).toHaveBeenCalledTimes(1);
    expect(signals.size).toBe(0);
  });
  it("dispatches the originating thread while another thread is selected or busy", async () => {
    const { signals, add } = setup();
    const first = add("1", "a");
    const other = add("2", "b");
    signals.get("a")!(true, true);
    signals.get("b")!(false, false);
    await settle();
    expect(first.send).toHaveBeenCalledTimes(1);
    expect(other.send).not.toHaveBeenCalled();
  });
  it("retains rejected content, blocks successors, and retries explicitly", async () => {
    const { queue, signals, add } = setup();
    const send = vi
      .fn()
      .mockRejectedValueOnce(new Error("No credits"))
      .mockResolvedValue(undefined);
    add("1", "a", send);
    const second = add("2");
    signals.get("a")!(true, true);
    await settle();
    expect(queue.store.getState().messages[0]?.error).toBe("No credits");
    signals.get("a")!(true, true);
    expect(second.send).not.toHaveBeenCalled();
    queue.retry("1");
    await settle();
    expect(send).toHaveBeenCalledTimes(2);
    expect(queue.store.getState().messages.map((message) => message.id)).toEqual([]);
  });
  it("restores only the selected message and leaves the other queued entries intact", () => {
    const { queue, add } = setup();
    const first = add("1");
    add("2");
    queue.edit("1");
    expect(first.restore).toHaveBeenCalledTimes(1);
    expect(queue.store.getState().messages.map((message) => message.id)).toEqual(["2"]);
  });
  it("waits for command acceptance and never cancels a send already in flight", async () => {
    const { queue, signals, add } = setup();
    let accept = () => {};
    const receipt = new Promise<void>((resolve) => {
      accept = resolve;
    });
    const first = add(
      "1",
      "a",
      vi.fn(() => receipt),
    );
    const second = add("2");
    signals.get("a")!(true, false);
    queue.remove("1");
    signals.get("a")!(true, true);
    expect(second.send).not.toHaveBeenCalled();
    accept();
    await settle();
    expect(first.send).toHaveBeenCalledTimes(1);
    expect(second.send).not.toHaveBeenCalled();
    expect(queue.store.getState().messages).toEqual([]);
  });
});
