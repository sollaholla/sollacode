import {
  DesktopRemoteControlCaptureInputSchema,
  DesktopRemoteControlFrameSchema,
  DesktopRemoteControlInputSchema,
  REMOTE_CONTROL_FRAME_MAX_BASE64_LENGTH,
} from "@t3tools/contracts";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Electron from "electron";

import * as IpcChannels from "../channels.ts";
import * as DesktopIpc from "../DesktopIpc.ts";
import { remoteInputControllerForPlatform } from "../../app/RemoteInput.ts";

const SCREEN_RECORDING_PERMISSION_HELP =
  "Solla Code needs Screen Recording permission to share this Mac. Open System Settings → Privacy & Security → Screen Recording, enable Solla Code, then completely quit and reopen Solla Code.";
const ACCESSIBILITY_PERMISSION_HELP =
  "Solla Code needs Accessibility permission to control this Mac. Open System Settings → Privacy & Security → Accessibility, enable Solla Code, then try remote control again.";

class DesktopRemoteControlCaptureError extends Schema.TaggedErrorClass<DesktopRemoteControlCaptureError>()(
  "DesktopRemoteControlCaptureError",
  {
    detail: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return this.detail;
  }
}

const isDesktopRemoteControlCaptureError = Schema.is(DesktopRemoteControlCaptureError);

function captureError(cause: unknown): DesktopRemoteControlCaptureError {
  if (isDesktopRemoteControlCaptureError(cause)) return cause;
  return new DesktopRemoteControlCaptureError({
    detail: cause instanceof Error ? cause.message : String(cause),
    cause,
  });
}

function failCapture(detail: string): DesktopRemoteControlCaptureError {
  return new DesktopRemoteControlCaptureError({ detail, cause: detail });
}

function encodeBoundedJpeg(image: Electron.NativeImage, initialQuality: number) {
  let current = image;
  let quality = initialQuality;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const bytes = current.toJPEG(quality);
    const data = bytes.toString("base64");
    if (data.length <= REMOTE_CONTROL_FRAME_MAX_BASE64_LENGTH) {
      const size = current.getSize();
      return { data, width: size.width, height: size.height };
    }
    const size = current.getSize();
    current = current.resize({
      width: Math.max(640, Math.round(size.width * 0.8)),
      quality: "good",
    });
    quality = Math.max(30, quality - 8);
  }
  throw failCapture(
    "The captured desktop frame was too large to send safely. Reduce the display resolution and try again.",
  );
}

export const captureRemoteControlFrame = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.REMOTE_CONTROL_CAPTURE_FRAME_CHANNEL,
  payload: DesktopRemoteControlCaptureInputSchema,
  result: DesktopRemoteControlFrameSchema,
  handler: Effect.fn("desktop.ipc.remoteControl.captureFrame")(function* (input) {
    const platform = yield* HostProcessPlatform;
    const captured = yield* Effect.tryPromise({
      try: async () => {
        if (platform === "darwin") {
          const permission = Electron.systemPreferences.getMediaAccessStatus("screen");
          if (permission === "denied" || permission === "restricted") {
            throw failCapture(SCREEN_RECORDING_PERMISSION_HELP);
          }
        }

        const primary = Electron.screen.getPrimaryDisplay();
        const targetHeight = Math.max(
          360,
          Math.round((input.maxWidth * primary.size.height) / primary.size.width),
        );
        const sources = await Electron.desktopCapturer.getSources({
          types: ["screen"],
          thumbnailSize: {
            width: input.maxWidth,
            height: targetHeight,
          },
          fetchWindowIcons: false,
        });
        const source =
          sources.find((candidate) => candidate.display_id === String(primary.id)) ?? sources[0];
        if (!source || source.thumbnail.isEmpty()) {
          throw failCapture(
            platform === "darwin"
              ? SCREEN_RECORDING_PERMISSION_HELP
              : "Solla Code could not capture the primary display. Check the operating system's screen-capture permissions and try again.",
          );
        }

        return encodeBoundedJpeg(source.thumbnail, input.jpegQuality);
      },
      catch: captureError,
    });
    const capturedAt = DateTime.formatIso(yield* DateTime.now);
    return {
      capturedAt,
      mimeType: "image/jpeg" as const,
      ...captured,
    };
  }),
});

export const sendRemoteControlInput = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.REMOTE_CONTROL_SEND_INPUT_CHANNEL,
  payload: DesktopRemoteControlInputSchema,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.remoteControl.sendInput")(function* (input) {
    const platform = yield* HostProcessPlatform;
    yield* Effect.tryPromise({
      try: async () => {
        if (platform === "darwin") {
          const trusted = Electron.systemPreferences.isTrustedAccessibilityClient(false);
          if (!trusted) {
            Electron.systemPreferences.isTrustedAccessibilityClient(true);
            throw failCapture(ACCESSIBILITY_PERMISSION_HELP);
          }
        }
        await remoteInputControllerForPlatform(platform).send(input);
      },
      catch: captureError,
    });
  }),
});

export const resetRemoteControlInput = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.REMOTE_CONTROL_RESET_INPUT_CHANNEL,
  payload: Schema.Struct({}),
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.remoteControl.resetInput")(function* () {
    const platform = yield* HostProcessPlatform;
    yield* Effect.tryPromise({
      try: () => remoteInputControllerForPlatform(platform).reset(),
      catch: captureError,
    });
  }),
});
