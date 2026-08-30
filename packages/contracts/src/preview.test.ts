import { Schema } from "effect";
import { describe, expect, it } from "vite-plus/test";

import {
  DiscoveredLocalServer,
  PreviewEvent,
  PreviewListInput,
  PreviewNavStatus,
  PreviewSessionSnapshot,
  PreviewRemoteSnapshotResult,
  PreviewViewportSetting,
} from "./preview.ts";
import {
  PREVIEW_AUTOMATION_OPERATIONS,
  PREVIEW_AUTOMATION_V1_OPERATIONS,
  PreviewAutomationCloseInput,
  PreviewAutomationCloseResult,
  PreviewAutomationDragInput,
  PreviewAutomationHost,
  PreviewAutomationError,
  PreviewAutomationOpenInput,
  PreviewAutomationOpenResult,
  PreviewAutomationResizeInput,
  PreviewAutomationResizeResult,
  PreviewAutomationStatus,
  PreviewAutomationUploadInput,
  PreviewAutomationWaitForDownloadResult,
} from "./previewAutomation.ts";
import { WsPreviewCloseRpc } from "./rpc.ts";

const decodePreviewEvent = Schema.decodeUnknownSync(PreviewEvent);
const decodePreviewListInput = Schema.decodeUnknownSync(PreviewListInput);
const decodeSnapshot = Schema.decodeUnknownSync(PreviewSessionSnapshot);
const decodeRemoteSnapshot = Schema.decodeUnknownSync(PreviewRemoteSnapshotResult);
const decodeNavStatus = Schema.decodeUnknownSync(PreviewNavStatus);
const decodeServer = Schema.decodeUnknownSync(DiscoveredLocalServer);
const decodeViewport = Schema.decodeUnknownSync(PreviewViewportSetting);
const decodeResizeInput = Schema.decodeUnknownSync(PreviewAutomationResizeInput);
const decodeDragInput = Schema.decodeUnknownSync(PreviewAutomationDragInput);
const decodeOpenInput = Schema.decodeUnknownSync(PreviewAutomationOpenInput);
const decodeOpenResult = Schema.decodeUnknownSync(PreviewAutomationOpenResult);
const decodeCloseInput = Schema.decodeUnknownSync(PreviewAutomationCloseInput);
const decodeCloseResult = Schema.decodeUnknownSync(PreviewAutomationCloseResult);
const decodeResizeResult = Schema.decodeUnknownSync(PreviewAutomationResizeResult);
const decodeAutomationHost = Schema.decodeUnknownSync(PreviewAutomationHost);
const decodeAutomationError = Schema.decodeUnknownSync(PreviewAutomationError);
const decodeAutomationStatus = Schema.decodeUnknownSync(PreviewAutomationStatus);
const decodeUploadInput = Schema.decodeUnknownSync(PreviewAutomationUploadInput);
const decodeWaitForDownloadResult = Schema.decodeUnknownSync(
  PreviewAutomationWaitForDownloadResult,
);

describe("preview close RPC compatibility", () => {
  it("proves a legacy Schema.Void client erases the authoritative result", () => {
    const decodeLegacySuccess = Schema.decodeUnknownSync(Schema.Void);

    expect(decodeLegacySuccess(undefined)).toBeUndefined();
    expect(
      decodeLegacySuccess({
        sessions: [],
        closedTabIds: [],
        serverEpoch: "epoch-1",
        revision: 1,
      }),
    ).toBeUndefined();
  });

  it("lets the current preview.close client accept old void and new results", () => {
    const decodeCurrentSuccess = Schema.decodeUnknownSync(WsPreviewCloseRpc.successSchema);

    expect(decodeCurrentSuccess(undefined)).toBeUndefined();
    expect(
      decodeCurrentSuccess({
        sessions: [],
        closedTabIds: ["tab-1"],
        serverEpoch: "epoch-1",
        revision: 1,
      }),
    ).toMatchObject({ closedTabIds: ["tab-1"], revision: 1 });
  });
});

describe("PreviewListInput", () => {
  it("supports both thread-local lists and environment-wide catch-up", () => {
    expect(decodePreviewListInput({ threadId: "thread-1" })).toEqual({
      threadId: "thread-1",
    });
    expect(decodePreviewListInput({})).toEqual({});
  });
});

describe("PreviewAutomationOpenInput", () => {
  it("accepts the inline preview visibility flag", () => {
    expect(decodeOpenInput({ open: false })).toEqual({ open: false });
  });

  it("retains the legacy show visibility alias", () => {
    expect(decodeOpenInput({ show: false })).toEqual({ show: false });
  });
});

describe("PreviewAutomationOpenResult", () => {
  const status = {
    available: true,
    visible: false,
    tabId: "tab-youtube",
    url: "https://www.youtube.com/",
    title: "YouTube",
    loading: false,
  } as const;

  it("describes an existing-domain choice without claiming a selected tab", () => {
    const result = decodeOpenResult({
      outcome: "selection-required",
      requestedUrl: "https://youtube.com/results?q=oldies",
      domain: "youtube.com",
      matchingTabs: [
        {
          tabId: "tab-youtube",
          url: "https://www.youtube.com/",
          title: "YouTube",
          loading: false,
          activeForUser: true,
          currentForAgent: false,
          reuseCall: {
            tool: "preview_open",
            arguments: {
              tabId: "tab-youtube",
              url: "https://youtube.com/results?q=oldies",
              open: false,
            },
          },
        },
      ],
      newTabCall: {
        tool: "preview_open",
        arguments: {
          url: "https://youtube.com/results?q=oldies",
          reuseExistingTab: false,
          open: false,
        },
      },
      message: "Choose an existing tab or explicitly create a new one.",
    });

    expect("outcome" in result && result.outcome).toBe("selection-required");
    if (!("outcome" in result) || result.outcome !== "selection-required") return;
    expect(result.matchingTabs[0]?.reuseCall.arguments.tabId).toBe("tab-youtube");
    expect(result.newTabCall.arguments.reuseExistingTab).toBe(false);
  });

  it("makes cleanup explicit only for a newly created tab", () => {
    const created = decodeOpenResult({
      outcome: "created",
      tabId: "tab-youtube",
      status,
      message: "Created tab-youtube; close it when finished.",
      cleanup: { tool: "preview_close", arguments: { tabId: "tab-youtube" } },
    });
    const reused = decodeOpenResult({
      outcome: "reused",
      tabId: "tab-youtube",
      status,
      message: "Reused tab-youtube; leave it open.",
    });

    expect(created).toMatchObject({
      outcome: "created",
      cleanup: { tool: "preview_close", arguments: { tabId: "tab-youtube" } },
    });
    expect(reused).toMatchObject({ outcome: "reused", tabId: "tab-youtube" });
    expect(reused).not.toHaveProperty("cleanup");
  });

  it("retains legacy status-only responses for mixed-version desktop hosts", () => {
    expect(decodeOpenResult(status)).toEqual(status);
  });
});

describe("PreviewAutomationCloseInput", () => {
  it("requires an exact tab and reports the surviving browser tab", () => {
    expect(decodeCloseInput({ tabId: "tab-created" })).toEqual({ tabId: "tab-created" });
    expect(() => decodeCloseInput({})).toThrow();
    expect(
      decodeCloseResult({
        closedTabId: "tab-created",
        tabId: "tab-blank",
        replacementCreated: true,
        message: "Closed tab-created and retained blank tab-blank.",
      }),
    ).toMatchObject({
      closedTabId: "tab-created",
      tabId: "tab-blank",
      replacementCreated: true,
    });
  });
});

describe("PreviewNavStatus", () => {
  it("decodes Idle", () => {
    expect(decodeNavStatus({ _tag: "Idle" })).toEqual({ _tag: "Idle" });
  });

  it("decodes Loading with title", () => {
    expect(decodeNavStatus({ _tag: "Loading", url: "http://localhost:5173/", title: "" })).toEqual({
      _tag: "Loading",
      url: "http://localhost:5173/",
      title: "",
    });
  });

  it("decodes LoadFailed with code/description", () => {
    expect(
      decodeNavStatus({
        _tag: "LoadFailed",
        url: "https://example.com/",
        title: "Example",
        code: -105,
        description: "ERR_NAME_NOT_RESOLVED",
      }),
    ).toEqual({
      _tag: "LoadFailed",
      url: "https://example.com/",
      title: "Example",
      code: -105,
      description: "ERR_NAME_NOT_RESOLVED",
    });
  });

  it("rejects empty url", () => {
    expect(() => decodeNavStatus({ _tag: "Loading", url: "", title: "" })).toThrow();
  });
});

describe("PreviewSessionSnapshot", () => {
  it("round-trips a Success snapshot", () => {
    const snapshot = decodeSnapshot({
      threadId: "thread-1",
      tabId: "preview-thread-1",
      navStatus: {
        _tag: "Success",
        url: "http://localhost:5173/",
        title: "Vite App",
      },
      canGoBack: false,
      canGoForward: false,
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    expect(snapshot.tabId).toBe("preview-thread-1");
    expect(snapshot.navStatus._tag).toBe("Success");
  });
});

describe("PreviewRemoteSnapshotResult", () => {
  it("accepts the bounded mobile frame without browser diagnostic payloads", () => {
    const frame = decodeRemoteSnapshot({
      tabId: "preview-thread-1",
      url: "https://example.com/",
      title: "Example",
      loading: false,
      capturedAt: "2026-08-26T00:00:00.000Z",
      screenshot: {
        mimeType: "image/jpeg",
        data: "encoded-frame",
        width: 1024,
        height: 640,
      },
    });
    expect(frame.screenshot.width).toBe(1024);
    expect(frame).not.toHaveProperty("visibleText");
  });
});

describe("PreviewViewportSetting", () => {
  it("decodes fill, freeform, and preset modes", () => {
    expect(decodeViewport({ _tag: "fill" })).toEqual({ _tag: "fill" });
    expect(decodeViewport({ _tag: "freeform", width: 1024, height: 768 })).toEqual({
      _tag: "freeform",
      width: 1024,
      height: 768,
    });
    expect(
      decodeViewport({
        _tag: "preset",
        presetId: "iphone-15-pro",
        width: 393,
        height: 852,
      }),
    ).toMatchObject({ _tag: "preset", presetId: "iphone-15-pro" });
  });

  it("rejects unsafe dimensions and oversized render areas", () => {
    expect(() => decodeViewport({ _tag: "freeform", width: 100, height: 800 })).toThrow();
    expect(() => decodeViewport({ _tag: "freeform", width: 3840, height: 3840 })).toThrow();
  });
});

describe("PreviewAutomationResizeInput", () => {
  it("requires fields that match the selected mode", () => {
    expect(decodeResizeInput({ mode: "fill" })).toEqual({ mode: "fill" });
    expect(
      decodeResizeInput({ mode: "preset", preset: "pixel-7", orientation: "landscape" }),
    ).toMatchObject({ mode: "preset", preset: "pixel-7" });
    expect(() => decodeResizeInput({ mode: "preset", preset: "pixel-8" })).toThrow();
    expect(() => decodeResizeInput({ mode: "freeform", width: 1024 })).toThrow();
    expect(() => decodeResizeInput({ mode: "fill", width: 1024, height: 768 })).toThrow();
  });

  it("allows fill-mode measurements below the minimum selectable fixed size", () => {
    expect(
      decodeResizeResult({
        tabId: "preview-t",
        setting: { _tag: "fill" },
        viewport: { width: 180, height: 120 },
      }).viewport,
    ).toEqual({ width: 180, height: 120 });
  });
});

describe("PreviewAutomationDragInput", () => {
  it("accepts a straight from/to drag and a multi-point path", () => {
    expect(decodeDragInput({ from: { x: 10, y: 20 }, to: { x: 100, y: 200 } })).toEqual({
      from: { x: 10, y: 20 },
      to: { x: 100, y: 200 },
    });
    expect(
      decodeDragInput({
        path: [
          { x: 0, y: 0 },
          { x: 40, y: 40 },
          { x: 80, y: 10 },
        ],
        steps: 12,
        holdMs: 50,
        button: "left",
      }),
    ).toMatchObject({
      path: [
        { x: 0, y: 0 },
        { x: 40, y: 40 },
        { x: 80, y: 10 },
      ],
      steps: 12,
      holdMs: 50,
      button: "left",
    });
  });

  it("rejects mixing from/to with path, a lone endpoint, and a single-point path", () => {
    expect(() =>
      decodeDragInput({ from: { x: 1, y: 1 }, to: { x: 2, y: 2 }, path: [{ x: 0, y: 0 }] }),
    ).toThrow();
    expect(() => decodeDragInput({ from: { x: 1, y: 1 } })).toThrow();
    expect(() => decodeDragInput({ path: [{ x: 0, y: 0 }] })).toThrow();
    expect(() => decodeDragInput({})).toThrow();
  });

  it("bounds interpolation steps and carries an explicit tab target", () => {
    expect(() => decodeDragInput({ from: { x: 1, y: 1 }, to: { x: 2, y: 2 }, steps: 0 })).toThrow();
    expect(() =>
      decodeDragInput({ from: { x: 1, y: 1 }, to: { x: 2, y: 2 }, steps: 65 }),
    ).toThrow();
    expect(
      decodeDragInput({ tabId: "tab-canvas", from: { x: 1, y: 1 }, to: { x: 2, y: 2 } }),
    ).toMatchObject({ tabId: "tab-canvas" });
  });
});

describe("preview automation tab targeting", () => {
  it("accepts an explicit tab and rejects contradictory open behavior", () => {
    expect(decodeResizeInput({ tabId: "tab-app", mode: "fill" })).toMatchObject({
      tabId: "tab-app",
      mode: "fill",
    });
    expect(decodeOpenInput({ tabId: "tab-app", reuseExistingTab: true })).toMatchObject({
      tabId: "tab-app",
      reuseExistingTab: true,
    });
    expect(() => decodeOpenInput({ tabId: "tab-app", reuseExistingTab: false })).toThrow();
  });
});

describe("PreviewAutomationHost", () => {
  it("accepts legacy hosts and current operation advertisements", () => {
    expect(decodeAutomationHost({ clientId: "legacy", environmentId: "environment-1" })).toEqual({
      clientId: "legacy",
      environmentId: "environment-1",
    });
    expect(
      decodeAutomationHost({
        clientId: "current",
        environmentId: "environment-1",
        supportedOperations: ["status", "resize"],
      }).supportedOperations,
    ).toEqual(["status", "resize"]);
    expect(PREVIEW_AUTOMATION_OPERATIONS).toContain("close");
    expect(PREVIEW_AUTOMATION_OPERATIONS).toContain("upload");
    expect(PREVIEW_AUTOMATION_OPERATIONS).toContain("drag");
    expect(PREVIEW_AUTOMATION_V1_OPERATIONS).not.toContain("close");
    expect(PREVIEW_AUTOMATION_V1_OPERATIONS).not.toContain("upload");
    expect(PREVIEW_AUTOMATION_V1_OPERATIONS).not.toContain("drag");
  });
});

describe("PreviewAutomationUploadInput", () => {
  it("accepts absolute local paths and an optional file-input locator", () => {
    expect(
      decodeUploadInput({
        paths: ["/tmp/MedXRNativePrototype.apk"],
        locator: "css=input[type=file]",
      }),
    ).toEqual({
      paths: ["/tmp/MedXRNativePrototype.apk"],
      locator: "css=input[type=file]",
    });
  });

  it("rejects an empty file list or competing target modes", () => {
    expect(() => decodeUploadInput({ paths: [] })).toThrow();
    expect(() =>
      decodeUploadInput({ paths: ["/tmp/file"], locator: "css=input", selector: "input" }),
    ).toThrow();
  });
});

describe("PreviewAutomationError", () => {
  it("preserves a typed non-editable target failure", () => {
    const error = decodeAutomationError({
      _tag: "PreviewAutomationTargetNotEditableError",
      operation: "type",
      environmentId: "environment-1",
      threadId: "thread-1",
      providerSessionId: "provider-session-1",
      providerInstanceId: "codex",
      clientId: "client-1",
      connectionId: "connection-1",
      requestId: "request-1",
      tabId: "tab-1",
      timeoutMs: 1_000,
      remoteTag: "PreviewAutomationTargetNotEditableError",
      remoteMessageLength: 12,
      cause: {},
      selectorKind: "focused-element",
    });

    expect(error._tag).toBe("PreviewAutomationTargetNotEditableError");
    if (error._tag === "PreviewAutomationTargetNotEditableError") {
      expect(error.selectorKind).toBe("focused-element");
      expect(error.message).toBe("Preview automation type requires an editable focused element.");
    }
  });

  it("tells an agent not to reuse another agent's dedicated tab", () => {
    const error = decodeAutomationError({
      _tag: "PreviewAutomationForeignAgentTabError",
      operation: "snapshot",
      environmentId: "environment-1",
      threadId: "thread-1",
      providerSessionId: "provider-session-1",
      providerInstanceId: "codex",
      clientId: "client-1",
      connectionId: "connection-1",
      requestId: "request-1",
      tabId: "tab_70d23993-1e1d-4caf-b190-0265822665c4",
      timeoutMs: 1_000,
      remoteTag: "PreviewAutomationForeignAgentTabError",
      remoteMessageLength: 80,
      cause: {},
    });

    expect(error._tag).toBe("PreviewAutomationForeignAgentTabError");
    expect(error.message).toContain("another agent's dedicated browser");
    expect(error.message).toContain("Use this agent's own tabs only");
    expect(error.message).toContain("Do not reuse tab IDs from other agents");
    expect(error.message).toContain("tab_70d23993-1e1d-4caf-b190-0265822665c4");
  });
});

describe("PreviewAutomationStatus", () => {
  it("accepts old hosts without viewport data and exposes it from current hosts", () => {
    const base = {
      available: true,
      visible: false,
      tabId: "preview-t",
      url: "https://example.com",
      title: "Example",
      loading: false,
    };
    expect(decodeAutomationStatus(base)).toEqual(base);
    expect(
      decodeAutomationStatus({
        ...base,
        viewportSetting: { _tag: "preset", presetId: "pixel-8", width: 412, height: 915 },
        viewport: { width: 412, height: 915 },
      }).viewport,
    ).toEqual({ width: 412, height: 915 });
  });

  it("exposes navigation load failures while remaining compatible with old hosts", () => {
    const base = {
      available: true,
      visible: false,
      tabId: "preview-t",
      url: "https://example.invalid",
      title: "",
      loading: false,
    };

    expect(decodeAutomationStatus(base)).toEqual(base);
    expect(
      decodeAutomationStatus({
        ...base,
        loadFailure: {
          code: -105,
          description: "ERR_NAME_NOT_RESOLVED",
        },
      }).loadFailure,
    ).toEqual({ code: -105, description: "ERR_NAME_NOT_RESOLVED" });
  });

  it("accepts a typed human-verification handoff while remaining compatible with old hosts", () => {
    const status = decodeAutomationStatus({
      available: true,
      visible: true,
      tabId: "preview-t",
      url: "https://suno.com/create",
      title: "Verify you are human",
      loading: false,
      humanVerification: {
        state: "human_verification_required",
        kind: "bot-detection",
        code: "600010",
        detectedAt: "2026-08-26T12:00:00.000Z",
        url: "https://suno.com/create",
        retryCount: 0,
        retryAvailable: false,
        message: "Automation is paused for this tab.",
        compatibilityCheckUrl: "https://debug.challenges.cloudflare.com/",
        feedbackUrl:
          "https://developers.cloudflare.com/turnstile/troubleshooting/feedback-reports/",
        diagnostic: {
          browserProduct: null,
          browserVersion: null,
          browserUserAgent: null,
          embeddedBrowser: true,
          headedBrowser: true,
          automationAvailable: true,
          cdpAttached: true,
          viewportMode: null,
          colorSchemeOverride: null,
          userAgentOverride: null,
          canvasOverride: null,
          webglOverride: null,
          extensionsEnabled: null,
          proxyOrVpn: null,
          cfMitigated: null,
          responseStatusCode: null,
          challengesCloudflareReachable: null,
          rayId: null,
          qrIdentifier: null,
          systemClockIso: "2026-08-26T12:00:00.000Z",
          systemClockCorrect: null,
        },
      },
    });

    expect(status.humanVerification).toMatchObject({
      state: "human_verification_required",
      kind: "bot-detection",
      code: "600010",
    });
  });

  it("accepts a download-approval flag while remaining compatible with old hosts", () => {
    const base = {
      available: true,
      visible: true,
      tabId: "preview-t",
      url: "https://example.com/file",
      title: "File",
      loading: false,
    };
    expect(decodeAutomationStatus(base)).toEqual(base);
    expect(
      decodeAutomationStatus({ ...base, downloadApprovalRequired: true }).downloadApprovalRequired,
    ).toBe(true);
  });

  it("accepts a wait-for-download waiting message while remaining compatible with old hosts", () => {
    const base = {
      tabId: "preview-t",
      settled: false,
      downloads: [],
      pendingDownloadApprovals: [
        { id: "download-approval-1", domain: "grok.com", fileName: "a.bin" },
      ],
    };
    expect(decodeWaitForDownloadResult(base)).toEqual(base);
    expect(
      decodeWaitForDownloadResult({
        ...base,
        outcome: "waiting",
        message: "Do not retry the fetch. End the turn now; in Agent mode emit AGENT_STOP.",
      }).message,
    ).toContain("AGENT_STOP");
  });
});

describe("PreviewEvent", () => {
  it("decodes opened", () => {
    const event = decodePreviewEvent({
      type: "opened",
      threadId: "t",
      tabId: "preview-t",
      createdAt: "2026-01-01T00:00:00.000Z",
      serverEpoch: "server-a",
      revision: 1,
      snapshot: {
        threadId: "t",
        tabId: "preview-t",
        navStatus: { _tag: "Idle" },
        canGoBack: false,
        canGoForward: false,
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
    });
    expect(event.type).toBe("opened");
  });

  it("decodes failed with code/description", () => {
    const event = decodePreviewEvent({
      type: "failed",
      threadId: "t",
      tabId: "preview-t",
      createdAt: "2026-01-01T00:00:00.000Z",
      serverEpoch: "server-a",
      revision: 1,
      url: "https://example.com/",
      title: "",
      code: -105,
      description: "ERR_NAME_NOT_RESOLVED",
    });
    expect(event.type).toBe("failed");
    if (event.type === "failed") {
      expect(event.code).toBe(-105);
    }
  });

  it("decodes resized with tab viewport state", () => {
    const event = decodePreviewEvent({
      type: "resized",
      threadId: "t",
      tabId: "preview-t",
      createdAt: "2026-01-01T00:00:00.000Z",
      serverEpoch: "server-a",
      revision: 1,
      snapshot: {
        threadId: "t",
        tabId: "preview-t",
        navStatus: { _tag: "Idle" },
        canGoBack: false,
        canGoForward: false,
        viewport: { _tag: "freeform", width: 1024, height: 768 },
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
    });
    expect(event.type).toBe("resized");
  });

  it("decodes closed without snapshot", () => {
    const event = decodePreviewEvent({
      type: "closed",
      threadId: "t",
      tabId: "preview-t",
      createdAt: "2026-01-01T00:00:00.000Z",
      serverEpoch: "server-a",
      revision: 1,
    });
    expect(event.type).toBe("closed");
  });
});

describe("DiscoveredLocalServer", () => {
  it("decodes a server with process metadata", () => {
    const server = decodeServer({
      host: "localhost",
      port: 5173,
      url: "http://localhost:5173",
      processName: "node",
      pid: 12345,
      terminal: null,
    });
    expect(server.port).toBe(5173);
    expect(server.processName).toBe("node");
  });

  it("decodes a server without process metadata", () => {
    const server = decodeServer({
      host: "localhost",
      port: 3000,
      url: "http://localhost:3000",
      processName: null,
      pid: null,
      terminal: null,
    });
    expect(server.processName).toBeNull();
  });

  it("rejects invalid ports", () => {
    expect(() =>
      decodeServer({
        host: "localhost",
        port: 0,
        url: "http://localhost:0",
        processName: null,
        pid: null,
        terminal: null,
      }),
    ).toThrow();
    expect(() =>
      decodeServer({
        host: "localhost",
        port: 70000,
        url: "http://localhost:70000",
        processName: null,
        pid: null,
        terminal: null,
      }),
    ).toThrow();
  });
});
