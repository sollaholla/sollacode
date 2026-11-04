// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vite-plus/test";

import { QueuedMessagesChip } from "./QueuedMessagesChip";

afterEach(() => {
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});

it("opens itself when a message joins the queue, leaving focus in the composer", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const composer = document.createElement("textarea");
  const host = document.createElement("div");
  document.body.append(composer, host);
  composer.focus();
  const root = createRoot(host);
  const render = (revealSeq: number) =>
    act(async () => {
      root.render(
        <QueuedMessagesChip count={1} failedCount={0} status="Joining" revealSeq={revealSeq}>
          {() => <p>First queued message</p>}
        </QueuedMessagesChip>,
      );
    });

  // Arriving at a thread that already has a queue does not open it.
  await render(0);
  expect(document.body.textContent).not.toContain("First queued message");

  await render(1);
  expect(document.body.textContent).toContain("First queued message");
  expect(document.activeElement).toBe(composer);

  await act(async () => root.unmount());
});
