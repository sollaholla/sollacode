# Release Checklist

This document covers the checked-in workflow for Solla Code stable and nightly desktop releases. Workflow configuration is not proof that a release has been built or published.

## What the workflow does

- Workflow: `.github/workflows/release.yml`
- Triggers:
  - push tag matching `v*.*.*` for stable releases
  - scheduled nightly check every three hours
  - manual `workflow_dispatch` for either channel
- Runs quality gates first: lint, typecheck, test.
- Builds four artifacts in parallel for both channels:
  - macOS `arm64` DMG
  - macOS `x64` DMG
  - Linux `x64` AppImage
  - Windows `x64` NSIS installer
- Publishes one GitHub Release with all produced files.
  - Stable tags with a suffix after `X.Y.Z` (for example `1.2.3-alpha.1`) are published as GitHub prereleases.
  - Only plain stable `X.Y.Z` releases are marked as the repository's latest release.
  - Nightly runs are always GitHub prereleases and never marked latest.
  - Automatically generated release notes are pinned to the previous tag in the same channel, so stable compares to the previous stable tag and nightly compares to the previous nightly tag.
- Optionally publishes the CLI package with OIDC trusted publishing when `RELEASE_PUBLISH_CLI=true`. The retained package name `t3` belongs to upstream and must be migrated to a fork-owned package before enabling this stage:
  - stable releases publish npm dist-tag `latest`
  - nightly releases publish npm dist-tag `nightly`
- Deploys the hosted web app to Vercel only after a release is published:
  - stable releases are aliased to the `latest` hosted app channel
  - nightly releases are aliased to the `nightly` hosted app channel
- Signing is optional and auto-detected per platform from secrets.

## T3 Connect is not part of this fork

Upstream resolves Clerk sign-in and relay endpoints from a Cloudflare-deployed
relay worker (`infra/relay`, workspace package `t3code-relay`) in a
`Resolve T3 Connect public config` job. That subtree was removed from this fork
in `565e7c13e`, so the job had nothing to filter on and failed on every run.
Because it declared `environment: production`, its failure is what marked the
repository's production deployments red — and because every later job gated on
it, no release was ever packaged.

The job and all of its plumbing are gone. Nothing in the release declares a
GitHub environment now, so the workflow no longer opens deployment records for
a deployment that does not exist. The build-time defines it used to populate
(`__T3CODE_BUILD_RELAY_URL__`, `__T3CODE_BUILD_CLERK_*__`, the OTLP tracing
values) already default to `""` in `apps/server/vite.config.ts`, so artifacts
build unchanged — they simply ship without hosted sign-in and relay endpoints
baked in.

Restoring T3 Connect means restoring the `infra/relay` package, a Cloudflare
account, and a Clerk tenant — not just setting a secret. Re-add the job from
upstream if that ever happens.

Signed macOS builds use Electron execution and microphone entitlements. This fork
does not require a Clerk tenant, passkey relying-party domain, or passkey
provisioning profile. Signing and notarization credentials are still required
when publishing a signed release.

## Optional services

The remaining hosted integrations are optional and auto-detected. With no
secrets configured, the workflow still runs the full quality gates, builds all
four desktop artifacts, and publishes a GitHub Release.

| Stage                                    | Enabled by                                                     | When unconfigured                                                              |
| ---------------------------------------- | -------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| npm CLI publish                          | `RELEASE_PUBLISH_CLI` repository variable set to `true`        | `publish_cli` is skipped; `release` proceeds anyway                            |
| Hosted web app deploy                    | `VERCEL_TOKEN` + `VERCEL_ORG_ID` + `VERCEL_PROJECT_ID` secrets | `deploy_web` no-ops and reports success                                        |
| Release commits authored by a GitHub App | `RELEASE_APP_ID` + `RELEASE_APP_PRIVATE_KEY` secrets           | Falls back to the built-in `GITHUB_TOKEN`, committing as `github-actions[bot]` |
| Discord announcement                     | `DISCORD_RELEASE_WEBHOOK_URL` secret                           | Announcement steps are skipped                                                 |
| macOS / Windows code signing             | Apple and Azure secrets (see below)                            | Unsigned artifacts                                                             |

Skipping the npm publish gives up the server self-update invariant described
below: a client can only update a connected server to its exact version if a
matching package exists on npm. To restore it, publish the CLI under a package
name this fork owns — `apps/server/package.json` is still named `t3`, which only
upstream can publish — and set `RELEASE_PUBLISH_CLI=true`.

## Hosted web app release deployment

The hosted app is intentionally not deployed by Vercel's Git integration. The
web project disables automatic Git deployments in `apps/web/vercel.ts` via
`git.deploymentEnabled: false`, and `.github/workflows/release.yml` deploys the
web app with Vercel CLI after the GitHub Release succeeds.

Required GitHub Actions secrets:

- `VERCEL_TOKEN`
- `VERCEL_ORG_ID`
- `VERCEL_PROJECT_ID`

Optional GitHub Actions variables:

- `VERCEL_TEAM_SLUG`: overrides the Vercel CLI scope when the team slug is preferred over the `VERCEL_ORG_ID` secret.
- `T3CODE_WEB_ROUTER_URL`: defaults to `https://app.t3.codes`.
- `T3CODE_WEB_LATEST_DOMAIN`: defaults to `latest.app.t3.codes`.
- `T3CODE_WEB_NIGHTLY_DOMAIN`: defaults to `nightly.app.t3.codes`.

Inherited Vercel domain defaults (upstream-owned; configure fork-owned replacements before deploying):

- `app.t3.codes`: the router domain users open, updated by stable releases.
- `latest.app.t3.codes`: channel alias updated by stable releases.
- `nightly.app.t3.codes`: channel alias updated by nightly releases.

The router domain uses `apps/web/vercel.ts` routes. Users opt into a channel by
visiting `/__t3code/channel?channel=latest` or
`/__t3code/channel?channel=nightly`; the router stores the
`t3code_web_channel` cookie and rewrites future requests on `app.t3.codes` to
the matching channel alias.

The release deploy job rewrites release package versions before upload so the
hosted app's About panel renders the release version. Stable deploys alias the
same deployment to both the `latest` channel and the router domain so the router
rules stay current. Nightly deploys only alias the `nightly` channel. The job
also passes `VITE_HOSTED_APP_CHANNEL=latest|nightly`, which renders the hosted
update track selector in the About panel. Changing the selector navigates
through `/__t3code/channel` on the router domain so the user's channel cookie is
updated before redirecting to the hosted app root.

One-time Vercel dashboard setup:

1. Confirm the web project root directory remains `apps/web`.
2. Configure three domains owned by this fork and override all three `T3CODE_WEB_*` values above. Do not attempt to claim the upstream domains.
3. Disable automatic Git deployments in the dashboard if desired; the committed
   `vercel.ts` setting is the source-of-truth, but disconnecting Git in the
   dashboard is also safe.
4. Run one stable release deployment, or manually alias the current stable
   deployment, so the configured fork router domain points at a deployment containing the router
   rules in `apps/web/vercel.ts`. Future stable releases keep this alias current.

## Nightly builds

- Workflow: `.github/workflows/release.yml`
- Triggers:
  - scheduled check every three hours
  - manual `workflow_dispatch` with `channel=nightly`
- Runs the same desktop quality gates and artifact matrix as the tagged release flow.
- Publishes a GitHub prerelease only:
  - tag format: `nightly-vX.Y.Z-nightly.YYYYMMDD.<run_number>`
  - release name includes the short commit SHA
  - `make_latest` is always `false`
- Uses the next stable patch version as the nightly base. For example, `0.0.17` produces nightlies on `0.0.18-nightly.*`.
- Publishes a CLI to the `nightly` npm dist-tag only when CLI publishing is enabled and package ownership has been configured.
- Does not commit version bumps back to `main`.

## Server self-update release invariant

This invariant applies only when an owned CLI distribution is enabled. The default fork release can skip `publish_cli`; it does not promise npm self-update support.

Connected servers update to the client's exact version, not to an npm dist-tag. Every released
desktop or hosted client version must therefore have a matching `t3@<version>` package available on
npm before users can receive that client.

When CLI publishing is enabled, the workflow uses this ordering:

1. `publish_cli` publishes the exact stable or nightly version to npm.
2. `release` depends on `publish_cli` before exposing desktop artifacts in GitHub Releases.
3. `deploy_web` depends on `release` before moving the hosted channel to the new client.

Preserve these dependencies when changing the release graph. Publishing a client first would leave
the **Update server** action targeting a package version that does not exist yet.

For a release smoke test, confirm `npm view t3@<version> version` returns the expected version, then
connect the new client to a server on the previous version and verify that the update action
reconnects to the matching server. Test one automatic path and the manual or desktop-managed
guidance when those environments are available.

## 0) npm OIDC trusted publishing setup (CLI)

The workflow publishes the CLI with `npm publish` from `apps/server` after bumping
the package version to the release tag version.

Checklist:

1. Choose a fork-owned package name and update the package manifest, pinned-runtime installer, self-update detection, remote bootstrap, and client update commands together. The retained upstream `t3` name is not a Solla publishing target.
2. In npm package settings, configure Trusted Publisher:
   - Provider: GitHub Actions
   - Repository: this repo
   - Workflow file: `.github/workflows/release.yml`
   - Environment (if used): match your npm trusted publishing config
3. Ensure npm account and org policies allow trusted publishing for the package.
4. Create release tag `vX.Y.Z` and push; workflow will:
   - set `apps/server/package.json` version to `X.Y.Z`
   - build web + server
   - run `npm publish --access public --tag latest`
5. Nightly runs from the same workflow file publish with `npm publish --access public --tag nightly`.

## 1) Unsigned test release (publishes externally)

A test tag runs the publishing workflow; it is not a dry run. For local checks first, run `node scripts/release-smoke.ts` or create a desktop artifact without pushing a tag.

1. Confirm no signing secrets are required for this test.
2. Create a test tag:
   - `git tag v0.0.0-test.1`
   - `git push origin v0.0.0-test.1`
3. Wait for `.github/workflows/release.yml` to finish.
4. Verify the GitHub Release contains all platform artifacts.
5. Download each artifact and sanity-check installation on each OS.

## 2) Apple signing + notarization setup (macOS)

Required secrets used by the workflow:

- `CSC_LINK`
- `CSC_KEY_PASSWORD`
- `APPLE_API_KEY`
- `APPLE_API_KEY_ID`
- `APPLE_API_ISSUER`
- `MACOS_PROVISIONING_PROFILE` (base64-encoded provisioning profile with Associated Domains)

Required repository variables:

- `APPLE_TEAM_ID`

Checklist:

1. Apple Developer account access:
   - Team has rights to create Developer ID certificates.
2. Create an explicit App ID for `com.sollacode.app` and enable Associated Domains. This must match
   `DESKTOP_APP_ID` in `scripts/build-desktop-artifact.ts`; a profile issued for any other App ID is
   rejected at signing time.
3. Create a `Developer ID Application` certificate and a compatible provisioning profile for that
   App ID with Associated Domains enabled.
4. Export the certificate + private key as `.p12` from Keychain.
5. Base64-encode the `.p12` and store as `CSC_LINK`.
6. Base64-encode the provisioning profile and store it as `MACOS_PROVISIONING_PROFILE`.
7. Store the `.p12` export password as `CSC_KEY_PASSWORD`, and set `APPLE_TEAM_ID` to the
   10-character Apple Developer Team ID.
8. In App Store Connect, create an API key (Team key).
9. Add API key values:
   - `APPLE_API_KEY`: contents of the downloaded `.p8`
   - `APPLE_API_KEY_ID`: Key ID
   - `APPLE_API_ISSUER`: Issuer ID
10. Re-run a tag release and confirm macOS artifacts are signed/notarized and contain the expected
    `com.apple.developer.associated-domains` entitlement.

Notes:

- `APPLE_API_KEY` is stored as raw key text in secrets.
- The workflow writes it to a temporary `AuthKey_<id>.p8` file at runtime.
- The workflow decodes `MACOS_PROVISIONING_PROFILE`, validates it with `security cms`, and passes it
  to the desktop packager.

## 3) Azure Trusted Signing setup (Windows)

Required secrets used by the workflow:

- `AZURE_TENANT_ID`
- `AZURE_CLIENT_ID`
- `AZURE_CLIENT_SECRET`
- `AZURE_TRUSTED_SIGNING_ENDPOINT`
- `AZURE_TRUSTED_SIGNING_ACCOUNT_NAME`
- `AZURE_TRUSTED_SIGNING_CERTIFICATE_PROFILE_NAME`
- `AZURE_TRUSTED_SIGNING_PUBLISHER_NAME`

Checklist:

1. Create Azure Trusted Signing account and certificate profile.
2. Record ATS values:
   - Endpoint
   - Account name
   - Certificate profile name
   - Publisher name
3. Create/choose an Entra app registration (service principal).
4. Grant service principal permissions required by Trusted Signing.
5. Create a client secret for the service principal.
6. Add Azure secrets listed above in GitHub Actions secrets.
7. Re-run a tag release and confirm Windows installer is signed.

## 4) Ongoing release checklist

1. Ensure `main` is green in CI.
2. Bump app version as needed.
3. Create release tag: `vX.Y.Z`.
4. Push tag.
5. Verify workflow steps:
   - preflight passes
   - all matrix builds pass
   - `publish_cli` publishes the exact release version before the release job when enabled; otherwise it is explicitly skipped
   - release job uploads expected files
6. Smoke test downloaded artifacts.

## 5) Troubleshooting

- macOS build unsigned when expected signed:
  - Check all Apple secrets plus `APPLE_TEAM_ID` are populated and non-empty.
  - Confirm the provisioning profile belongs to `APPLE_TEAM_ID.com.sollacode.app` and includes
    Associated Domains.
- Windows build unsigned when expected signed:
  - Check all Azure ATS and auth secrets are populated and non-empty.
- Build fails with signing error:
  - Retry with secrets removed to confirm unsigned path still works.
  - Re-check certificate/profile names and tenant/client credentials.
