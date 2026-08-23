import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

const { usePreviewSession } = vi.hoisted(() => ({ usePreviewSession: vi.fn() }));

vi.mock("./usePreviewSession", () => ({ usePreviewSession }));

import { PreviewSessionHydrator } from "./PreviewSessionHydrator";

describe("PreviewSessionHydrator", () => {
  it("starts thread synchronization without rendering a Browser surface", () => {
    const threadRef = scopeThreadRef(
      EnvironmentId.make("environment-1"),
      ThreadId.make("thread-1"),
    );

    expect(renderToStaticMarkup(<PreviewSessionHydrator threadRef={threadRef} />)).toBe("");
    expect(usePreviewSession).toHaveBeenCalledWith(threadRef);
  });
});
