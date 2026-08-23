import type { DesktopPermissionsSnapshot } from "@t3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import {
  DesktopPermissionsView,
  shouldShowDesktopPermissionsOnboarding,
} from "./DesktopPermissions";

const snapshot: DesktopPermissionsSnapshot = {
  supported: true,
  onboardingVersion: 0,
  onboardingRequired: true,
  permissions: [
    {
      id: "full-disk-access",
      status: "denied",
      canRequest: false,
      requiresRestart: true,
    },
    { id: "microphone", status: "not-determined", canRequest: true, requiresRestart: false },
    { id: "screen-recording", status: "granted", canRequest: false, requiresRestart: false },
    { id: "accessibility", status: "restricted", canRequest: true, requiresRestart: false },
  ],
};

describe("DesktopPermissionsView", () => {
  it("gates startup only for supported, incomplete onboarding", () => {
    expect(shouldShowDesktopPermissionsOnboarding(snapshot)).toBe(true);
    expect(shouldShowDesktopPermissionsOnboarding({ ...snapshot, onboardingRequired: false })).toBe(
      false,
    );
    expect(shouldShowDesktopPermissionsOnboarding({ ...snapshot, supported: false })).toBe(false);
  });

  it("explains every permission and communicates status without color alone", () => {
    const markup = renderToStaticMarkup(
      <DesktopPermissionsView
        snapshot={snapshot}
        busyId={null}
        error={null}
        onboarding
        onAct={() => undefined}
        onManage={() => undefined}
        onRefresh={() => undefined}
        onComplete={() => undefined}
        onRelaunch={() => undefined}
      />,
    );

    expect(markup).toContain("Full Disk Access");
    expect(markup).toContain("protected Desktop, Documents, Downloads, and other app data");
    expect(markup).toContain("Microphone");
    expect(markup).toContain("Screen Recording");
    expect(markup).toContain("Accessibility");
    expect(markup).toContain("Needs attention");
    expect(markup).toContain("Not requested");
    expect(markup).toContain("Enabled");
    expect(markup).toContain("Restricted");
    expect(markup).toContain("Continue with 3 unavailable");
    expect(markup).toContain('aria-label="Open System Settings for Full Disk Access"');
    expect(markup).toContain("Remove the old Solla Code entry");
    expect(markup).toContain('aria-label="Enable Microphone"');
    expect(markup).toContain('aria-label="Manage Screen Recording"');
  });

  it("reserves the hero badge and title for onboarding — settings already headers itself", () => {
    const render = (onboarding: boolean) =>
      renderToStaticMarkup(
        <DesktopPermissionsView
          snapshot={snapshot}
          busyId={null}
          error={null}
          onboarding={onboarding}
          onAct={() => undefined}
          onManage={() => undefined}
          onRefresh={() => undefined}
          onComplete={() => undefined}
          onRelaunch={() => undefined}
        />,
      );

    expect(render(true)).toContain("Set permissions before agents get to work");
    const settingsMarkup = render(false);
    // Rendered inside SettingsSection ("Permissions" + shield), so the view
    // must not add a second shield or a second title of its own.
    expect(settingsMarkup).not.toContain("lucide-shield-check");
    expect(settingsMarkup).not.toContain("Set permissions before agents get to work");
    expect(settingsMarkup).not.toContain("macOS permissions");
  });

  it("explains a stale macOS grant without claiming the running app is enabled", () => {
    const staleAccessibility: DesktopPermissionsSnapshot = {
      ...snapshot,
      permissions: snapshot.permissions.map((permission) =>
        permission.id === "accessibility"
          ? {
              ...permission,
              status: "denied" as const,
              requiresRestart: true,
            }
          : permission,
      ),
    };
    const markup = renderToStaticMarkup(
      <DesktopPermissionsView
        snapshot={staleAccessibility}
        busyId={null}
        error={null}
        onboarding={false}
        onAct={() => undefined}
        onManage={() => undefined}
        onRefresh={() => undefined}
        onComplete={() => undefined}
        onRelaunch={() => undefined}
      />,
    );

    expect(markup).toContain("Needs attention");
    expect(markup).toContain("A grant left by an older local build");
    expect(markup).toContain("Restart Solla Code");
  });

  it("keeps an actionable error and restart control visible", () => {
    const markup = renderToStaticMarkup(
      <DesktopPermissionsView
        snapshot={snapshot}
        busyId="microphone"
        error="Native permission request failed."
        onboarding={false}
        onAct={() => undefined}
        onManage={() => undefined}
        onRefresh={() => undefined}
        onComplete={() => undefined}
        onRelaunch={() => undefined}
      />,
    );
    expect(markup).toContain('role="alert"');
    expect(markup).toContain("Native permission request failed.");
    expect(markup).toContain("Restart Solla Code");
    expect(markup).toContain("animate-spin");
  });
});
