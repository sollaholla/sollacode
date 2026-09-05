import { describe, expect, it } from "vite-plus/test";

import {
  isLegalDocumentUrl,
  LEGAL_URL,
  PRIVACY_POLICY_URL,
  SECURITY_POLICY_URL,
  TERMS_OF_SERVICE_URL,
} from "./legal-document-url";

describe("isLegalDocumentUrl", () => {
  it.each([LEGAL_URL, PRIVACY_POLICY_URL, SECURITY_POLICY_URL, TERMS_OF_SERVICE_URL])(
    "allows a configured legal document: %s",
    (url) => {
      expect(isLegalDocumentUrl(url)).toBe(true);
    },
  );

  it.each([
    "https://t3.codes/legal",
    "https://t3.codes/download",
    "https://example.com/legal",
    "javascript:alert(1)",
    "not-a-url",
  ])("rejects a URL outside the legal-document allowlist: %s", (url) => {
    expect(isLegalDocumentUrl(url)).toBe(false);
  });
});
