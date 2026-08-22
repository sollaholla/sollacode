import * as Schema from "effect/Schema";

const BoundedPath = Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(32_768));
const BoundedReason = Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(4_096));

export const AppUpdateInput = Schema.Struct({
  path: BoundedPath.annotate({
    description:
      "Absolute path on the Solla Code host to a macOS .app/.dmg/.zip or Windows NSIS .exe update artifact.",
  }),
  force: Schema.optional(Schema.Boolean).annotate({
    description:
      "Skip the user confirmation prompt. Use only when the user already explicitly authorized this exact update.",
  }),
});
export type AppUpdateInput = typeof AppUpdateInput.Type;

export const DesktopAppUpdatePlatform = Schema.Literals(["darwin", "win32"]);
export type DesktopAppUpdatePlatform = typeof DesktopAppUpdatePlatform.Type;

export const DesktopAppUpdateArtifactKind = Schema.Literals(["app", "dmg", "zip", "nsis"]);
export type DesktopAppUpdateArtifactKind = typeof DesktopAppUpdateArtifactKind.Type;

export const DesktopAppUpdatePreflight = Schema.Struct({
  platform: DesktopAppUpdatePlatform,
  artifactKind: DesktopAppUpdateArtifactKind,
  version: Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(256)),
  productName: Schema.Literal("Solla Code"),
  signatureStatus: Schema.optional(Schema.String.check(Schema.isMaxLength(256))),
});
export type DesktopAppUpdatePreflight = typeof DesktopAppUpdatePreflight.Type;

const AppUpdateBaseResult = {
  platform: DesktopAppUpdatePlatform,
  artifactPath: BoundedPath,
  targetPath: BoundedPath,
  artifactKind: DesktopAppUpdateArtifactKind,
  version: Schema.String,
  logPath: BoundedPath,
  autoResume: Schema.Literal(true),
};

export const AppUpdateResult = Schema.Union([
  Schema.Struct({
    status: Schema.Literal("scheduled"),
    ...AppUpdateBaseResult,
    confirmation: Schema.Literals(["confirmed", "forced"]),
  }),
  Schema.Struct({
    status: Schema.Literal("cancelled"),
    platform: DesktopAppUpdatePlatform,
    artifactPath: BoundedPath,
    targetPath: BoundedPath,
    artifactKind: DesktopAppUpdateArtifactKind,
    version: Schema.String,
    reason: Schema.Literals(["user_declined", "confirmation_unsupported"]),
  }),
]);
export type AppUpdateResult = typeof AppUpdateResult.Type;

export class AppUpdateCapabilityUnavailableError extends Schema.TaggedErrorClass<AppUpdateCapabilityUnavailableError>()(
  "AppUpdateCapabilityUnavailableError",
  {
    reason: Schema.Literals([
      "not_desktop",
      "unsupported_platform",
      "missing_desktop_configuration",
    ]),
  },
) {
  override get message(): string {
    switch (this.reason) {
      case "not_desktop":
        return "This Solla Code server is not managed by the desktop application.";
      case "unsupported_platform":
        return "Application updates are supported only by Solla Code Desktop on macOS and Windows.";
      case "missing_desktop_configuration":
        return "The desktop application did not provide a usable update configuration.";
    }
  }
}

export class AppUpdateCredentialCapabilityError extends Schema.TaggedErrorClass<AppUpdateCredentialCapabilityError>()(
  "AppUpdateCredentialCapabilityError",
  {},
) {
  override get message(): string {
    return "This MCP credential does not grant application-update access.";
  }
}

export class AppUpdateInvalidArtifactError extends Schema.TaggedErrorClass<AppUpdateInvalidArtifactError>()(
  "AppUpdateInvalidArtifactError",
  {
    path: BoundedPath,
    reason: BoundedReason,
  },
) {
  override get message(): string {
    return `The Solla Code update artifact is invalid: ${this.reason}`;
  }
}

export class AppUpdatePreflightError extends Schema.TaggedErrorClass<AppUpdatePreflightError>()(
  "AppUpdatePreflightError",
  {
    path: BoundedPath,
    reason: BoundedReason,
  },
) {
  override get message(): string {
    return `Solla Code could not verify the update artifact: ${this.reason}`;
  }
}

export class AppUpdateAlreadyInProgressError extends Schema.TaggedErrorClass<AppUpdateAlreadyInProgressError>()(
  "AppUpdateAlreadyInProgressError",
  {},
) {
  override get message(): string {
    return "A Solla Code application update is already in progress.";
  }
}

export class AppUpdateScheduleError extends Schema.TaggedErrorClass<AppUpdateScheduleError>()(
  "AppUpdateScheduleError",
  {
    reason: BoundedReason,
  },
) {
  override get message(): string {
    return `Solla Code could not start the application installer: ${this.reason}`;
  }
}

export const AppUpdateError = Schema.Union([
  AppUpdateCapabilityUnavailableError,
  AppUpdateCredentialCapabilityError,
  AppUpdateInvalidArtifactError,
  AppUpdatePreflightError,
  AppUpdateAlreadyInProgressError,
  AppUpdateScheduleError,
]);
export type AppUpdateError = typeof AppUpdateError.Type;
