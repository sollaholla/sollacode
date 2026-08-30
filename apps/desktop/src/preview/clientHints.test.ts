import { assert, describe, it } from "@effect/vitest";

import { withChromeClientHintBrand, withGoogleChromeBrand } from "./clientHints.ts";

describe("withGoogleChromeBrand", () => {
  it("appends a Google Chrome brand at Chromium's major version for Sec-CH-UA", () => {
    assert.strictEqual(
      withGoogleChromeBrand('"Chromium";v="146", "Not-A.Brand";v="24"'),
      '"Chromium";v="146", "Not-A.Brand";v="24", "Google Chrome";v="146"',
    );
  });

  it("appends a Google Chrome brand at Chromium's full version for the full version list", () => {
    assert.strictEqual(
      withGoogleChromeBrand('"Chromium";v="146.0.7680.216", "Not-A.Brand";v="24.0.0.0"'),
      '"Chromium";v="146.0.7680.216", "Not-A.Brand";v="24.0.0.0", ' +
        '"Google Chrome";v="146.0.7680.216"',
    );
  });

  it("is idempotent when a Google Chrome brand is already present", () => {
    const value = '"Chromium";v="146", "Google Chrome";v="146", "Not-A.Brand";v="24"';
    assert.strictEqual(withGoogleChromeBrand(value), value);
  });

  it("leaves a header with no Chromium brand untouched", () => {
    const value = '"Not-A.Brand";v="99"';
    assert.strictEqual(withGoogleChromeBrand(value), value);
  });

  it("leaves an empty value untouched", () => {
    assert.strictEqual(withGoogleChromeBrand(""), "");
  });
});

describe("withChromeClientHintBrand", () => {
  it("rewrites only the brand client-hint headers, case-insensitively", () => {
    const result = withChromeClientHintBrand({
      "Sec-CH-UA": '"Chromium";v="146", "Not-A.Brand";v="24"',
      "sec-ch-ua-full-version-list": '"Chromium";v="146.0.7680.216", "Not-A.Brand";v="24.0.0.0"',
      "Sec-CH-UA-Platform": '"macOS"',
      "User-Agent": "Mozilla/5.0 Chrome/146.0.7680.216 Safari/537.36",
    });
    assert.strictEqual(
      result["Sec-CH-UA"],
      '"Chromium";v="146", "Not-A.Brand";v="24", "Google Chrome";v="146"',
    );
    assert.strictEqual(
      result["sec-ch-ua-full-version-list"],
      '"Chromium";v="146.0.7680.216", "Not-A.Brand";v="24.0.0.0", ' +
        '"Google Chrome";v="146.0.7680.216"',
    );
    // Non-brand headers pass through untouched.
    assert.strictEqual(result["Sec-CH-UA-Platform"], '"macOS"');
    assert.strictEqual(result["User-Agent"], "Mozilla/5.0 Chrome/146.0.7680.216 Safari/537.36");
  });

  it("returns the same object reference when nothing needs rewriting", () => {
    const headers = {
      "Sec-CH-UA": '"Chromium";v="146", "Google Chrome";v="146", "Not-A.Brand";v="24"',
      Accept: "text/html",
    };
    assert.strictEqual(withChromeClientHintBrand(headers), headers);
  });
});
