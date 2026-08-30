import {
  PreviewAutomationClickInput,
  PreviewAutomationDragInput,
  PreviewAutomationCloseInput,
  PreviewAutomationCloseResult,
  PreviewAutomationError,
  PreviewAutomationEvaluateInput,
  PreviewAutomationNavigateInput,
  PreviewAutomationOpenInput,
  PreviewAutomationOpenResult,
  PreviewAutomationPressInput,
  PreviewAutomationRecordingArtifact,
  PreviewAutomationRecordingStatus,
  PreviewAutomationResizeInput,
  PreviewAutomationResizeResult,
  PreviewAutomationScrollInput,
  PreviewAutomationSetColorSchemeInput,
  PreviewAutomationSetColorSchemeResult,
  PreviewAutomationSnapshot,
  PreviewAutomationWaitForDownloadInput,
  PreviewAutomationWaitForDownloadResult,
  PreviewAutomationStatus,
  PreviewAutomationTabTargetInput,
  PreviewAutomationTypeInput,
  PreviewAutomationUploadInput,
  PreviewAutomationUploadResult,
  PreviewAutomationWaitForInput,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/unstable/ai";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as PreviewAutomationBroker from "../../PreviewAutomationBroker.ts";

const dependencies = [
  McpInvocationContext.McpInvocationContext,
  PreviewAutomationBroker.PreviewAutomationBroker,
];

const browserTool = <T extends Tool.Any>(tool: T): T =>
  tool.annotate(Tool.OpenWorld, true).annotate(Tool.Destructive, true) as T;

const safeBrowserTool = <T extends Tool.Any>(tool: T): T =>
  browserTool(tool).annotate(Tool.Destructive, false) as T;

const readonlyBrowserTool = <T extends Tool.Any>(tool: T): T =>
  safeBrowserTool(tool).annotate(Tool.Readonly, true).annotate(Tool.Idempotent, true) as T;

const PreviewActionResult = Schema.Struct({});

export const PreviewStatusTool = Tool.make("preview_status", {
  description:
    "Report whether a collaborative browser tab is automation-capable, including its URL, title, visibility, loading state, viewport mode, measured CSS-pixel size, downloadApprovalRequired, and any human-verification gate. Pass tabId to inspect a specific tab; omit it to use this agent session's current tab. Tab IDs from other custom agents are rejected — use this agent's own tabs. If the viewport is under 240px on either axis (often ~320×200), call preview_resize before clicking. If downloadApprovalRequired is true, call preview_wait_for_download and do not retry the fetch. If humanVerification is required, keep the tab staged for the user and do not automate or retry the challenge.",
  parameters: PreviewAutomationTabTargetInput,
  success: PreviewAutomationStatus,
  failure: PreviewAutomationError,
  dependencies,
})
  .annotate(Tool.Title, "Get preview status")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

export const PreviewOpenTool = browserTool(
  Tool.make("preview_open", {
    description:
      "Initialize a collaborative browser tab and open its thread-bound inline preview by default. When the requested domain is already open, the first call can return selection-required with matching tab IDs: retry with tabId to reuse one, or with reuseExistingTab=false to explicitly create another. A created result includes the exact preview_close cleanup call; close that created tab when its browsing task is finished, but never close a reused tab merely as cleanup. Set open=false for background-only automation.",
    parameters: PreviewAutomationOpenInput,
    success: PreviewAutomationOpenResult,
    failure: PreviewAutomationError,
    dependencies,
  })
    .annotate(Tool.Title, "Open browser preview")
    .annotate(Tool.Destructive, false),
);

export const PreviewCloseTool = browserTool(
  Tool.make("preview_close", {
    description:
      "Close one collaborative browser tab by its exact tabId. Use this to clean up a tab that preview_open reported as newly created after that browsing task is finished. Never close a tab that preview_open reported as reused merely as cleanup.",
    parameters: PreviewAutomationCloseInput,
    success: PreviewAutomationCloseResult,
    failure: PreviewAutomationError,
    dependencies,
  }).annotate(Tool.Title, "Close browser preview tab"),
);

export const PreviewNavigateTool = safeBrowserTool(
  Tool.make("preview_navigate", {
    description:
      "Navigate a collaborative browser tab. Pass tabId to target a specific tab, plus {url:'https://t3.chat'} for a website or {target:{kind:'environment-port',port:5173}} for a dev server. Exactly one of url or target is required.",
    parameters: PreviewAutomationNavigateInput,
    success: PreviewAutomationStatus,
    failure: PreviewAutomationError,
    dependencies,
  }).annotate(Tool.Title, "Navigate browser preview"),
);

export const PreviewResizeTool = safeBrowserTool(
  Tool.make("preview_resize", {
    description:
      "Resize a collaborative browser tab, optionally selected by tabId. Use {mode:'fill'} to follow a usable panel, {mode:'freeform',width:1280,height:800} for a desktop CSS viewport, or {mode:'preset',preset:'iphone-12-pro',orientation:'portrait'}. If preview_status.viewport is around 320×200 or either axis is under 240px, the guest is stuck in the floating thumbnail: call this with fill or freeform 1280×800 before clicking — pages like Gmail collapse and clicks miss at that size. This changes CSS layout breakpoints without changing the desktop browser user agent.",
    parameters: PreviewAutomationResizeInput,
    success: PreviewAutomationResizeResult,
    failure: PreviewAutomationError,
    dependencies,
  })
    .annotate(Tool.Title, "Resize browser viewport")
    .annotate(Tool.Idempotent, true),
);

export const PreviewSetAppearanceTool = safeBrowserTool(
  Tool.make("preview_set_appearance", {
    description:
      "Emulate prefers-color-scheme in a collaborative browser tab, optionally selected by tabId. Use {colorScheme:'dark'} or {colorScheme:'light'} to preview the page in that appearance, and {colorScheme:'system'} to clear the override and follow the OS appearance.",
    parameters: PreviewAutomationSetColorSchemeInput,
    success: PreviewAutomationSetColorSchemeResult,
    failure: PreviewAutomationError,
    dependencies,
  })
    .annotate(Tool.Title, "Set preview appearance")
    .annotate(Tool.Idempotent, true),
);

export const PreviewSnapshotTool = readonlyBrowserTool(
  Tool.make("preview_snapshot", {
    description:
      "Inspect a page before interacting. Pass tabId to inspect a specific tab; omit it to use this agent session's current tab. Do not pass tab IDs from other custom agents — use this agent's own tabs. Returns page state, semantic elements, diagnostics, action history, a PNG screenshot, pending download approvals, documentKind (pdf when Chromium's PDF viewer is showing), and any human-verification gate. PDF viewers often have empty DOM text; use visibleText. When verification is required, stop automated interaction and leave the same tab staged for the user.",
    parameters: PreviewAutomationTabTargetInput,
    success: PreviewAutomationSnapshot,
    failure: PreviewAutomationError,
    dependencies,
  }).annotate(Tool.Title, "Inspect browser page"),
);

export const PreviewClickTool = browserTool(
  Tool.make("preview_click", {
    description:
      "Click exactly one target in the tab selected by tabId, or this agent session's current tab when omitted. Prefer a Playwright locator; selector accepts legacy CSS; x and y must be supplied together.",
    parameters: PreviewAutomationClickInput,
    success: PreviewActionResult,
    failure: PreviewAutomationError,
    dependencies,
  }).annotate(Tool.Title, "Click preview page"),
);

export const PreviewDragTool = browserTool(
  Tool.make("preview_drag", {
    description:
      "Draw a click-and-drag or freeform stroke of trusted pointer events across a path in the tab selected by tabId, or this agent session's current tab when omitted. The button presses at the first point, drags through interpolated moves with the button held, and releases at the last, so canvas games (Phaser and friends), drawing tools, sliders, and drag-and-drop targets receive a continuous trusted stroke. Provide {from:{x,y}, to:{x,y}} for a straight drag or {path:[{x,y},...]} for a freeform stroke; give coordinates in viewport CSS pixels from preview_snapshot. Optional steps controls interpolation density (default 8), holdMs pauses before release, and button selects left/middle/right.",
    parameters: PreviewAutomationDragInput,
    success: PreviewActionResult,
    failure: PreviewAutomationError,
    dependencies,
  }).annotate(Tool.Title, "Drag or stroke preview page"),
);

export const PreviewTypeTool = browserTool(
  Tool.make("preview_type", {
    description:
      "Insert literal text into one input in the tab selected by tabId, or this agent session's current tab when omitted. Prefer a Playwright locator; set clear=true to replace existing text.",
    parameters: PreviewAutomationTypeInput,
    success: PreviewActionResult,
    failure: PreviewAutomationError,
    dependencies,
  }).annotate(Tool.Title, "Type into preview page"),
);

export const PreviewUploadTool = browserTool(
  Tool.make("preview_upload", {
    description:
      "Attach one or more existing local files directly to an input[type=file] in the collaborative browser without opening the operating-system file picker. Supply absolute paths from this environment and preferably a snapshot-derived locator; when locator and selector are omitted, the first file input is used. Use this instead of computer control for Drive uploads and other web file forms, then click the page's upload/submit control and verify the result.",
    parameters: PreviewAutomationUploadInput,
    success: PreviewAutomationUploadResult,
    failure: PreviewAutomationError,
    dependencies,
  }).annotate(Tool.Title, "Upload files to preview page"),
);

export const PreviewPressTool = browserTool(
  Tool.make("preview_press", {
    description:
      "Press one keyboard key in the tab selected by tabId, or this agent session's current tab when omitted. Examples: {key:'Enter'}, {key:'Escape'}, or {key:'a',modifiers:['Meta']}.",
    parameters: PreviewAutomationPressInput,
    success: PreviewActionResult,
    failure: PreviewAutomationError,
    dependencies,
  }).annotate(Tool.Title, "Press key in preview page"),
);

export const PreviewScrollTool = safeBrowserTool(
  Tool.make("preview_scroll", {
    description:
      "Scroll the tab selected by tabId, or this agent session's current tab when omitted. Positive deltaY scrolls down and positive deltaX scrolls right; a locator/selector targets a container.",
    parameters: PreviewAutomationScrollInput,
    success: PreviewActionResult,
    failure: PreviewAutomationError,
    dependencies,
  }).annotate(Tool.Title, "Scroll preview page"),
);

export const PreviewEvaluateTool = browserTool(
  Tool.make("preview_evaluate", {
    description:
      "Evaluate read-only diagnostic JavaScript in the tab selected by tabId, or this agent session's current tab when omitted. Returns a serializable result up to 64 KB. Prefer snapshot and semantic actions; do not dispatch synthetic events, patch browser APIs, hide automation, or use evaluation to interact with human-verification challenges.",
    parameters: PreviewAutomationEvaluateInput,
    success: Schema.Unknown,
    failure: PreviewAutomationError,
    dependencies,
  }).annotate(Tool.Title, "Evaluate JavaScript in preview"),
);

export const PreviewWaitForTool = readonlyBrowserTool(
  Tool.make("preview_wait_for", {
    description:
      "Wait in the tab selected by tabId, or this agent session's current tab when omitted, until all supplied locator, selector, text, and URL conditions match.",
    parameters: PreviewAutomationWaitForInput,
    success: PreviewActionResult,
    failure: PreviewAutomationError,
    dependencies,
  }).annotate(Tool.Title, "Wait for preview page condition"),
);

export const PreviewWaitForDownloadTool = readonlyBrowserTool(
  Tool.make("preview_wait_for_download", {
    description:
      "Wait for a download started in this tab to finish, including the time a download from a site the user has not approved yet spends waiting for their answer. Downloads from a new domain are held until the user allows or denies them. Call this after clicking a download — do not treat an empty pending list at the start as a denial. Returns outcome downloaded, denied, waiting, or none, plus the files that landed. If outcome is waiting, the user still has the Allow/Deny question: do not retry the fetch. End the turn; in Agent mode emit AGENT_STOP.",
    parameters: PreviewAutomationWaitForDownloadInput,
    success: PreviewAutomationWaitForDownloadResult,
    failure: PreviewAutomationError,
    dependencies,
  }).annotate(Tool.Title, "Wait for preview download"),
);

export const PreviewRecordingStartTool = safeBrowserTool(
  Tool.make("preview_recording_start", {
    description:
      "Start recording the collaborative browser tab selected by tabId, or this agent session's current tab when omitted.",
    parameters: PreviewAutomationTabTargetInput,
    success: PreviewAutomationRecordingStatus,
    failure: PreviewAutomationError,
    dependencies,
  }).annotate(Tool.Title, "Start browser recording"),
);

export const PreviewRecordingStopTool = safeBrowserTool(
  Tool.make("preview_recording_stop", {
    description:
      "Stop recording the collaborative browser tab selected by tabId, or this agent session's current tab when omitted, and save it as a local evidence artifact.",
    parameters: PreviewAutomationTabTargetInput,
    success: PreviewAutomationRecordingArtifact,
    failure: PreviewAutomationError,
    dependencies,
  }).annotate(Tool.Title, "Stop browser recording"),
);

export const PreviewToolkit = Toolkit.make(
  PreviewStatusTool,
  PreviewOpenTool,
  PreviewNavigateTool,
  PreviewResizeTool,
  PreviewSetAppearanceTool,
  PreviewSnapshotTool,
  PreviewClickTool,
  PreviewDragTool,
  PreviewTypeTool,
  PreviewUploadTool,
  PreviewPressTool,
  PreviewScrollTool,
  PreviewEvaluateTool,
  PreviewWaitForTool,
  PreviewWaitForDownloadTool,
  PreviewCloseTool,
  PreviewRecordingStartTool,
  PreviewRecordingStopTool,
);

export const PreviewStandardToolkit = Toolkit.make(
  PreviewStatusTool,
  PreviewOpenTool,
  PreviewNavigateTool,
  PreviewResizeTool,
  PreviewSetAppearanceTool,
  PreviewClickTool,
  PreviewDragTool,
  PreviewTypeTool,
  PreviewUploadTool,
  PreviewPressTool,
  PreviewScrollTool,
  PreviewEvaluateTool,
  PreviewWaitForTool,
  PreviewWaitForDownloadTool,
  PreviewCloseTool,
  PreviewRecordingStartTool,
  PreviewRecordingStopTool,
);

export const PreviewSnapshotToolkit = Toolkit.make(PreviewSnapshotTool);
