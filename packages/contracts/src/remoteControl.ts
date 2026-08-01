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
});
export type RemoteControlHostPublishVideoChunkInput =
  typeof RemoteControlHostPublishVideoChunkInput.Type;

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

export const RemoteControlInput = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("pointer"),
    action: Schema.Literals(["move", "down", "up"]),
    x: RemoteControlNormalizedCoordinate,
    y: RemoteControlNormalizedCoordinate,
    button: RemoteControlPointerButton,
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
