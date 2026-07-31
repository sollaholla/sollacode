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
});
export type RemoteControlFrame = typeof RemoteControlFrame.Type;

export const RemoteControlHostPublishFrameInput = Schema.Struct({
  clientId: RemoteControlClientId,
  connectionId: RemoteControlConnectionId,
  frame: RemoteControlFrame,
});
export type RemoteControlHostPublishFrameInput = typeof RemoteControlHostPublishFrameInput.Type;

export const RemoteControlHostEndInput = Schema.Struct({
  clientId: RemoteControlClientId,
  connectionId: RemoteControlConnectionId,
  sessionId: RemoteControlSessionId,
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
