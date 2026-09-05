import { describe, expect, it } from "vite-plus/test";
import { resolveCheckoutLinks, stripePaymentLink } from "./checkout";

describe("subscription checkout availability", () => {
  it.each([
    undefined,
    "",
    "not a URL",
    "http://buy.stripe.com/example",
    "https://buy.stripe.com.evil.example/example",
    "https://example.com/checkout",
    "https://buy.stripe.com/",
    "https://buy.stripe.com/test_example",
    "https://user:password@buy.stripe.com/example",
    "https://buy.stripe.com:8443/example",
  ])("rejects an unavailable or unsuitable link: %s", (link) => {
    expect(stripePaymentLink(link)).toBeUndefined();
  });

  it("keeps both plans unavailable when either configured link is missing or a sandbox link", () => {
    const monthly = "https://buy.stripe.com/monthlyExample";
    expect(resolveCheckoutLinks(monthly, undefined)).toEqual({
      monthly: undefined,
      annual: undefined,
    });
    expect(resolveCheckoutLinks(monthly, "https://buy.stripe.com/test_example")).toEqual({
      monthly: undefined,
      annual: undefined,
    });
  });

  it("exposes both configured live-format links together", () => {
    const monthly = "https://buy.stripe.com/monthlyExample";
    const annual = "https://buy.stripe.com/annualExample";
    expect(resolveCheckoutLinks(monthly, annual)).toEqual({ monthly, annual });
  });
});
