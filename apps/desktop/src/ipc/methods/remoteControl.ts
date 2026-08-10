import {
  DesktopRemoteControlCaptureInputSchema,
  DesktopRemoteControlCaptureSourcesSchema,
  DesktopRemoteControlFrameSchema,
  DesktopRemoteControlHostStateSchema,
  DesktopRemoteControlInputResultSchema,
  DesktopRemoteControlInputSchema,
  type DesktopRemoteControlInput,
  REMOTE_CONTROL_ACCESSIBILITY_PERMISSION_HELP,
  REMOTE_CONTROL_FRAME_MAX_BASE64_LENGTH,
  REMOTE_CONTROL_SCREEN_PERMISSION_HELP,
} from "@t3tools/contracts";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Electron from "electron";

import * as IpcChannels from "../channels.ts";
import * as DesktopIpc from "../DesktopIpc.ts";
import { remoteInputControllerForPlatform } from "../../app/RemoteInput.ts";

const SCREEN_RECORDING_PERMISSION_HELP = REMOTE_CONTROL_SCREEN_PERMISSION_HELP;
const ACCESSIBILITY_PERMISSION_HELP = REMOTE_CONTROL_ACCESSIBILITY_PERMISSION_HELP;

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

/**
 * Pairs each capture source with the screen display it shows.
 *
 * `display_id` is the documented link between `desktopCapturer` and
 * `screen.getAllDisplays()`, but on Windows it is routinely blank or drawn from
 * a different id space than `Display.id`. Both APIs do enumerate monitors in the
 * same order, so positional pairing is the reliable fallback.
 *
 * Everything downstream is keyed on the *source* id rather than the display id,
 * because that is the only value we can actually open a stream for — keying on
 * `Display.id` is what let a failed lookup silently capture the wrong monitor.
 */
function pairCaptureSources(
  sources: ReadonlyArray<Electron.DesktopCapturerSource>,
  displays: ReadonlyArray<Electron.Display>,
  primaryId: number,
): ReadonlyArray<{
  readonly source: Electron.DesktopCapturerSource;
  readonly display: Electron.Display | undefined;
  readonly isPrimary: boolean;
}> {
  return sources.map((source, index) => {
    const display =
      displays.find((candidate) => String(candidate.id) === source.display_id) ?? displays[index];
    return {
      source,
      display,
      // With no display to compare against, treat the first source as primary
      // so a default selection still lands somewhere sensible.
      isPrimary: display ? display.id === primaryId : index === 0,
    };
  });
}

/** Prefers the OS-reported monitor name, falling back to resolution. */
function describeDisplay(
  source: Electron.DesktopCapturerSource,
  display: Electron.Display | undefined,
  index: number,
  isPrimary: boolean,
): string {
  const resolution = display ? ` (${display.size.width}×${display.size.height})` : "";
  const name = source.name?.trim();
  if (isPrimary) return `Primary display${resolution}`;
  if (name && !/^entire screen$/i.test(name)) return `${name}${resolution}`;
  return `Display ${index + 1}${resolution}`;
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

        const allDisplays = Electron.screen.getAllDisplays();
        const primary = Electron.screen.getPrimaryDisplay();
        const targetDisplay =
          allDisplays.find((candidate) => String(candidate.id) === input.displayId) ?? primary;
        const targetHeight = Math.max(
          360,
          Math.round((input.maxWidth * targetDisplay.size.height) / targetDisplay.size.width),
        );
        const rawSources = await Electron.desktopCapturer.getSources({
          types: ["screen"],
          thumbnailSize: {
            width: input.maxWidth,
            height: targetHeight,
          },
          fetchWindowIcons: false,
        });
        const paired = pairCaptureSources(rawSources, allDisplays, primary.id);
        captureSourceDisplays.clear();
        for (const entry of paired) {
          if (entry.display) captureSourceDisplays.set(entry.source.id, entry.display);
        }
        const displays = paired.map(({ source: entry, display, isPrimary }, index) => ({
          id: entry.id,
          label: describeDisplay(entry, display, index, isPrimary),
          width: display?.size.width ?? 0,
          height: display?.size.height ?? 0,
          isPrimary,
        }));
        // Selection is keyed on the capture source id, so an unknown or
        // unplugged id falls back to the primary rather than an arbitrary one.
        const chosen =
          paired.find((candidate) => candidate.source.id === input.displayId) ??
          paired.find((candidate) => candidate.isPrimary) ??
          paired[0];
        const source = chosen?.source;
        if (!source || source.thumbnail.isEmpty()) {
          throw failCapture(
            platform === "darwin"
              ? SCREEN_RECORDING_PERMISSION_HELP
              : "Solla Code could not capture the selected display. Check the operating system's screen-capture permissions and try again.",
          );
        }

        return {
          ...encodeBoundedJpeg(source.thumbnail, input.jpegQuality),
          displayId: source.id,
          displays,
        };
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

/**
 * Resolves Chromium desktop-capture source ids for every monitor.
 *
 * A zero thumbnail size is the point: the renderer only needs the ids to open a
 * live MediaStream, and skipping thumbnail generation makes this far cheaper
 * than the per-frame `getSources` call the JPEG path depends on. It is invoked
 * once per session and again on a monitor switch, not per frame.
 */
export const listRemoteControlCaptureSources = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.REMOTE_CONTROL_CAPTURE_SOURCES_CHANNEL,
  payload: Schema.Struct({}),
  result: DesktopRemoteControlCaptureSourcesSchema,
  handler: Effect.fn("desktop.ipc.remoteControl.listCaptureSources")(function* () {
    const platform = yield* HostProcessPlatform;
    return yield* Effect.tryPromise({
      try: async () => {
        if (platform === "darwin") {
          const permission = Electron.systemPreferences.getMediaAccessStatus("screen");
          if (permission === "denied" || permission === "restricted") {
            throw failCapture(SCREEN_RECORDING_PERMISSION_HELP);
          }
        }
        const allDisplays = Electron.screen.getAllDisplays();
        const primary = Electron.screen.getPrimaryDisplay();
        const sources = await Electron.desktopCapturer.getSources({
          types: ["screen"],
          thumbnailSize: { width: 0, height: 0 },
          fetchWindowIcons: false,
        });
        const paired = pairCaptureSources(sources, allDisplays, primary.id);
        captureSourceDisplays.clear();
        for (const entry of paired) {
          if (entry.display) captureSourceDisplays.set(entry.source.id, entry.display);
        }
        return {
          displays: paired.map(({ source, display, isPrimary }, index) => ({
            id: source.id,
            label: describeDisplay(source, display, index, isPrimary),
            width: display?.size.width ?? 0,
            height: display?.size.height ?? 0,
            isPrimary,
          })),
          sources: paired.map(({ source }) => ({ displayId: source.id, sourceId: source.id })),
        };
      },
      catch: captureError,
    });
  }),
});

/**
 * Rewrites per-display normalized coordinates into virtual-desktop space.
 *
 * The controller normalizes against the monitor it is watching, but absolute
 * mouse injection addresses the whole virtual desktop on both platforms. Left
 * unmapped, a click aimed at a secondary monitor lands on the primary one —
 * only the region where the two happen to overlap appears to work.
 */
export function mapPointToVirtualDesktop(
  point: { readonly x: number; readonly y: number },
  bounds: {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
  },
  allBounds: ReadonlyArray<{
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
  }>,
): { readonly x: number; readonly y: number } {
  const left = Math.min(...allBounds.map((entry) => entry.x));
  const top = Math.min(...allBounds.map((entry) => entry.y));
  const right = Math.max(...allBounds.map((entry) => entry.x + entry.width));
  const bottom = Math.max(...allBounds.map((entry) => entry.y + entry.height));
  const spanX = Math.max(1, right - left);
  const spanY = Math.max(1, bottom - top);
  return {
    x: Math.max(0, Math.min(1, (bounds.x + point.x * bounds.width - left) / spanX)),
    y: Math.max(0, Math.min(1, (bounds.y + point.y * bounds.height - top) / spanY)),
  };
}

function toVirtualDesktopInput(
  input: DesktopRemoteControlInput["input"],
  displayId: string | undefined,
): DesktopRemoteControlInput["input"] {
  if (input.type !== "pointer" && input.type !== "wheel") return input;
  const displays = Electron.screen.getAllDisplays();
  // With one monitor the display *is* the virtual desktop, so 0..1 already means
  // the right thing. With several, the coordinates must always be remapped —
  // injection is flagged MOUSEEVENTF_VIRTUALDESK, so passing per-display values
  // through unmapped would smear them across the entire desktop.
  if (displays.length <= 1) return input;

  // `displayId` is a capture source id, so resolve it the same way capture does.
  // An unknown id means we could not tell which monitor is being viewed; the
  // primary is the safest assumption and still maps into virtual-desktop space.
  const primary = Electron.screen.getPrimaryDisplay();
  const target = displayId === undefined ? undefined : captureSourceDisplays.get(displayId);
  const bounds = (target ?? primary).bounds;

  return {
    ...input,
    ...mapPointToVirtualDesktop(
      input,
      bounds,
      displays.map((entry) => entry.bounds),
    ),
  };
}

/**
 * Capture-source id to display, populated whenever sources are enumerated.
 * Chromium's source ids carry no display information on their own, so the
 * mapping has to be remembered from the lookup that produced them.
 */
const captureSourceDisplays = new Map<string, Electron.Display>();

export const sendRemoteControlInput = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.REMOTE_CONTROL_SEND_INPUT_CHANNEL,
  payload: DesktopRemoteControlInputSchema,
  result: DesktopRemoteControlInputResultSchema,
  handler: Effect.fn("desktop.ipc.remoteControl.sendInput")(function* (input) {
    const platform = yield* HostProcessPlatform;
    return yield* Effect.tryPromise({
      try: async () => {
        if (platform === "darwin") {
          const trusted = Electron.systemPreferences.isTrustedAccessibilityClient(false);
          if (!trusted) {
            Electron.systemPreferences.isTrustedAccessibilityClient(true);
            throw failCapture(ACCESSIBILITY_PERMISSION_HELP);
          }
        }
        // A blocked host comes back as a result, not a rejection: the OS
        // refusing input while a UAC prompt is up is a condition to wait out,
        // and raising it here is what used to end the whole session.
        return await remoteInputControllerForPlatform(platform).send(
          toVirtualDesktopInput(input.input, input.displayId),
        );
      },
      catch: captureError,
    });
  }),
});

/**
 * Report whether some app on this host has captured the cursor.
 *
 * The controller mirrors this into browser pointer lock so the local cursor
 * stops wandering while the remote one is pinned inside a game, and so the
 * relative deltas mouse-look needs become available at all.
 *
 * Answered by the already-running input helper rather than a fresh process:
 * the host polls this for the life of a session.
 */
export const readRemoteControlPointerLock = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.REMOTE_CONTROL_POINTER_LOCK_CHANNEL,
  payload: Schema.Struct({}),
  result: DesktopRemoteControlHostStateSchema,
  handler: Effect.fn("desktop.ipc.remoteControl.pointerLock")(function* () {
    const platform = yield* HostProcessPlatform;
    // A host that cannot answer is reported as unlocked rather than failing the
    // poll: an unavailable signal must not take the session down with it.
    return yield* Effect.tryPromise({
      try: () => remoteInputControllerForPlatform(platform).readHostState(),
      catch: captureError,
    }).pipe(Effect.orElseSucceed(() => ({ locked: false })));
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
