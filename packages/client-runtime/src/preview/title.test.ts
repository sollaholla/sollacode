import { describe, expect, it } from "vite-plus/test";

import { formatPreviewTitle } from "./title.ts";

describe("formatPreviewTitle", () => {
  it("repairs the malformed middle dot from the Patient music tab", () => {
    expect(formatPreviewTitle("Patient music \u00c2\u00b7 layout preview")).toBe(
      "Patient music · layout preview",
    );
  });

  it("repairs nonbreaking spaces without collapsing them", () => {
    expect(formatPreviewTitle("Music\u00c2\u00a0player\u00c2\u00a0preview")).toBe(
      "Music\u00a0player\u00a0preview",
    );
  });

  it.each(["", "Patient music · layout preview", "Ângela · 音楽 🎵", "Â", "Âme et musique"])(
    "preserves correctly encoded text: %s",
    (title) => expect(formatPreviewTitle(title)).toBe(title),
  );

  it("preserves multilingual text next to a malformed separator", () => {
    const title = formatPreviewTitle("Ângela \u00c2\u00b7 音楽 🎵");
    expect(title).toBe("Ângela · 音楽 🎵");
    expect(formatPreviewTitle(title)).toBe(title);
  });
});
