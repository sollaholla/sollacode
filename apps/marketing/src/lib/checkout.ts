/** Only configured, secure Stripe Payment Links can become subscription actions. */
export function stripePaymentLink(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    if (
      url.protocol !== "https:" ||
      url.hostname !== "buy.stripe.com" ||
      url.username ||
      url.password ||
      url.port ||
      url.pathname.startsWith("/test_") ||
      url.pathname === "/"
    )
      return undefined;
    return url.href;
  } catch {
    return undefined;
  }
}
/** Publish both billing options together so availability and checkout actions agree. */
export function resolveCheckoutLinks(monthly: string | undefined, annual: string | undefined) {
  const monthlyLink = stripePaymentLink(monthly);
  const annualLink = stripePaymentLink(annual);
  return monthlyLink && annualLink
    ? { monthly: monthlyLink, annual: annualLink }
    : { monthly: undefined, annual: undefined };
}

const checkout = resolveCheckoutLinks(
  import.meta.env.PUBLIC_STRIPE_MONTHLY_LINK,
  import.meta.env.PUBLIC_STRIPE_ANNUAL_LINK,
);
export const monthlyCheckout = checkout.monthly;
export const annualCheckout = checkout.annual;
