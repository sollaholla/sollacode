// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  OfflineOutboxChip,
  OfflineOutboxDetails,
  type OfflineOutboxChipPhase,
  type OfflineOutboxMessage,
  outboxShowDelayMs,
  useOfflineOutboxChipPhase,
} from "./OfflineOutbox";

const NOW = Date.parse("2026-09-26T14:05:00.000Z");

const message = (overrides: Partial<OfflineOutboxMessage> = {}): OfflineOutboxMessage => ({
  id: "command-1",
  text: "Ship the fix tonight",
  attachmentCount: 0,
  savedAt: new Date(NOW).toISOString(),
  error: undefined,
  ...overrides,
});

const noop = () => undefined;

describe("outbox chip timing", () => {
  let phase: OfflineOutboxChipPhase = "hidden";
  let root: ReturnType<typeof createRoot>;
  let container: HTMLDivElement;

  function Probe(props: { readonly messages: ReadonlyArray<OfflineOutboxMessage> }) {
    phase = useOfflineOutboxChipPhase(props.messages);
    return null;
  }

  const render = async (messages: ReadonlyArray<OfflineOutboxMessage>) => {
    await act(async () => {
      root.render(<Probe messages={messages} />);
    });
  };
  const wait = async (ms: number) => {
    await act(async () => {
      vi.advanceTimersByTime(ms);
    });
  };

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    container = document.createElement("div");
    root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("stays out of sight for a message that goes out within a moment", async () => {
    await render([message()]);
    await wait(2_000);
    expect(phase).toBe("hidden");
    await render([]);
    await wait(10_000);
    expect(phase).toBe("hidden");
  });

  it("appears once a message has been waiting, and lingers as Sent", async () => {
    await render([message()]);
    await wait(3_000);
    expect(phase).toBe("waiting");

    await render([]);
    expect(phase).toBe("sent");
    // A drop during the linger picks up where it was instead of flashing.
    await wait(2_000);
    await render([message({ id: "command-2", savedAt: new Date(NOW + 5_000).toISOString() })]);
    expect(phase).toBe("waiting");

    await render([]);
    await wait(4_000);
    expect(phase).toBe("hidden");
  });

  it("shows a refused message at once", async () => {
    await render([message({ error: "The thread was deleted." })]);
    expect(phase).toBe("failed");
  });

  it("counts the wait from when the message was saved", () => {
    expect(outboxShowDelayMs(new Date(NOW).toISOString(), NOW + 1_000)).toBe(2_000);
    expect(outboxShowDelayMs(new Date(NOW).toISOString(), NOW + 60_000)).toBe(0);
    expect(outboxShowDelayMs("not a date", NOW)).toBe(3_000);
  });
});

describe("OfflineOutboxChip", () => {
  const renderChip = (
    phase: Exclude<OfflineOutboxChipPhase, "hidden">,
    messages: ReadonlyArray<OfflineOutboxMessage>,
  ) =>
    renderToStaticMarkup(
      <OfflineOutboxChip
        phase={phase}
        messages={messages}
        timestampFormat="24-hour"
        onRetry={noop}
        onDiscard={noop}
      />,
    );

  it("is one short chip that opens the details", () => {
    const markup = renderChip("waiting", [message(), message({ id: "command-2" })]);
    expect(markup).toContain('data-offline-outbox="waiting"');
    expect(markup).toContain('aria-label="2 messages waiting to send. Show details."');
    expect(markup).toContain(">Waiting to send<");
    expect(markup).toContain(">Waiting<");
    expect(markup).toContain(">2<");
    // The list stays behind the tap.
    expect(markup).not.toContain("Ship the fix tonight");
  });

  it("turns red when a saved message was refused", () => {
    const markup = renderChip("failed", [message({ error: "Refused" })]);
    expect(markup).toContain('data-offline-outbox="failed"');
    expect(markup).toContain(">Not sent<");
    expect(markup).toContain("text-destructive");
  });

  it("says Sent without anything to open", () => {
    const markup = renderChip("sent", []);
    expect(markup).toContain(">Sent</span>");
    expect(markup).not.toContain("<button");
  });
});

describe("OfflineOutboxDetails", () => {
  it("lists each waiting message with when it was saved, and no actions", () => {
    const markup = renderToStaticMarkup(
      <OfflineOutboxDetails
        messages={[
          message(),
          message({ id: "command-2", text: "And the docs", attachmentCount: 2 }),
        ]}
        timestampFormat="24-hour"
        onRetry={noop}
        onDiscard={noop}
      />,
    );
    expect(markup).toContain("2 messages waiting to send");
    expect(markup).toContain("Ship the fix tonight");
    expect(markup).toContain("Saved ");
    expect(markup).toContain("2 attachments");
    expect(markup).not.toContain("Retry");
  });

  it("offers Retry and Discard for a refused message", () => {
    const markup = renderToStaticMarkup(
      <OfflineOutboxDetails
        messages={[message({ error: "The thread was deleted." }), message({ id: "b" })]}
        timestampFormat="24-hour"
        onRetry={noop}
        onDiscard={noop}
      />,
    );
    expect(markup).toContain("A saved message couldn&#x27;t be sent");
    expect(markup).toContain("The thread was deleted.");
    expect(markup.match(/>Retry</g)).toHaveLength(1);
    expect(markup.match(/>Discard</g)).toHaveLength(1);
  });
});
