# CI quality gates

- `.github/workflows/ci.yml` runs `vp check` (lint + typecheck), `vpr typecheck`, and `vp run test` on pull requests and pushes to `main`.
- `.github/workflows/release.yml` builds macOS (`arm64` and `x64`), Linux (`x64`), and Windows (`x64`) desktop artifacts from a single `v*.*.*` tag and publishes one GitHub release.
- The release workflow auto-enables signing only when platform credentials are present. macOS passkey builds additionally require `APPLE_TEAM_ID` and the `MACOS_PROVISIONING_PROFILE` secret; Windows uses Azure Trusted Signing. Without the core signing credentials, it still releases unsigned artifacts.
- See [Release Checklist](./release.md) for the full release/signing setup checklist.

The main workflow also checks Rust formatting/tests, builds the desktop package, verifies its preload contract, runs mobile static lint, and exercises release smoke checks. These are CI responsibilities. Local changes should run the focused tests and package typechecks relevant to the edited behavior; see [AGENTS.md](../../AGENTS.md).

## Build time

A release publishes when its slowest job finishes, so these keep that job short:

- **Builds do not wait for tests.** `preflight` only names the release and runs the private-name check. Checks, tests and builds then run side by side, and nothing publishes unless all of them pass. A failing test therefore still costs the build minutes, but it cannot publish anything.
- **The server tests are split across three machines.** Files in that suite run one at a time because parallel files turn flaky under load, so use `--shard` to go faster rather than raising parallelism.
- **Build jobs install only what a desktop app needs.** Mobile and marketing are filtered out. The smaller package store reaches the cache at the next lockfile change, because the cache key is the lockfile hash.
- **The resource monitor's Rust output is cached** per target.
- **The Windows job installs no MSVC components.** node-pty ships Windows binaries and nothing compiles there; the package smoke test spawns a real shell, so a missing binary fails the job.
- **macOS zips use a light compression level.** It halves packaging time for 2% more size. Windows keeps the default, because level 1 makes the installer 38% larger.

macOS Intel is now the slowest job. Both Mac builds run on Intel runners, because GitHub's arm64 Mac runners run out for hours at a time.

## Jobs no runner picked up

GitHub's macOS arm64 runners run out, on every image: a job ends `cancelled` with no steps after 15 minutes, the run counts as failed, and each attempt emails the maintainer. So no job that runs on its own depends on them. The arm64 app is cross-built on an Intel runner, and mobile linting runs on Intel too.

An Intel runner cannot start an arm64 app, so that build skips the launch test and `scripts/check-mac-arm64-artifact.ts` proves its binaries are arm64 instead. The x64 build runs the launch test from the same source.

`rerun-unassigned-jobs.yml` remains for any other job no runner takes. It reruns those jobs up to 16 times, leaves a run alone if any job really failed, and does not act on pull requests or scheduled nightlies, whose next run is three hours later anyway.
