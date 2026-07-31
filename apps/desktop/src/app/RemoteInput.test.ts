import { assert, describe, it } from "@effect/vitest";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Effect from "effect/Effect";

import { RemoteInputController, remoteInputCommand } from "./RemoteInput.ts";

describe("RemoteInput", () => {
  it.effect("starts the persistent macOS helper and acknowledges a safe reset command", () =>
    Effect.gen(function* () {
      const platform = yield* HostProcessPlatform;
      if (platform !== "darwin") return;
      const controller = new RemoteInputController(platform);
      yield* Effect.promise(() => controller.probe());
      yield* Effect.promise(() => controller.dispose());
    }),
  );

  it("launches the Windows helper from a script file instead of an oversized command", () => {
    const command = remoteInputCommand("win32");
    assert.equal(command.command, "powershell.exe");
    assert.isTrue(command.args.includes("-File"));
    assert.isFalse(command.args.includes("-EncodedCommand"));
    assert.match(command.args.at(-1) ?? "", /solla-remote-input\.ps1$/u);
  });
});
