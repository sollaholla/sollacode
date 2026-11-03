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

macOS Intel is now the slowest job. Building it on an arm64 runner would save about ten minutes, but it would tie both Mac downloads to the runner pool that runs out.

## Jobs no runner picked up

GitHub sometimes has no macOS arm64 runner free. The job then ends `cancelled` with no steps after 15 minutes, and the run counts as failed. `rerun-unassigned-jobs.yml` reruns those jobs until a runner takes them, up to 16 times. It leaves a run alone if any job really failed, and it does not act on pull requests.
