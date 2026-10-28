import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { QueuedMessagesChip, QueuedMessagesDetails } from "./QueuedMessagesChip";

describe("QueuedMessagesChip", () => {
  it("is a rail chip with the count, keeping the messages in its popup", () => {
    const markup = renderToStaticMarkup(
      <QueuedMessagesChip count={2} failedCount={0} status="Joining the running turn">
        {() => <p>First queued message</p>}
      </QueuedMessagesChip>,
    );

    expect(markup).toContain('data-chat-composer-status-chip="queued-messages"');
    expect(markup).toContain('aria-label="2 queued messages. Show queued messages."');
    expect(markup).toContain('title="2 queued messages · Joining the running turn"');
    expect(markup).toContain("text-amber-700");
    expect(markup).not.toContain("First queued message");
  });

  it("turns red when a queued message failed to send", () => {
    const markup = renderToStaticMarkup(
      <QueuedMessagesChip count={2} failedCount={1} status="Sends when the current work finishes">
        {() => null}
      </QueuedMessagesChip>,
    );

    expect(markup).toContain("A queued message couldn&#x27;t be sent. Show queued messages.");
    expect(markup).toContain("text-destructive");
  });

  it("explains what is waiting and why above the messages", () => {
    const markup = renderToStaticMarkup(
      <QueuedMessagesDetails summary="1 queued message" status="Waiting for usage budget">
        <p>Queued text</p>
      </QueuedMessagesDetails>,
    );

    expect(markup).toContain('aria-label="Queued messages"');
    expect(markup).toContain("Waiting for usage budget");
    expect(markup).toContain("Queued text");
  });
});
