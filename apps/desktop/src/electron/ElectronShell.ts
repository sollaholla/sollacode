import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as Electron from "electron";

const SAFE_EXTERNAL_PROTOCOLS = new Set(["http:", "https:"]);

function normalizeClipboardText(value: string): string {
  return value.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
}

export function parseSafeExternalUrl(rawUrl: unknown): Option.Option<string> {
  if (typeof rawUrl !== "string") {
    return Option.none();
  }

  try {
    const url = new URL(rawUrl);
    return SAFE_EXTERNAL_PROTOCOLS.has(url.protocol) ? Option.some(url.href) : Option.none();
  } catch {
    return Option.none();
  }
}

export class ElectronShell extends Context.Service<
  ElectronShell,
  {
    readonly openExternal: (rawUrl: unknown) => Effect.Effect<boolean>;
    readonly copyText: (text: string) => Effect.Effect<void>;
    readonly writeComposerClipboard: (input: {
      readonly text: string;
      readonly html: string;
      readonly imagePng: Uint8Array;
    }) => Effect.Effect<boolean>;
  }
>()("@t3tools/desktop/electron/ElectronShell") {}

export const make = ElectronShell.of({
  openExternal: (rawUrl) =>
    Option.match(parseSafeExternalUrl(rawUrl), {
      onNone: () => Effect.succeed(false),
      onSome: (externalUrl) =>
        Effect.promise(() =>
          Electron.shell.openExternal(externalUrl).then(
            () => true,
            () => false,
          ),
        ),
    }),
  copyText: (text) =>
    Effect.sync(() => {
      Electron.clipboard.writeText(text);
    }),
  writeComposerClipboard: (input) =>
    Effect.sync(() => {
      try {
        const image = Electron.nativeImage.createFromBuffer(Buffer.from(input.imagePng));
        if (image.isEmpty()) return false;

        Electron.clipboard.write({
          text: input.text,
          html: input.html,
          image,
        });

        // A successful API call is not enough: Chromium's async clipboard path
        // succeeds on macOS while silently keeping only the bitmap. Verify all
        // representations before the renderer is allowed to clear the draft.
        return (
          normalizeClipboardText(Electron.clipboard.readText()) ===
            normalizeClipboardText(input.text) &&
          Electron.clipboard.readHTML().includes(input.html) &&
          !Electron.clipboard.readImage().isEmpty()
        );
      } catch {
        return false;
      }
    }),
});

export const layer = Layer.succeed(ElectronShell, make);
