// @vitest-environment happy-dom

import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

import {
  rememberTimelineThreadScroll,
  type TimelineThreadScrollMemory,
} from "./timelineScrollAnchoring";
import { useTimelineInitialScroll } from "./useTimelineInitialScroll";

let root: Root;
let container: HTMLDivElement;
let memories: Map<string, TimelineThreadScrollMemory>;

function Thread({ threadKey }: { threadKey: string }) {
  const restored = useTimelineInitialScroll(memories, threadKey);
  const [followEnd, setFollowEnd] = useState(true);
  return (
    <div
      data-initial-at-end={restored?.followEnd ?? true}
      data-initial-offset={restored?.followEnd === false ? restored.scrollOffset : "none"}
      data-follow-end={followEnd}
      onTouchMove={() => {
        rememberTimelineThreadScroll(memories, threadKey, {
          scrollOffset: 950,
          followEnd: false,
        });
        setFollowEnd(false);
      }}
    />
  );
}

async function render(threadKey: string) {
  await act(async () => root.render(<Thread threadKey={threadKey} />));
}

function timeline() {
  return container.firstElementChild as HTMLDivElement;
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  memories = new Map();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

it("keeps a mounted thread's initial destination when an upward gesture saves reading mode", async () => {
  await render("thread-a");
  const mountedTimeline = timeline();
  expect(mountedTimeline.dataset.initialAtEnd).toBe("true");

  await act(async () => {
    mountedTimeline.dispatchEvent(new Event("touchmove", { bubbles: true }));
  });

  expect(timeline()).toBe(mountedTimeline);
  expect(timeline().dataset.followEnd).toBe("false");
  expect(memories.get("thread-a")).toEqual({ scrollOffset: 950, followEnd: false });
  expect(timeline().dataset.initialAtEnd).toBe("true");
  expect(timeline().dataset.initialOffset).toBe("none");

  // Streamed output can re-render the parent after more momentum events.
  rememberTimelineThreadScroll(memories, "thread-a", { scrollOffset: 700, followEnd: false });
  await render("thread-a");
  expect(timeline().dataset.initialAtEnd).toBe("true");
  expect(timeline().dataset.initialOffset).toBe("none");

  await render("thread-b");
  await render("thread-a");
  expect(timeline().dataset.initialAtEnd).toBe("false");
  expect(timeline().dataset.initialOffset).toBe("700");
});

it("keeps a restored reading offset until leaving the thread, including a manual return to the end", async () => {
  rememberTimelineThreadScroll(memories, "thread-a", { scrollOffset: 400, followEnd: false });
  await render("thread-a");
  expect(timeline().dataset.initialOffset).toBe("400");

  rememberTimelineThreadScroll(memories, "thread-a", { scrollOffset: 0, followEnd: true });
  await render("thread-a");
  expect(timeline().dataset.initialAtEnd).toBe("false");
  expect(timeline().dataset.initialOffset).toBe("400");

  await render("thread-b");
  await render("thread-a");
  expect(timeline().dataset.initialAtEnd).toBe("true");
  expect(timeline().dataset.initialOffset).toBe("none");
});
