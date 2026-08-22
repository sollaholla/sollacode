import * as Schema from "effect/Schema";

export const DESKTOP_PERMISSIONS_ONBOARDING_VERSION = 1;

export const DesktopPermissionIdSchema = Schema.Literals([
  "full-disk-access",
  "microphone",
  "screen-recording",
  "accessibility",
]);
export type DesktopPermissionId = typeof DesktopPermissionIdSchema.Type;

export const DesktopPermissionStatusSchema = Schema.Literals([
  "granted",
  "denied",
  "not-determined",
  "restricted",
  "unknown",
]);
export type DesktopPermissionStatus = typeof DesktopPermissionStatusSchema.Type;

export const DesktopPermissionStateSchema = Schema.Struct({
  id: DesktopPermissionIdSchema,
  status: DesktopPermissionStatusSchema,
  canRequest: Schema.Boolean,
  requiresRestart: Schema.Boolean,
});
export type DesktopPermissionState = typeof DesktopPermissionStateSchema.Type;

export const DesktopPermissionsSnapshotSchema = Schema.Struct({
  supported: Schema.Boolean,
  onboardingVersion: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  onboardingRequired: Schema.Boolean,
  permissions: Schema.Array(DesktopPermissionStateSchema),
});
export type DesktopPermissionsSnapshot = typeof DesktopPermissionsSnapshotSchema.Type;

export const DesktopPermissionActionInputSchema = Schema.Struct({
  id: DesktopPermissionIdSchema,
});
export type DesktopPermissionActionInput = typeof DesktopPermissionActionInputSchema.Type;

export interface DesktopPermissionsBridge {
  getSnapshot: () => Promise<DesktopPermissionsSnapshot>;
  request: (input: DesktopPermissionActionInput) => Promise<DesktopPermissionsSnapshot>;
  openSystemSettings: (input: DesktopPermissionActionInput) => Promise<void>;
  completeOnboarding: () => Promise<DesktopPermissionsSnapshot>;
  relaunch: () => Promise<void>;
}
