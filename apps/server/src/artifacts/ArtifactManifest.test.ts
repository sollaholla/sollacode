import { describe, expect, it } from "vite-plus/test";

import { deriveArtifactMimeType } from "./ArtifactManifest.ts";

const ascii = (text: string) => [...text].map((character) => character.charCodeAt(0));
const bytes = (...values: ReadonlyArray<number>) => new Uint8Array([...values, 0, 0, 0, 0]);

describe("deriveArtifactMimeType", () => {
  it("recognises video and audio by their opening bytes", () => {
    const isoMedia = bytes(0, 0, 0, 0x20, ...ascii("ftypisom"));
    expect(deriveArtifactMimeType("run.mp4", isoMedia)).toBe("video/mp4");
    expect(deriveArtifactMimeType("run.m4v", isoMedia)).toBe("video/mp4");
    expect(deriveArtifactMimeType("run.m4a", isoMedia)).toBe("audio/mp4");
    // QuickTime files often open with a `wide` or `mdat` atom instead of ftyp.
    expect(deriveArtifactMimeType("run.mov", bytes(0, 0, 0, 8, ...ascii("wide")))).toBe(
      "video/quicktime",
    );
    expect(deriveArtifactMimeType("run.webm", bytes(0x1a, 0x45, 0xdf, 0xa3))).toBe("video/webm");
    expect(deriveArtifactMimeType("beep.mp3", bytes(...ascii("ID3")))).toBe("audio/mpeg");
    expect(deriveArtifactMimeType("beep.mp3", bytes(0xff, 0xfb))).toBe("audio/mpeg");
    expect(
      deriveArtifactMimeType("beep.wav", bytes(...ascii("RIFF"), 0, 0, 0, 0, ...ascii("WAVE"))),
    ).toBe("audio/wav");
    expect(deriveArtifactMimeType("beep.ogg", bytes(...ascii("OggS")))).toBe("audio/ogg");
  });

  it("refuses a media extension on bytes that are something else", () => {
    const html = new TextEncoder().encode("<!doctype html><p>not a video</p>");
    for (const path of ["run.mp4", "run.mov", "run.webm", "beep.mp3", "beep.wav", "beep.ogg"]) {
      expect(deriveArtifactMimeType(path, html), path).toBeNull();
    }
  });
});
