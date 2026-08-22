import { describe, expect, it } from "vite-plus/test";

import { findMissingAssetReferences, normalizeArtifactPath } from "./assetReferences.ts";

const encoder = new TextEncoder();

function html(source: string, path = "index.html") {
  return { path, contentType: "text/html", bytes: encoder.encode(source) };
}

function asset(path: string, contentType = "image/webp") {
  return { path, contentType, bytes: new Uint8Array([1, 2, 3]) };
}

describe("findMissingAssetReferences", () => {
  it("finds an image the bundle never uploaded", () => {
    // The shape of the artifact that shipped broken: one HTML file naming
    // images that were never part of the revision.
    expect(findMissingAssetReferences([html('<img src="img/armchair.webp">')])).toEqual([
      "img/armchair.webp",
    ]);
  });

  it("finds paths built at runtime from a static list", () => {
    // An attribute-only scan misses this entirely — the markup is assembled in
    // JS, and the paths only ever appear as array entries.
    const source = `const m=[{i:"img/doors.webp"},{i:"img/lamp.webp"}];
      document.body.innerHTML=m.map(x=>'<img src="'+x.i+'">').join("");`;
    expect(findMissingAssetReferences([html(source)])).toEqual(["img/doors.webp", "img/lamp.webp"]);
  });

  it("says nothing when the assets are actually there", () => {
    expect(
      findMissingAssetReferences([html('<img src="img/hero.webp">'), asset("img/hero.webp")]),
    ).toEqual([]);
  });

  it("matches through ./ and / prefixes and query strings", () => {
    expect(
      findMissingAssetReferences([
        html('<img src="./img/hero.webp"><img src="/img/hero.webp?v=2">'),
        asset("img/hero.webp"),
      ]),
    ).toEqual([]);
  });

  it("ignores anything the bundle is not responsible for serving", () => {
    const source = `<img src="https://cdn.example.com/a.png">
      <img src="//cdn.example.com/b.png">
      <img src="data:image/png;base64,AAAA">
      <img src="blob:something.png">`;
    expect(findMissingAssetReferences([html(source)])).toEqual([]);
  });

  it("ignores references it cannot resolve by reading", () => {
    // A path with a template hole or a concatenation is not knowable here, and
    // flagging it would block bundles that work.
    const source = "const a=`img/${name}.webp`; const b='img/'+key+'.png';";
    expect(findMissingAssetReferences([html(source)])).toEqual([]);
  });

  it("finds url() references in stylesheets", () => {
    const css = {
      path: "styles.css",
      contentType: "text/css",
      bytes: encoder.encode(".hero{background:url('img/bg.jpg')}"),
    };
    expect(findMissingAssetReferences([css])).toEqual(["img/bg.jpg"]);
  });

  it("does not scan binary files for text that looks like a path", () => {
    // Compressed bytes can coincidentally spell something path-shaped; reading
    // them as UTF-8 would invent references the bundle never made.
    const binary = {
      path: "img/hero.webp",
      contentType: "image/webp",
      bytes: encoder.encode('garbage "nope/ghost.png" garbage'),
    };
    expect(findMissingAssetReferences([binary])).toEqual([]);
  });

  it("caps the report so one generated bundle stays readable", () => {
    const source = Array.from({ length: 40 }, (_, index) => `<img src="img/${index}.png">`).join(
      "",
    );
    expect(findMissingAssetReferences([html(source)]).length).toBe(12);
  });
});

describe("normalizeArtifactPath", () => {
  it("strips prefixes, queries, and fragments", () => {
    expect(normalizeArtifactPath("./img/a.png?v=1#x")).toBe("img/a.png");
    expect(normalizeArtifactPath("/img/a.png")).toBe("img/a.png");
  });
});
