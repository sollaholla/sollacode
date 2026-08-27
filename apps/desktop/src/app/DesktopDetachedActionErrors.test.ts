import { assert, describe, it } from "@effect/vitest";
import * as Cause from "effect/Cause";

import {
  DesktopLifecycleDetachedActionError,
  DesktopLifecycleRelaunchError,
} from "./DesktopLifecycle.ts";
import { DesktopApplicationMenuActionError } from "../window/DesktopApplicationMenu.ts";

describe("desktop detached action errors", () => {
  it("preserves the complete relaunch failure cause and reason", () => {
    const cause = Cause.combine(
      Cause.fail(new Error("shutdown failed")),
      Cause.die(new Error("relaunch defect")),
    );
    const error = new DesktopLifecycleRelaunchError({
      reason: "apply update",
      cause,
    });

    assert.strictEqual(error.cause, cause);
    assert.equal(error.reason, "apply update");
    assert.equal(error.message, 'Desktop relaunch failed for reason "apply update".');
  });

  it("preserves the complete menu action failure cause and action", () => {
    const cause = Cause.combine(
      Cause.fail(new Error("window unavailable")),
      Cause.die(new Error("dispatch defect")),
    );
    const error = new DesktopApplicationMenuActionError({
      action: "open-settings",
      cause,
    });

    assert.strictEqual(error.cause, cause);
    assert.equal(error.action, "open-settings");
    assert.equal(error.message, 'Desktop menu action "open-settings" failed.');
  });

  it("preserves the complete detached lifecycle failure cause and action", () => {
    const cause = Cause.combine(
      Cause.fail(new Error("overlay failed")),
      Cause.die(new Error("window was destroyed")),
    );
    const error = new DesktopLifecycleDetachedActionError({
      action: "before-quit-shutdown",
      cause,
    });

    assert.strictEqual(error.cause, cause);
    assert.equal(error.action, "before-quit-shutdown");
    assert.equal(error.message, 'Detached desktop lifecycle action "before-quit-shutdown" failed.');
  });
});
