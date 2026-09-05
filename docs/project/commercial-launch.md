# Solla Code commercial launch

## License and identity

The repository's [MIT License](../../LICENSE) permits commercial use, modification,
distribution, and sale. It requires the copyright and permission notice to travel
with copies or substantial portions of the software. The current
[upstream license](https://github.com/pingdotgg/t3code/blob/main/LICENSE) was checked
on 4 September 2026 and matches this checkout. Keep that license in source and
packaged distributions. Desktop staging copies the license unchanged; the local 0.1.426
arm64 package was checked byte for byte.

Solla Code is an independently maintained fork of T3 Code. The MIT permission is
not a claim to upstream branding, endorsements, customer testimonials, or services.
The website and README identify the fork and link its own releases. Compatibility
package names and settings are documented in [fork identity](../reference/fork-identity.md).
Provider accounts, models, and usage charges remain separate; a Solla subscription
does not grant access to another provider's paid services.

## Price and current availability

The planned price is **$10 USD per month or $120 USD per year**, before applicable
taxes. Both billing schedules total $120 over twelve months; there is no annual
discount claim. The MIT source remains available to use and build under its license.

As of 4 September 2026, the payment coordinator reports that Stripe is still in
sandbox mode, owner business verification is incomplete, and no live product,
price, or Payment Link exists. The payout destination is an owner decision. No
Solla Code launch domain has been verified as owned. These are launch dependencies,
not engineering defaults or an announced launch date.

The marketing site therefore displays subscription preparation and collects no
payment. `apps/marketing/src/lib/checkout.ts` enables subscription actions only
when **both** `PUBLIC_STRIPE_MONTHLY_LINK` and `PUBLIC_STRIPE_ANNUAL_LINK` contain
secure, non-sandbox Stripe Payment Links. URL validation establishes format, not
merchant ownership, price correctness, or a successfully activated account.

Before enabling checkout, the payment coordinator must verify the owner-approved
merchant account, two recurring prices, cancellation/customer-portal settings,
receipts, renewal reminders, support information, and the checkout's actual offer.
Any site domain purchase or live account activation requires the owner's decision.
Set the marketing deployment's canonical origin only after its host is confirmed.

## Website and film assets

- The gold S uses the owner's `SM_SollaCode_Logo_01` Blender geometry. The export
  script preserves the original file, mirrors the front across the depth axis to
  form the back, and joins the boundary. Its materials and glints are generated
  mathematically; no image texture or ML artwork is used. Export provenance and
  the source digest are in `apps/marketing/public/brand/provenance.json`.
- Interface images and footage come from the production Solla client using a
  disposable, illustrative workspace. They are not screenshots of customer data.
- The soundtrack is original oscillator and noise synthesis, with no samples or
  ML generation. Its source is `tools/motion/scripts/compose_score.py`.
- DM Sans is self-hosted, with its Open Font License shipped beside the font in
  `apps/marketing/public/fonts/`.
- Blender, FFmpeg, Chromium, React, esbuild, and Playwright are production tools.
  Their licenses permit commercial use; their own redistribution obligations
  still apply if their binaries or code are redistributed. They are not sold as
  proprietary Solla components. The film does not depend on Remotion.

Apple's website informed the restrained navigation, large product typography,
spacing, and chapter progression. The Solla page uses its own layout, copy, model,
screenshots, and graphics; no Apple artwork or product render is included.

See [the media workflow](../../tools/motion/README.md) for capture, rendering, and
verification details. A working local site and rendered film do not establish a
public deployment, active subscription service, paying audience, or guaranteed
reliability across every provider and operating system.
