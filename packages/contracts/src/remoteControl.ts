import * as Schema from "effect/Schema";

import { EnvironmentId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { AuthClientMetadataDeviceType } from "./auth.ts";

const RemoteControlOpaqueId = TrimmedNonEmptyString.check(Schema.isMaxLength(128));

export const RemoteControlClientId = RemoteControlOpaqueId;
export type RemoteControlClientId = typeof RemoteControlClientId.Type;
export const RemoteControlDeviceId = RemoteControlOpaqueId;
export type RemoteControlDeviceId = typeof RemoteControlDeviceId.Type;
export const RemoteControlConnectionId = RemoteControlOpaqueId;
export type RemoteControlConnectionId = typeof RemoteControlConnectionId.Type;
export const RemoteControlRequestId = RemoteControlOpaqueId;
export type RemoteControlRequestId = typeof RemoteControlRequestId.Type;
export const RemoteControlSessionId = RemoteControlOpaqueId;
export type RemoteControlSessionId = typeof RemoteControlSessionId.Type;

export const RemoteControlPlatform = Schema.Literals(["macos", "windows", "linux", "unknown"]);
export type RemoteControlPlatform = typeof RemoteControlPlatform.Type;

export const RemoteControlCapability = Schema.Literals(["screen", "pointer", "keyboard"]);
export type RemoteControlCapability = typeof RemoteControlCapability.Type;

export const REMOTE_CONTROL_FRAME_MAX_BASE64_LENGTH = 1_500_000;
export const REMOTE_CONTROL_KEY_VALUE_MAX_LENGTH = 64;

export const RemoteControlSessionStatus = Schema.Literals([
  "waiting-for-host-approval",
  "approved",
  "declined",
  "cancelled",
  "ended",
  "failed",
]);
export type RemoteControlSessionStatus = typeof RemoteControlSessionStatus.Type;

export const RemoteControlRequester = Schema.Struct({
  deviceId: RemoteControlDeviceId,
  label: TrimmedNonEmptyString,
  deviceType: AuthClientMetadataDeviceType,
  os: Schema.optional(TrimmedNonEmptyString),
});
export type RemoteControlRequester = typeof RemoteControlRequester.Type;

export const RemoteControlSession = Schema.Struct({
  sessionId: RemoteControlSessionId,
  status: RemoteControlSessionStatus,
  requester: RemoteControlRequester,
  requestedCapabilities: Schema.Array(RemoteControlCapability),
  grantedCapabilities: Schema.Array(RemoteControlCapability),
  createdAt: TrimmedNonEmptyString,
  updatedAt: TrimmedNonEmptyString,
  failureReason: Schema.optional(TrimmedNonEmptyString),
});
export type RemoteControlSession = typeof RemoteControlSession.Type;

export const RemoteControlHost = Schema.Struct({
  clientId: RemoteControlClientId,
  environmentId: EnvironmentId,
  platform: RemoteControlPlatform,
  capabilities: Schema.Array(RemoteControlCapability),
});
export type RemoteControlHost = typeof RemoteControlHost.Type;

export const RemoteControlRequestAccessInput = Schema.Struct({
  clientId: RemoteControlClientId,
  requestedCapabilities: Schema.Array(RemoteControlCapability),
});
export type RemoteControlRequestAccessInput = typeof RemoteControlRequestAccessInput.Type;

export const RemoteControlWatchInput = Schema.Struct({
  sessionId: RemoteControlSessionId,
});
export type RemoteControlWatchInput = typeof RemoteControlWatchInput.Type;

export const RemoteControlCancelInput = Schema.Struct({
  sessionId: RemoteControlSessionId,
});
export type RemoteControlCancelInput = typeof RemoteControlCancelInput.Type;

export const RemoteControlHostRespondInput = Schema.Struct({
  clientId: RemoteControlClientId,
  connectionId: RemoteControlConnectionId,
  requestId: RemoteControlRequestId,
  decision: Schema.Literals(["approve", "decline"]),
  grantedCapabilities: Schema.optional(Schema.Array(RemoteControlCapability)),
});
export type RemoteControlHostRespondInput = typeof RemoteControlHostRespondInput.Type;

export const REMOTE_CONTROL_MAX_DISPLAYS = 16;

/**
 * One capturable monitor on the host. `id` is the platform display id as a
 * string so it survives JSON transport; the controller echoes it back in a
 * `select-display` input to switch the captured screen.
 */
export const RemoteControlDisplay = Schema.Struct({
  id: RemoteControlOpaqueId,
  label: TrimmedNonEmptyString,
  width: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  height: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  isPrimary: Schema.Boolean,
});
export type RemoteControlDisplay = typeof RemoteControlDisplay.Type;

export const RemoteControlFrame = Schema.Struct({
  sessionId: RemoteControlSessionId,
  sequence: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  capturedAt: TrimmedNonEmptyString,
  mimeType: Schema.Literal("image/jpeg"),
  width: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 3_840 })),
  height: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 2_160 })),
  data: Schema.String.check(
    Schema.isMinLength(1),
    Schema.isMaxLength(REMOTE_CONTROL_FRAME_MAX_BASE64_LENGTH),
  ),
  // Which monitor this frame shows, and everything else on offer. Carrying the
  // roster on the frame keeps display discovery on the existing stream instead
  // of adding a second round trip, and it stays correct when monitors are
  // hot-plugged mid-session. Both are optional so older hosts still validate.
  displayId: Schema.optional(RemoteControlOpaqueId),
  displays: Schema.optional(
    Schema.Array(RemoteControlDisplay).check(Schema.isMaxLength(REMOTE_CONTROL_MAX_DISPLAYS)),
  ),
});
export type RemoteControlFrame = typeof RemoteControlFrame.Type;

export const RemoteControlHostPublishFrameInput = Schema.Struct({
  clientId: RemoteControlClientId,
  connectionId: RemoteControlConnectionId,
  frame: RemoteControlFrame,
  // Whether an app on the host currently has the cursor captured. Rides the
  // publish call the host is already making every frame rather than adding a
  // channel of its own; the broker turns changes into `pointer-lock-changed`.
  pointerLocked: Schema.optionalKey(Schema.Boolean),
});
export type RemoteControlHostPublishFrameInput = typeof RemoteControlHostPublishFrameInput.Type;

export const REMOTE_CONTROL_CHUNK_MAX_BASE64_LENGTH = 4_000_000;

/**
 * A slice of an encoded video stream (WebM/VP8-VP9 or MP4/H.264 depending on
 * what the host's MediaRecorder offers).
 *
 * Unlike a JPEG frame, a chunk is not independently decodable: the container is
 * continuous, so chunks must arrive in order and must never be dropped, and a
 * controller cannot decode anything until it has the init segment. `isInit`
 * marks that segment, which the broker retains and replays to any controller
 * that starts watching mid-stream.
 */
export const RemoteControlVideoChunk = Schema.Struct({
  sessionId: RemoteControlSessionId,
  sequence: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  capturedAt: TrimmedNonEmptyString,
  // Full MediaRecorder type including codecs, e.g. `video/webm;codecs=vp8`.
  mimeType: TrimmedNonEmptyString.check(Schema.isMaxLength(128)),
  isInit: Schema.Boolean,
  data: Schema.String.check(
    Schema.isMinLength(1),
    Schema.isMaxLength(REMOTE_CONTROL_CHUNK_MAX_BASE64_LENGTH),
  ),
  displayId: Schema.optional(RemoteControlOpaqueId),
  displays: Schema.optional(
    Schema.Array(RemoteControlDisplay).check(Schema.isMaxLength(REMOTE_CONTROL_MAX_DISPLAYS)),
  ),
});
export type RemoteControlVideoChunk = typeof RemoteControlVideoChunk.Type;

export const RemoteControlHostPublishVideoChunkInput = Schema.Struct({
  clientId: RemoteControlClientId,
  connectionId: RemoteControlConnectionId,
  chunk: RemoteControlVideoChunk,
  // Whether an app on the host currently has the cursor captured. Rides the
  // publish call the host is already making every frame rather than adding a
  // channel of its own; the broker turns changes into `pointer-lock-changed`.
  pointerLocked: Schema.optionalKey(Schema.Boolean),
});
export type RemoteControlHostPublishVideoChunkInput =
  typeof RemoteControlHostPublishVideoChunkInput.Type;

/**
 * Host permission failures, shared so the controller can tell them apart from
 * conditions that clear on their own.
 *
 * These two need a human to change a system setting and will never recover by
 * retrying, which is exactly the distinction the reconnect logic turns on — so
 * the text lives here rather than being matched by keyword on either side.
 */
export const REMOTE_CONTROL_SCREEN_PERMISSION_HELP =
  "Solla Code needs Screen Recording permission to share this Mac. Open System Settings → Privacy & Security → Screen Recording, enable Solla Code, then completely quit and reopen Solla Code.";
export const REMOTE_CONTROL_ACCESSIBILITY_PERMISSION_HELP =
  "Solla Code needs Accessibility permission to control this Mac. Open System Settings → Privacy & Security → Accessibility, enable Solla Code, then try remote control again.";

/**
 * Why the host cannot currently drive its own desktop.
 *
 * These are conditions the operating system imposes on *any* injected input or
 * capture, not faults in the session, and every one of them clears on its own.
 * Treating them as session failures is what used to end a stream the moment a
 * UAC prompt appeared.
 *
 * - `secure-desktop`: Windows moved input to another desktop — a UAC consent
 *   prompt, the lock screen, or Ctrl+Alt+Del. Nothing outside that desktop can
 *   see it or type into it, by design; it must be answered at the machine.
 * - `elevated-window`: the foreground window runs at a higher integrity level
 *   than Solla Code, so UIPI silently discards injected input.
 * - `secure-input`: macOS has secure event input enabled, which a password
 *   field or authorization dialog turns on; synthetic key events are dropped.
 * - `capture-interrupted`: the screen-capture pipeline dropped and is being
 *   rebuilt. A desktop switch invalidates the duplication surface, so this is
 *   normally what the viewer sees while a UAC prompt is up.
 */
export const RemoteControlHostStatusReason = Schema.Literals([
  "secure-desktop",
  "elevated-window",
  "secure-input",
  "capture-interrupted",
]);
export type RemoteControlHostStatusReason = typeof RemoteControlHostStatusReason.Type;

export const RemoteControlHostStatus = Schema.Struct({
  state: Schema.Literals(["ok", "interrupted"]),
  reason: Schema.optional(RemoteControlHostStatusReason),
  detail: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(400))),
});
export type RemoteControlHostStatus = typeof RemoteControlHostStatus.Type;

export const RemoteControlHostReportStatusInput = Schema.Struct({
  clientId: RemoteControlClientId,
  connectionId: RemoteControlConnectionId,
  sessionId: RemoteControlSessionId,
  status: RemoteControlHostStatus,
});
export type RemoteControlHostReportStatusInput = typeof RemoteControlHostReportStatusInput.Type;

export const RemoteControlHostEndInput = Schema.Struct({
  clientId: RemoteControlClientId,
  connectionId: RemoteControlConnectionId,
  sessionId: RemoteControlSessionId,
  failureReason: Schema.optional(TrimmedNonEmptyString),
});
export type RemoteControlHostEndInput = typeof RemoteControlHostEndInput.Type;

export const RemoteControlPointerButton = Schema.Literals(["left", "middle", "right"]);
export type RemoteControlPointerButton = typeof RemoteControlPointerButton.Type;

const RemoteControlNormalizedCoordinate = Schema.Number.check(
  Schema.isBetween({ minimum: 0, maximum: 1 }),
);
const RemoteControlWheelDelta = Schema.Number.check(
  Schema.isBetween({ minimum: -2_000, maximum: 2_000 }),
);

/**
 * One frame of relative pointer motion, in remote-screen pixels.
 *
 * Absolute coordinates cannot express mouse-look. A game reads the delta
 * between cursor samples, so replaying an absolute position warps the cursor
 * and the game interprets the warp as one huge flick — the "fling" that makes
 * shooters unplayable over remote control. While the remote app holds the
 * pointer captive the controller sends deltas instead, and the host injects
 * them as relative motion.
 *
 * Bounded so a malicious or glitching controller cannot hurl the cursor across
 * the desktop in a single event; the controller splits anything larger.
 */
const RemoteControlPointerDelta = Schema.Number.check(
  Schema.isBetween({ minimum: -4_000, maximum: 4_000 }),
);

export const RemoteControlInput = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("pointer"),
    action: Schema.Literals(["move", "down", "up"]),
    x: RemoteControlNormalizedCoordinate,
    y: RemoteControlNormalizedCoordinate,
    button: RemoteControlPointerButton,
    // Present only while the controller is in pointer lock. When set, the host
    // injects relative motion and ignores x/y, which are then just a stale
    // best-effort position kept for older hosts that cannot move relatively.
    dx: Schema.optionalKey(RemoteControlPointerDelta),
    dy: Schema.optionalKey(RemoteControlPointerDelta),
  }),
  Schema.Struct({
    type: Schema.Literal("wheel"),
    x: RemoteControlNormalizedCoordinate,
    y: RemoteControlNormalizedCoordinate,
    deltaX: RemoteControlWheelDelta,
    deltaY: RemoteControlWheelDelta,
  }),
  Schema.Struct({
    type: Schema.Literal("key"),
    action: Schema.Literals(["down", "up"]),
    code: Schema.String.check(
      Schema.isMinLength(1),
      Schema.isMaxLength(REMOTE_CONTROL_KEY_VALUE_MAX_LENGTH),
    ),
    key: Schema.String.check(Schema.isMaxLength(REMOTE_CONTROL_KEY_VALUE_MAX_LENGTH)),
    repeat: Schema.Boolean,
  }),
  // Routed over the existing input channel, but it never reaches the OS input
  // controller — the host consumes it to retarget capture. It is gated on the
  // `screen` capability rather than `pointer`, so a view-only session can still
  // choose which monitor it is watching.
  Schema.Struct({
    type: Schema.Literal("select-display"),
    displayId: RemoteControlOpaqueId,
  }),
  // Sent when the controller cannot decode the host's video stream. The host
  // stops encoding and reverts to JPEG frames, which every client can render.
  Schema.Struct({
    type: Schema.Literal("request-image-fallback"),
  }),
]);
export type RemoteControlInput = typeof RemoteControlInput.Type;

export const RemoteControlSendInputInput = Schema.Struct({
  sessionId: RemoteControlSessionId,
  sequence: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  input: RemoteControlInput,
});
export type RemoteControlSendInputInput = typeof RemoteControlSendInputInput.Type;

export const RemoteControlHostStreamEvent = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("connected"),
    connectionId: RemoteControlConnectionId,
  }),
  Schema.Struct({
    type: Schema.Literal("access-requested"),
    connectionId: RemoteControlConnectionId,
    requestId: RemoteControlRequestId,
    session: RemoteControlSession,
  }),
  Schema.Struct({
    type: Schema.Literal("session-ended"),
    connectionId: RemoteControlConnectionId,
    session: RemoteControlSession,
  }),
  Schema.Struct({
    type: Schema.Literal("input"),
    connectionId: RemoteControlConnectionId,
    sessionId: RemoteControlSessionId,
    sequence: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
    input: RemoteControlInput,
  }),
]);
export type RemoteControlHostStreamEvent = typeof RemoteControlHostStreamEvent.Type;

export const RemoteControlControllerStreamEvent = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("session-updated"),
    session: RemoteControlSession,
  }),
  Schema.Struct({
    type: Schema.Literal("frame"),
    frame: RemoteControlFrame,
  }),
  Schema.Struct({
    type: Schema.Literal("video-chunk"),
    chunk: RemoteControlVideoChunk,
  }),
  // The remote app took or released the pointer (a game entering mouse-look
  // hides and captures the cursor). The controller mirrors it into browser
  // pointer lock so the local cursor stops travelling across the viewer while
  // the remote one is captive, and so the deltas the game wants are available
  // at all. Escape releases pointer lock, which the browser handles natively.
  Schema.Struct({
    type: Schema.Literal("pointer-lock-changed"),
    locked: Schema.Boolean,
  }),
  // The host hit — or recovered from — a condition that suspends input or
  // capture without ending the session. The viewer shows this as a transient
  // notice; the session stays approved and resumes on its own.
  Schema.Struct({
    type: Schema.Literal("host-status"),
    status: RemoteControlHostStatus,
  }),
]);
export type RemoteControlControllerStreamEvent = typeof RemoteControlControllerStreamEvent.Type;

export class RemoteControlNoHostError extends Schema.TaggedErrorClass<RemoteControlNoHostError>()(
  "RemoteControlNoHostError",
  {},
) {
  override get message(): string {
    return "The remote machine is not currently available for remote control.";
  }
}

export class RemoteControlSessionNotFoundError extends Schema.TaggedErrorClass<RemoteControlSessionNotFoundError>()(
  "RemoteControlSessionNotFoundError",
  {
    sessionId: RemoteControlSessionId,
  },
) {
  override get message(): string {
    return "The remote-control session no longer exists.";
  }
}

export class RemoteControlRequestNotFoundError extends Schema.TaggedErrorClass<RemoteControlRequestNotFoundError>()(
  "RemoteControlRequestNotFoundError",
  {
    requestId: RemoteControlRequestId,
  },
) {
  override get message(): string {
    return "The remote-control approval request no longer exists.";
  }
}

export class RemoteControlSessionAccessDeniedError extends Schema.TaggedErrorClass<RemoteControlSessionAccessDeniedError>()(
  "RemoteControlSessionAccessDeniedError",
  {
    sessionId: RemoteControlSessionId,
  },
) {
  override get message(): string {
    return "This client does not own the remote-control session.";
  }
}

export class RemoteControlInvalidTransitionError extends Schema.TaggedErrorClass<RemoteControlInvalidTransitionError>()(
  "RemoteControlInvalidTransitionError",
  {
    sessionId: RemoteControlSessionId,
    status: RemoteControlSessionStatus,
  },
) {
  override get message(): string {
    return `Remote-control session cannot be changed while it is ${this.status}.`;
  }
}

export class RemoteControlCapabilityDeniedError extends Schema.TaggedErrorClass<RemoteControlCapabilityDeniedError>()(
  "RemoteControlCapabilityDeniedError",
  {
    sessionId: RemoteControlSessionId,
    requiredCapability: RemoteControlCapability,
  },
) {
  override get message(): string {
    return `This remote-control session does not have ${this.requiredCapability} access.`;
  }
}

export const RemoteControlError = Schema.Union([
  RemoteControlNoHostError,
  RemoteControlSessionNotFoundError,
  RemoteControlRequestNotFoundError,
  RemoteControlSessionAccessDeniedError,
  RemoteControlInvalidTransitionError,
  RemoteControlCapabilityDeniedError,
]);
export type RemoteControlError = typeof RemoteControlError.Type;
