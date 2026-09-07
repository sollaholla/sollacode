# Solla Code: complete cleanup audit and implementation handoff

**Prepared:** 2026-09-07. **Repository:** `/Users/solomannorthrop/Documents/t3-fork`.
**Baseline:** `1b6d64185` on `main` (`chore: checkpoint all current Solla Code work for handoff`).
**Deliverable:** an implementation plan, not a claim that the planned refactors have been implemented.

## 1. Start here: instructions for the implementing agent

Read this entire document before editing. Then execute the numbered work orders in section 7, one bounded change at a time. Each order includes the evidence, exact starting files, intended result, implementation sequence, checks, and conditions for retaining existing code. Do not turn a candidate into a deletion without completing its reference checks. Do not replace a task's acceptance criteria with “build passed.”

The user explicitly requested that **all existing working-tree changes be committed before handoff**. That checkpoint is `1b6d64185`: 108 files, including previously untracked implementations and tests. The commit hook formatted the staged files. It does not establish a new passing test baseline. The audit documents and supporting evidence are committed separately. Record that later documentation commit from `git log`; do not treat it as a product release.

The user also explicitly said **do not revert the existing fixes**. In particular, retain queued-message delivery, automatic agent continuation, usage guards, provider failover, remote input/zoom fixes, and withholding Dismiss on running provider tasks. Extract their implementations only after preserving their current tests and understanding the ordering guarantees.

### Nonnegotiable execution rules

1. Read `AGENTS.md` and any more specific instructions for files being edited. Stay on `main`; do not create a `codex/` branch or PR. Do not push, publish, install, or restart anything as a side effect of a cleanup task. A later explicit instruction can authorize those actions.
2. Run `git status --short` before each order. Record preexisting changes. If another owner is changing the exact file you need, choose a different ready order or coordinate that file; never overwrite, stash, reset, or revert their work. The earlier “commit everything” instruction authorized the checkpoint, not destructive cleanup.
3. Read `.repos/effect-smol/LLMS.md` and `docs/operations/effect-fn-checklist.md` before changing Effect code. Do not edit or import `.repos` source. Keep contracts schema-only and keep provider protocol adaptation at the adapter boundary.
4. Use the repository's `./node_modules/.bin/vp`. Do not run repository-wide lint, tests, typechecks, or `vp check` locally unless explicitly requested. CI owns the full suite. Baseline and rerun only the relevant package/file checks.
5. Never start a server against `~/.solla-code/userdata` or `~/.t3/userdata`, edit those databases, or symlink them into development state. If a runtime fixture needs real history, use a readonly SQLite connection and `VACUUM INTO` an isolated destination. Never copy a live SQLite database as an ordinary file copy.
6. Do not open browsers, perform computer use, or start a visual verification session without the user's explicit agreement. When authorized, follow `test-t3-app` or `test-t3-mobile`, use isolated state, and retain exact runtime evidence. Pending visual checks do not prevent source work, but they do prevent declaring that UI order fully verified.
7. Never kill a process found by name/path matching. Only stop an owned process whose PID was captured at spawn, following repository rules. Never set `VITE_HTTP_URL` or `VITE_WS_URL` for development.
8. No blanket “modernization”: do not replace Effect, convert all code to another state library, normalize every dependency to `latest`, rewrite historical migrations, collapse provider differences, or move every short duplicate into a new abstraction.

### Repeatable task loop

```text
Select the first READY order whose dependencies are complete.
Read its starting files, their callers, and named tests in full.
Recheck its evidence against the current checkout using symbols, not old line numbers.
Record the order's exact touched paths and current focused test outcome.
Make the smallest first step; preserve public interfaces and observable behavior.
Run its focused tests, changed-file lint, and affected package typechecks.
Inspect the diff for accidental API, timeout, ordering, persistence, and import changes.
Update the execution ledger with commands, counts, failures, and remaining checks.
Commit only that order's changes, then select the next ready order.
```

For a refactor with several extraction steps, each step must typecheck before the next. If a focused baseline fails, capture the error before editing. Fix failures caused by the order; report unrelated failures without relabeling them as a passing baseline. Stop a failing refactor at its last known good boundary; do not revert the initial handoff checkpoint.

## 2. What was audited, and how to interpret the evidence

The snapshot enumerates **3,385 tracked or nonignored untracked files**, including **2,907 source files and 832,104 physical source lines** after checkpoint formatting. Source lines include tests and generated code. This is a whole-repository structural inventory and pattern scan, followed by source/caller inspection of the findings below. It is **not** a line-by-line semantic proof of every file, a security certification, or a runtime acceptance test. No honest static audit can promise that an agent will encounter no unforeseen issue; this plan supplies explicit recovery and stop conditions for that reason.

Audit methods:

- Enumerated tracked and nonignored untracked files; recorded SHA-256, size, lines, area, and source/test/generated classification.
- Read root and workspace manifests, catalog/overrides/patches, build/test configuration, prior audits and historical plans.
- Scanned every inventoried source file for TODOs, deprecated interfaces, unsafe casts, suppressions, empty catches, and timers. A pattern hit is a lead, not a defect. For example, `TODO:12` in a path-parser explanation is not unfinished work.
- Screened local imports for modules with no inbound reference; checked candidate paths/symbols against callers. Dynamic imports, workers, platform entry points, generated registration, package exports, tests, and documentation must be checked before deletion.
- Screened exact normalized 15-line duplicates and inspected concrete examples. Historical migrations, generated bindings, adapter protocol code, and tiny platform facades can intentionally duplicate text.
- Compared **210 lockfile dependency declarations covering 139 unique registry packages** with fresh npm registry metadata. The evidence records declared ranges separately from resolved versions. Workspace/file dependencies are not npm upgrade candidates. Separate motion/native dependency policies have dedicated work orders.
- Read source entry points and selected lifecycle, storage, provider, desktop, mobile, marketing, protocol, terminal, telemetry, and release paths. Unproven performance opportunities are explicitly marked as measurement tasks.
- Recovered recent user instructions through the live thread-history tool. Read the September 4 and September 5 audits to avoid proposing already completed removals and reliability fixes.

### Evidence files

- [Machine-readable work-order index](codebase-cleanup-2026-09-07/work-orders.json): task dependencies and a cycle-checked serial order. Read full work orders before implementation.
- [File inventory](codebase-cleanup-2026-09-07/files.tsv): every included path, area, byte/line count, SHA-256, and classification.
- [Snapshot and pattern locations](codebase-cleanup-2026-09-07/snapshot.json): baseline commit, timestamp, per-area totals, and exact pattern-hit locations.
- [Dependency evidence](codebase-cleanup-2026-09-07/dependencies.json): lockfile declarations and registry responses, timestamped. `latest` is descriptive metadata, **not** an approved target.
- [Standalone dependency evidence](codebase-cleanup-2026-09-07/standalone-dependencies.json): motion manifest and fresh npm/Crates.io metadata for motion and Rust dependencies.
- [Read-only snapshot script](codebase-cleanup-2026-09-07/snapshot.py): run from the repository root with `python3 docs/project/codebase-cleanup-2026-09-07/snapshot.py > /tmp/solla-cleanup-current.json` to regenerate comparable evidence without changing application state. It intentionally excludes this audit's own files.
- Existing context: `docs/project/codebase-audit-2026-09-04.md`, `docs/operations/2026-09-05-reliability-audit.md`, `docs/reference/fork-identity.md`, and `docs/user/usage-and-queued-messages.md`.

The suffix-based source count excludes Markdown/JSON/YAML from source-line totals while retaining them in the inventory. Native Rust tests live inside `main.rs`, so its `test_path_files: 0` does **not** mean it has no tests. Generated classifications are heuristic; inspect file headers before using a size count to justify extraction. Vendored `.repos`, nested `.claude` worktrees, dependencies, ignored builds, and live application state are outside authored-source scope.

### Coverage by implementation area

| Area                              |           Source files |                                      Source lines | Disposition / work orders                                                                     |
| --------------------------------- | ---------------------: | ------------------------------------------------: | --------------------------------------------------------------------------------------------- |
| Web                               |                  1,037 |                                           244,625 | Dead candidates, UI composition, queue state, animation, voice, sidebars: 03, 10–16, 24, 30   |
| Server                            |                    793 |                                           296,537 | Lifecycle boundaries, SQLite, subscriptions, providers, MCP, VCS, agents: 05–09, 17–23, 26–29 |
| Mobile                            |                    467 |                                            77,853 | Dead candidates, shared derivation, feed/native boundaries, SDK: 04, 12, 24, 31–32            |
| Desktop                           |                    165 |                                            54,195 | Preview ownership, typed events, WSL/native input, Electron: 08, 22–23, 30, 33                |
| Client runtime                    |                    147 |                                            26,279 | Shared state and connection semantics: 09, 12, 24–25                                          |
| Contracts                         |                     55 |                                            21,211 | Rolling decode compatibility and safe boundaries: 06, 08, 18, 24                              |
| Shared utilities                  |                    107 |                                            15,680 | Pure cross-surface parsing and exports: 12, 18, 28                                            |
| Codex protocol package            |                     18 |                                            54,433 | Generated bulk retained; reproducible generator fix: 07, 34                                   |
| ACP protocol package              |                     19 |                                            15,229 | Generated bulk retained; provider fixtures: 21, 34                                            |
| SSH / Tailscale                   |                  9 / 3 |                                       3,371 / 991 | Ownership, quoting, origin and teardown preservation: 25, 29                                  |
| Marketing                         |                     21 |                                             3,264 | Prior cleanup retained; dependencies and distribution truth: 29, 35                           |
| Release/dev scripts               |                     41 |                                            14,018 | Broken entry, immutable inputs, bounded helper extraction: 02, 29, 36                         |
| Rust monitor                      |                      1 |                                             1,160 | Existing protocol/retention safeguards retained; module split only if justified: 27           |
| Lint plugin                       |                     11 |                                             1,058 | Existing rules plus narrow prevention checks: 37                                              |
| Motion tooling                    |                     10 |                                             1,672 | Separate lockfile/tool policy; preserve original media: 35                                    |
| Experiment                        |                      2 |                                               396 | Explicitly classify as retained experiment or archive: 38                                     |
| Config, CI, docs, assets, patches | Inventory includes all | Not counted as source except script/config source | 01–02, 31–38                                                                                  |

A domain with no confirmed defect is retained, not rewritten to make the audit look busier. Orders 25–28 include focused verification/extraction opportunities and explicitly allow a justified no-change result.

## 3. Ranked findings and desired architecture

### Confirmed actionable findings

1. `package.json` advertises `connect:announce-ga` but `scripts/announce-connect-ga.ts` does not exist. This is a broken local entry point.
2. Several modules have no observed runtime caller: web `SplashScreen`, unused UI primitives, mobile auth/git facade modules, and a mobile terminal panel. They are deletion candidates with explicit final reachability checks, not permission to remove their live dependencies.
3. The catalog retains seven unused Clerk direct-dependency entries and `@effect/sql-pg`; Clerk overrides/extensions and build configuration survive earlier product removal. Transitive compatibility and remote configuration must be checked before pruning them.
4. Deprecated wrappers remain around repository services/provider APIs. Some are test-only; one alias's comment says its integration harness is excluded while server typecheck currently includes `integration`.
5. Codex's generated `V2TurnStartParams` does not contain `collaborationMode`. `CodexSessionRuntime.ts` patches it with `Schema.fieldsAssign`; the generator needs a reproducible regression before the adapter shim can be removed.
6. Integration subscriptions use readiness sleeps (`10` and `50 millis`) and a polling helper despite existing receipt/subscription infrastructure. These obscure races and contradict the repository's receipt-based test rule.
7. Handwritten unsafe casts occur at SQLite/Electron/filesystem boundaries. These require narrow typed adapters, not blanket cast removal or a rewrite of generated schemas.
8. `ChatView.tsx` exceeds 10,000 lines; the preview manager exceeds 7,500; the command reactor exceeds 5,800. Size alone is not a bug, but inspected symbols show mixed lifecycle, UI, account, panel, send, and persistence responsibilities.
9. Source duplicates exist in web/mobile activity/query code and server/web provider-usage parsing. Share policy and decoding where behavior must stay consistent; retain thin platform wrappers where abstraction adds no benefit.
10. CSS animates background-position indefinitely for usage and ultrathink decoration. These are active consumers, not merely unused keyframes. Reduced-motion handling does not satisfy the general no-continuous-repaint rule.
11. Historical `.plans/04-split-chatview-component.md` points to `apps/renderer`, prescribes obsolete components, and suggests a broad Bun test command. It must not be handed to an implementation agent as current instructions.
12. Several resolved dependencies are behind freshly observed registry releases. The code uses Effect 4 beta while npm `latest` is Effect 3; a blanket update would be wrong. Electron 41 versus latest 44 needs explicit supported-line evaluation and native/preview tests.

### Architecture to preserve while simplifying

```text
Client interaction -> shared typed operation -> authorized server RPC
  -> command -> pure decider -> persisted event -> projection
  -> queue-backed reactor/scheduler -> provider adapter -> provider process
  -> normalized provider event -> ingestion -> projection -> bounded client stream
```

Keep this flow. Extract named policies, parsers, and components around it. Do not put durable queue ownership in component state, make projection read queries perform repair writes, let adapters mutate unrelated orchestration state, or invent a second connection supervisor.

## 4. Regression contract: never lose these behaviors

| Concern                  | Required invariant                                                                                                                                                 | Existing starting evidence                                                                                                 |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------- |
| Send / queue             | Explicit messages survive refresh/reconnect and reach the intended thread once; edits preserve attachments/settings; transient failures retain drafts              | `heldMessageQueue.test.ts`, `watchHeldMessageThread.test.ts`, `composerSendQueue.test.ts`, `ThreadWorkObligations.test.ts` |
| Stop / resume            | Explicit Stop cancels the current and already queued work; a late callback cannot restart it; a later explicit message can start normally                          | `ProviderCommandReactor.test.ts`, `ProviderRuntimeIngestion.test.ts`, obligation tests, September audits                   |
| Background-task panel    | Running work cannot be hidden with Dismiss; Stop is provider-capability aware; stale/finished rows remain dismissable; visual dismissal is not server cancellation | `ProviderTaskPanel.test.tsx`, `providerTasks.test.ts`                                                                      |
| Agent mode               | Automatic continuation works after eligible completion/restart; sign-off and deliberate cancellation remain terminal until new explicit intent                     | `agentModeContinuation.test.ts`, scheduler and reactor tests                                                               |
| Usage / failover         | Keep per-instance account identity, fresh/stale readings, credits, exact pause reason, and resume semantics; do not silently reinterpret percentages               | `ProviderUsageGuard.test.ts`, `usageGuardCredits.test.ts`, `usageGuardYield.test.ts`, `ProviderUsageBar.test.tsx`          |
| Provider identity        | Two instances of the same driver do not share sessions, caches, approval IDs, or usage                                                                             | Instance registry, provider adapter registry, service tests                                                                |
| History                  | Ordered pagination, output caps, cursor identity, indexed queries, and bounded slow-client resync stay intact                                                      | `ProjectionSnapshotQuery.test.ts`, history handler tests, bounded buffer tests                                             |
| Connections              | Local, saved LAN, tailnet, relay, SSH, reconnect, default environment and credential revocation remain distinct and usable                                         | Shared connection tests, `EnvironmentAuth.test.ts`, `ConnectionsSettings` logic tests                                      |
| Native/preview           | Tab/profile/thread identity, challenge/user-input/download gates, listener teardown and input coordinates survive extraction                                       | Preview tests, `RemoteInput.test.ts`, remote-view transform/zoom tests                                                     |
| Persistent control chats | Orchestrator and Agent Builder are never settled as ordinary work threads                                                                                          | `decider.settled.test.ts`, shared settled tests                                                                            |
| Distribution             | Independent Solla identity, upstream license attribution, compatibility identifiers, exact artifact version and healthy installed runtime                          | Fork identity, release script tests, existing September audit                                                              |

Paths abbreviated in this table are located by `rg --files | rg '<name>'`; work orders below identify their package and directory. Do not infer a guarantee for a native provider from a mock test.

## 5. Dependency decision ledger

Fresh registry responses are in `dependencies.json`; refresh them before implementing upgrades. The table is a prioritized subset of the full 139-package ledger. “Observed latest” may be outside the supported peer range and is not a vulnerability finding.

| Family            | Locked at audit           | Observed latest | Implementation decision                                                                                                                      |
| ----------------- | ------------------------- | --------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Electron          | 41.5.0                    | 44.2.0          | Order 33: choose a supported stable line after reading intermediate breaking changes; rebuild native components and run preview/IPC coverage |
| Expo              | 56.0.12                   | 57.0.20         | Order 31: upgrade the SDK cohort together, one SDK step, with custom native modules and patches                                              |
| React Native      | 0.85.3                    | 0.87.1          | Follow selected Expo compatibility, not this isolated tag                                                                                    |
| React / React DOM | Web 19.2.6; mobile 19.2.3 | 19.2.8          | Web can be a separate patch update; mobile follows Expo's dependency check                                                                   |
| Effect            | 4.0.0-beta.102            | 3.22.1          | Stay on the intentional Effect 4 family; never “upgrade” to stable v3; evaluate matching beta family and patches separately                  |
| Vite+             | 0.2.2                     | 0.3.0           | Cohort with the Vite alias, Effect tsgo integration, config, and CI; no blind CLI substitution                                               |
| Claude SDK        | 0.3.170                   | 0.3.263         | Order 34: inspect streaming, permissions, effort, process cleanup and account behavior                                                       |
| OpenCode SDK      | 1.15.13                   | 1.18.29         | Order 34: manifest range is `^1.3.15`; resolved version is the actual baseline                                                               |
| MCP SDK           | 1.29.0                    | 1.30.0          | Order 34: transport, cancellation, elicitation and session shutdown contracts                                                                |
| Playwright core   | 1.60.0                    | 1.63.0          | Pair with desktop injected-runtime and Electron testing; update separate motion dependency deliberately                                      |
| Pierre diffs      | 1.3.0-beta.10             | 1.4.1           | Web + native review integration and existing patch must pass together                                                                        |
| Astro             | 7.0.3                     | 7.3.1           | Order 35: scoped marketing typecheck/build, route and release discovery regression                                                           |

Authoritative upgrade policies: Electron supports its latest three stable release lines ([Electron release policy](https://www.electronjs.org/docs/latest/tutorial/electron-timelines)); Expo recommends incremental SDK upgrades and aligned dependencies ([Expo upgrade guide](https://docs.expo.dev/workflow/upgrading-expo-sdk-walkthrough/), [Expo CLI dependency validation](https://docs.expo.dev/more/expo-cli/)). Consult current release notes when selecting versions. The registry metadata is a point-in-time observation, not a permanent claim about support or safety.

For **every** registry dependency in the evidence, record one of: update within compatible range; intentional pin with concrete reason; coupled upgrade assigned to an order; removed after reference proof; development-only and retained. Include `tools/motion/package.json`, its independent lockfile, and Rust's `Cargo.lock` in their own lanes. Do not change React versions simply to make all manifests identical.

## 6. Execution sequence and estimates

These are planning units, not promises about elapsed time. A unit means a small focused implementation/review cycle. Never run several intrusive refactors in the same commit.

| Phase                                   | Orders       | Approximate units | Gate before proceeding                                               |
| --------------------------------------- | ------------ | ----------------: | -------------------------------------------------------------------- |
| A: preserve and remove confirmed waste  | 01–06        |              8–12 | Clean baseline and explicit candidate dispositions                   |
| B: repair proof and boundary weaknesses | 07–09, 17–18 |             12–20 | Protocol/serialization/subscription regressions pass                 |
| C: shared logic and UI composition      | 10–16, 24    |             20–35 | Same behavior through shared consumers; authorized UI check recorded |
| D: lifecycle/service extraction         | 19–23, 25–28 |             20–35 | Same command/event/receipt/order and resource ownership              |
| E: tooling and dependency cohorts       | 29–37        |             20–35 | Scoped builds/native checks per family; reproducible release inputs  |
| F: closure                              | 38           |               2–4 | Every task has evidence or an explicit retained/deferred disposition |

Dependencies are local to each order; phases are a recommended sequence rather than a requirement to block all independent work behind a long SDK upgrade. No delegation is required. A smaller agent should complete one work order per context window and write the ledger before handing off.

A valid serial order is: **01, 02, 03, 04, 05, 06, 07, 08, 09, 10, 12, 14, 15, 18, 11, 13, 16, 17, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 32, 31, 33, 34, 35, 36, 37, 38**. This resolves prerequisites that do not follow task-number order; the machine-readable index contains the same dependencies.

## 7. Detailed work orders

Each order starts in **PLANNED** state. `READY` means prerequisites have been completed and exact-path ownership is clear. `DONE` requires its checks. `RETAINED` requires the documented evidence specified in that order. `BLOCKED` requires a concrete missing external prerequisite; “hard” or “large” is not a blocker. New files mentioned below are proposed destinations, not claims that they already exist.

### 01 — Establish the implementation baseline and task ledger

**Priority:** P0 execution prerequisite. **Depends on:** nothing. **Scope:** documentation/evidence only.

**Starting evidence:** checkpoint `1b6d64185`, this document, inventory hashes, prior September audits. Historical test counts are not a current baseline. The audit host's default Node reported 25.2.1 while root `engines.node` is `^24.13.1`; use the repository-configured supported toolchain for validation rather than assuming the ambient shell is correct.

**Steps:** (1) Record `git rev-parse HEAD`, `git status --short`, Node and repo-local Vite+ versions. (2) Confirm the checkpoint is an ancestor using `git merge-base --is-ancestor 1b6d64185 HEAD`. (3) Create `docs/project/codebase-cleanup-progress.md` using section 9's template. (4) Compare hashes for the first order's files, reopen changed files, and adjust stale line references. (5) Record only relevant baseline tests as each order begins; do not launch a full suite now.

**Acceptance:** ledger identifies baseline, ownership, next order and unresolved verification. Every inherited failure is recorded without blaming the next refactor. Do not modify system-wide Node installations just to establish a local test runtime.

### 02 — Remove the broken announcement script and stale dependency configuration

**Priority:** P1; low risk for script removal, medium for lockfile changes. **Depends on:** 01.

**Files:** `package.json`, `pnpm-workspace.yaml`, `pnpm-lock.yaml`, `scripts/lib/public-config.ts`, `scripts/lib/public-config.test.ts`, `.github/workflows/release.yml`, app Vite configs.

**Evidence:** `connect:announce-ga` names a missing file. Seven Clerk catalog entries and `@effect/sql-pg` have no direct workspace manifest consumer. Old Clerk overrides/package extensions and release variables remain. This does not prove every relay/config value is unused.

**Steps:** (1) Remove only the broken announcement script; do not recreate an outbound announcement feature. Search references in docs/workflows and remove obsolete invocation instructions. (2) Inspect all lockfile importers and package manifests, including optional/peer dependencies. Use `pnpm why <package>` for each candidate where a transitive use exists. (3) Remove unused catalog entries and corresponding inert exceptions/overrides only when their consumers are absent. Retain a live transitive override with a written reason. (4) Trace Clerk config from `public-config.ts` into build defines and runtime reads; remove only disconnected branches. (5) Regenerate the lockfile with the repository's pinned package manager, review that the diff is limited to intended removals, and do not upgrade unrelated resolutions.

**Checks:** root script file-existence check; `scripts/lib/public-config.test.ts`; impacted Vite-config tests; scripts typecheck if source changes. **Done:** no manifest entry names a nonexistent local script; every removed override has reachability evidence; relay configuration that remains supported still works by its existing tests.

### 03 — Delete confirmed-unused web components, one leaf at a time

**Priority:** P1. **Depends on:** 01. **Files:** `apps/web/src/components/SplashScreen.tsx`, `apps/web/src/components/ui/card.tsx`, `apps/web/src/components/ui/field.tsx`, `apps/web/src/components/ui/form.tsx`.

**Evidence:** local import screening found no inbound caller; direct symbol/path searches showed the splash component only in its own file. These are candidates pending the final complete check.

**Steps:** (1) List each file's exports. Search each symbol and file import path across inventoried files, including `.plans`, scripts, tests, public templates, package exports, aliases, lazy imports and generated routes. (2) If a live consumer exists, mark that file RETAINED and record the caller. (3) Delete only confirmed-unused files. (4) Check whether a test becomes orphaned solely because it tested a removed private module; remove that test only after confirming it is not shared behavior coverage. (5) Do not remove `@base-ui/react` or shared styling utilities because these particular wrappers were unused; both have other consumers.

**Checks:** web typecheck and changed-file lint; no implementation-mirroring “file does not exist” test. **Done:** zero unresolved imports and a deletion ledger with final reference results. Keep the actual mobile Expo splash handling; it is unrelated.

### 04 — Remove unused mobile facades and decide the old terminal panel

**Priority:** P1. **Depends on:** 01. **Files:** `apps/mobile/src/state/auth.ts`, `apps/mobile/src/state/git.ts`, `apps/mobile/src/features/terminal/ThreadTerminalPanel.tsx`; inspect `NativeTerminalSurface.tsx`, `threadTerminalPanelModel.ts`, and active thread terminal screens in the same feature tree.

**Evidence:** the auth/git files instantiate shared atoms but have no observed importer. `ThreadTerminalPanel` has no observed caller even though its native terminal and subscription helpers have other potential consumers.

**Steps:** (1) Trace `App.tsx`, `Stack.tsx`, navigation routes, direct imports, native/platform file resolution and `require` calls. (2) Remove unused auth/git wrappers only; retain corresponding shared runtime exports used by web. (3) Locate the active mobile terminal entry and compare its close, reopen, attach identity and visibility behavior to the old panel. (4) If the old panel is unreachable, delete it without deleting shared terminal models/native views. If the active entry depends on it indirectly, retain it and record that route. (5) Classify any newly orphaned descendants with the same checks, one by one.

**Checks:** mobile typecheck; `threadTerminalPanelModel.test.ts`, native-terminal-module and terminal-replay tests if their dependencies change. **Done:** active terminal functionality preserved, deleted facade atoms were not relied on for initialization side effects. Actual terminal interaction remains a separate authorized mobile check.

### 05 — Remove deprecated internal aliases and kind-only registry methods

**Priority:** P2. **Depends on:** 01; coordinate with 09 and 21.

**Files:** `apps/server/src/config.ts`, `serverSettings.ts`, `textGeneration/TextGeneration.ts`, `provider/Services/ProviderAdapterRegistry.ts`, `provider/Layers/ProviderAdapterRegistry.ts`, `provider/testUtils/providerAdapterRegistryMock.ts`, `provider/providerStatusCache.ts`, `persistence/Layers/ProviderSessionRuntime.ts`, `integration/OrchestrationEngineHarness.integration.ts`.

**Evidence:** deprecated static `layerTest` wrappers, `TextGenerationShape`, `resolveLegacyProviderStatusCachePath`, `listProviders`, and the persistence compatibility alias survive. The alias's “excluded harness” comment disagrees with `apps/server/tsconfig.json` including `integration`.

**Steps:** (1) For each exported alias, search all imports/calls; migrate callers to module `layerTest`, `TextGeneration["Service"]`, or the canonical repository module. (2) Remove the alias only after zero callers remain. (3) Replace `listProviders` test fixtures with `listInstances` only after asserting two same-driver instances stay distinguishable; do not map IDs to driver kinds and lose identity. (4) Remove unused legacy cache path generation, but retain on-disk legacy cache reading/migration if still used. (5) Correct the stale harness comment even if a wrapper must remain.

**Checks:** adapter-registry tests, provider-status-cache tests, touched fixture consumers, server typecheck. **Done:** no unnecessary private aliases and no removal of persisted compatibility. Do not “clean” public wire fields in this order.

### 06 — Document persisted compatibility and remove only dead writes

**Priority:** P1 protection prerequisite. **Depends on:** 01.

**Files:** `packages/contracts/src/settings.ts`, `packages/contracts/src/orchestration.ts`, `apps/server/src/serverSettings.ts`, persistence migrations and decoder tests.

**Evidence:** settings contains a deprecated ratio-learning field explicitly retained so old persisted settings decode. Old migration schemas intentionally overlap current projection logic. These are not dead code merely because current UI never writes them.

**Steps:** (1) Inventory deprecated persisted fields with decoder, default, current writer and migration consumers. (2) Mark each “read compatibility only,” “still written,” or “unused internal.” (3) Remove obsolete runtime branches/writes only when already superseded by current behavior; retain old-value decoding and add a fixture for an old settings payload. (4) If future removal needs a migration, design an additive migration with next available ID and tests; never edit previously shipped migration behavior. (5) Record compatibility requirements in the architecture guide and progress ledger.

**Checks:** `packages/contracts/src/settings.test.ts`, server settings tests, relevant migration tests. **Done:** current saves use the intended shape and old settings continue loading. A removal that cannot meet both is RETAINED with explanation, not silently forced through.

### 07 — Make the Codex collaboration-mode schema workaround reproducible

**Priority:** P1. **Depends on:** 01, 06. **Files:** `packages/effect-codex-app-server/scripts/generate.ts`, `src/_generated/schema.gen.ts`, `src/_generated/meta.gen.ts`, `src/protocolDrift.test.ts`, `apps/server/src/provider/Layers/CodexSessionRuntime.ts` and its tests.

**Evidence:** generator pins upstream ref `3b3b4f8fb3f6403e72c2d0533ed0d2f309c59717`. Generated turn-start parameters omit `collaborationMode`, while the adapter constructs `CodexTurnStartParamsWithCollaborationMode` using `Schema.fieldsAssign`. The TODO is active.

**Steps:** (1) Capture a minimal fixture from the pinned upstream turn-start schema and the required collaboration-mode shape. (2) Add a generator regression proving whether omission comes from upstream JSON or conversion. (3) If upstream omits the field, implement a named, tested compatibility augmentation in the generator, with its upstream reference and retirement condition; do not pretend it is a generator parsing bug. (4) Regenerate using the same pinned ref and review the exact diff. (5) Remove the runtime extension only when generated encode/decode retains the field. Preserve optionality and plan/default values. Do not upgrade the upstream pin in the same change.

**Checks:** protocol drift/protocol tests, Codex session-runtime tests, protocol package and server typechecks. **Done:** two identical generations produce identical bytes; plan/default payloads survive encoding; no manually edited generated file.

### 08 — Replace boundary casts with explicit narrow types

**Priority:** P2. **Depends on:** 01, 06; separate commits by boundary.

**Files:** `apps/server/src/persistence/NodeSqliteClient.ts`, `packages/contracts/src/filesystem.ts`, `apps/desktop/src/electron/ElectronApp.ts`, `ElectronPowerMonitor.ts`, `apps/desktop/src/wsl/DesktopWslEnvironment.ts`.

**Evidence:** `as any` bypasses SQLite parameters/results and filesystem error construction; Electron listener registration accepts arbitrary string/argument pairs and casts them to any; WSL repeats `exitCode as unknown as number`.

**Steps:** (1) Read the installed dependency types and actual call sites. (2) Build one checked conversion at the SQLite parameter boundary, preserving null, string, number, bigint and byte-buffer semantics; unsupported values must produce a typed error. Preserve the raw-write return contract and array-row mode reset on failure. (3) Type filesystem legacy decoding independently from the richer new constructor; test message-only old payloads. (4) Add an event-name/argument map for Electron events actually consumed, preserving exact listener identity for removal. (5) Normalize WSL exit codes once using the process library's true type. Where an upstream overload forces a cast, confine and explain it instead of expanding the API to `any`.

**Checks:** SQLite client tests and repository error-correlation tests; filesystem contract tests; desktop lifecycle/WSL tests; each affected package typecheck. **Done:** casts removed or narrowly justified, with identical accepted inputs and cleanup semantics. Generated route/protocol casts are out of scope.

### 09 — Replace integration readiness sleeps with explicit subscription readiness

**Priority:** P1. **Depends on:** 01. **Files:** `apps/server/integration/OrchestrationEngineHarness.integration.ts`, `orchestrationEngine.integration.test.ts`, `providerService.integration.test.ts`; `apps/server/src/orchestration/Layers/RuntimeReceiptBus.ts` and service interface.

**Evidence:** harness forks receipt collection then sleeps 10 ms; provider integration forks event collection then sleeps 50 ms; `waitForSync` polls every 10 ms. A sleep cannot prove subscription readiness on a loaded host.

**Steps:** (1) Acquire the receipt/event subscription synchronously in the same scoped fiber before dispatching the action. Reuse existing subscription APIs; add a minimal readiness/deferred seam only if none exists. (2) Fork the consumer from that acquired subscription. (3) Replace polling for an orchestration transition with the exact typed receipt or worker drain matching command/thread/turn identity; then read the projection once. (4) Use a virtual clock only when the behavior under test is an actual timer, such as retry backoff. (5) Keep a bounded failure timeout for diagnostics; it must not be the synchronization mechanism.

**Checks:** the two integration test files using the server package configuration, plus receipt-bus tests if changed. **Done:** an event emitted immediately after registration is observed without sleep; scope disposal releases subscriptions; assertions do not depend on unrelated thread receipts.

### 10 — Extract ChatView's terminal and side-panel composition first

**Priority:** P2; high regression risk. **Depends on:** 01, regression baseline for ChatView.

**Files:** `apps/web/src/components/ChatView.tsx`, `ChatView.logic.ts`, `ThreadTerminalDrawer.tsx`, components under `chat/` and `preview/`.

**Evidence:** `PersistentThreadTerminalDrawer`, `PersistentThreadTerminalPanel`, terminal creation/splitting, side-chat/archive actions, artifact routing and panel selection live inside the same 10,000+ line module as sending and provider authentication.

**Steps:** (1) Move the two `PersistentThreadTerminal*` components, their private props and exclusive imports to a proposed `components/chat/ChatTerminalSurfaces.tsx`; pass existing dependencies explicitly, preserving memo boundaries. (2) Typecheck before changing logic. (3) Extract panel action preparation into a proposed `useChatPanelActions.ts`, grouping dependencies by terminal/preview/side-chat responsibility; avoid passing the entire ChatView state bag. (4) Retain route synchronization, empty-panel behavior, archive confirmation, terminal focus and rollback on failed open. (5) Reuse existing `ChatHeader`, `ChatComposer`, timeline and queue components; do not create duplicate replacements from historical plans.

**Checks:** ChatView logic tests, terminal layout/focus tests, side-panel tests discovered by caller search; web typecheck/lint. Authorized integrated check: open/close/split/reopen terminal, empty panel, last browser tab close, side-chat archive, artifact back navigation on narrow and wide layouts. **Done:** extracted files have one responsibility and ChatView uses them without introducing new durable state or changed remount keys.

### 11 — Extract ChatView's send/account controllers without changing queue ownership

**Priority:** P1 maintainability around recent defects. **Depends on:** 09, 10, 18.

**Files:** `ChatView.tsx`, `ChatView.logic.ts`, `chat/heldMessageQueue.ts`, `chat/watchHeldMessageThread.ts`, `chat/providerAuthPause.ts`, `chat/providerFailoverNotice.ts`, `chat/usageGuardPause.ts`, shared `heldMessages` and client-runtime command operations.

**Steps:** (1) Separate account authentication callbacks (`beginProviderAccountSwitch`, cancel, code submission, auth-link opening) into a controller with explicit environment/thread/instance inputs. (2) Extract held-message observation and promotion into a controller using the existing durable server state and current helpers. (3) Preserve draft/attachment ownership and request identity across a route or provider switch. (4) Move send preparation separately from the effect that submits it. (5) Ensure Stop, queued-message promotion, automatic continuation and authentication resumption all call the same current operations; do not infer backend availability from a hidden panel row. (6) Replace imports in ChatView only after each extraction passes its tests.

**Checks:** held queue/watch/auth/failover/pause/composer-send tests, ChatView logic tests; client runtime tests only if operations change. Test interruption during pending send, two rapid sends, provider switch with pending auth, retry after failure, and attachment-only message. **Done:** one owner for durable queue mutation, no dropped drafts, no duplicate send after remount. UI acceptance requires an explicitly authorized real-client pass.

### 12 — Share activity and usage derivation where semantics must match

**Priority:** P1. **Depends on:** 01, 06; usage portion before 11 and 18 final integration.

**Files:** `apps/mobile/src/lib/threadActivity.ts`, `apps/web/src/session-logic.ts`, `packages/client-runtime/src/state/threadActivity.ts`, `apps/server/src/orchestration/ActivityPayloadProjection.ts`, `apps/server/src/orchestration/ProviderUsageGuard.ts`, `apps/web/src/components/chat/ProviderUsageBar.tsx`, `packages/shared/src/`.

**Evidence:** exact duplicate blocks occur across these activity paths; usage guard and usage bar separately parse records, finite numbers, percentages and timestamps. Similar text alone does not prove identical policy.

**Steps:** (1) Make a behavior table from existing fixtures before moving code. Distinguish raw payload decoding, lifecycle classification and presentation labels. (2) Move identical pure payload decoding to a named shared subpath; keep UI labels, React and server effects outside it. (3) Move shared client status derivation to client-runtime and preserve platform-specific presentation. (4) For usage data, share only the normalized raw-window representation and safe conversion; retain explicitly different UI/guard window selection until a test proves they should match. (5) Migrate one consumer, run tests, then migrate the others. Do not import a web module from the server.

**Checks:** activity projection, web session logic, mobile activity and shared state tests; guard and usage-bar fixture tests. **Done:** identical input yields the intended cross-surface decision; differences are named and tested; export maps use explicit subpaths and no root barrel.

### 13 — Split composer settings, draft attachments and suggestion menus

**Priority:** P2. **Depends on:** 10–12.

**Files:** `apps/web/src/components/chat/ChatComposer.tsx`, `ComposerPromptEditor.tsx`, `composerDraftStore.ts`, composer hooks/models in the same directories.

**Evidence:** a 4,000+ line composer mixes settings changes, traits, prompt replacement, image and terminal-context attachments, suggestions, keyboard handling and stash operations. The draft store is also large and persisted.

**Steps:** (1) Move existing `ComposerFooterModeControls` and `ComposerFooterPrimaryActions` into focused presentational files with unchanged props. (2) Extract suggestion/menu state separately from draft serialization. (3) Extract stash operations around current draft APIs; do not create another draft cache. (4) Leave Lexical selection ownership in the editor until its focus/IME requirements are covered. (5) Preserve blob URL handoff/revocation, attachment order, multiline/IME send rules, restore/delete stash and retryable draft persistence. Do not migrate the stored draft schema in this extraction.

**Checks:** existing composer/editor/draft-store/stash tests selected by changed symbols; web typecheck. Authorized UI check includes paste image, IME composition, keyboard send, command-menu escape, stash/restore, attachment failure and mobile-width keyboard collapse. **Done:** no new cross-component mutation of editor internals and no draft loss on remount.

### 14 — Consolidate sidebar behavior while retaining both active layouts

**Priority:** P2. **Depends on:** 12.

**Files:** `apps/web/src/components/Sidebar.tsx`, `SidebarV2.tsx`, `Sidebar.logic.ts`, `AppSidebarLayout.tsx`, `CommandPalette.logic.ts`, sidebar grouping helpers; mobile `HomeScreen.tsx`, `ThreadNavigationSidebar.tsx`, `threadListV2.ts`.

**Evidence:** both web sidebars exceed 3,000 lines. `AppSidebarLayout.tsx` actively chooses v1 for Settings and v2 based on settings elsewhere. Neither is dead. Duplicate grouping/action blocks also exist on mobile.

**Steps:** (1) List actions and eligibility rules in both layouts and command palette. (2) Move common pure grouping/ordering/eligibility into existing shared helpers or client-runtime where mobile also consumes it. (3) Share action preparation at the operation boundary, preserving each layout's rendering and focus behavior. (4) Retain saved setting semantics and existing persistent-control-chat exemptions. (5) Do not delete v1, remove a setting, or redesign navigation in this order.

**Checks:** Sidebar logic tests, branding/default-setting tests, command-palette logic tests, mobile grouping tests. Authorized UI acceptance: Settings navigation, hidden/archived/snoozed/settled reversal, multi-environment grouping and keyboard thread selection. **Done:** action eligibility is consistent across entry points and both layouts remain reachable as before.

### 15 — Remove continuous decorative repaint without changing status meaning

**Priority:** P1 performance-rule violation. **Depends on:** 01.

**Files:** `apps/web/src/index.css`, `components/chat/ProviderUsageBar.tsx`, `composerProviderState.tsx`, `MessagesTimeline.tsx` and corresponding tests.

**Evidence:** `.provider-usage-elapsed-dots` animates `background-position` every 900 ms indefinitely and sets `will-change`; ultrathink frame/pill/word backgrounds run indefinite rainbow animation. Consumers were found in usage/composer/timeline. The equalizer's transform animation is also continuous, but GPU/frame cost has not been measured in this audit.

**Steps:** (1) Make usage elapsed dots and ultrathink decoration static while retaining their visual distinction and accessibility text. Remove obsolete `will-change` and unused keyframes only after searching consumers. (2) Make working status decoration static or a short state-entry transition; do not remove the actual working label, elapsed-time information or reachable/unreachable distinction. (3) Preserve reduced-motion behavior and error/status affordances. (4) Avoid replacing CSS loops with JavaScript animation timers.

**Checks:** usage-bar/composer-provider/timeline tests, changed-file lint. No implementation-mirroring CSS string-count test. Authorized visual/performance check: resting chat, running chat, many sidebar rows, reduced motion and high-refresh display; compare animation/paint activity under the same scenario. **Done:** no indefinite decorative repaint, meaningful state remains legible. Source change alone does not prove a measured CPU/GPU reduction.

### 16 — Extract timeline row rendering from scroll and history coordination

**Priority:** P2. **Depends on:** 10–13.

**Files:** `apps/web/src/components/chat/MessagesTimeline.tsx`, `MessagesTimeline.logic.ts`, ChatView scroll callbacks, mobile `features/threads/ThreadFeed.tsx` for cross-check only.

**Steps:** (1) Identify stable row types: message, activity, checkpoint, working status, approval and queued UI. Move rendering into small memoized rows without changing item keys. (2) Keep list measurement, anchor restoration and follow-at-end decisions together in one controller. (3) Preserve older-history prepend behavior, folded tool blocks, streamed markdown growth, image expansion and user scrolling away from the bottom. (4) Avoid per-row full-thread selectors or fresh allocation of every item on each token. (5) Remove old helpers only after all callers migrate.

**Checks:** timeline logic/render tests and scroll/anchor tests; web typecheck. Authorized runtime fixtures: short thread, long thread, mixed tools/images, rapid token stream, prepend older messages while scrolled away from bottom. Record render/commit measurements if optimizing, not just file length. **Done:** no anchor jump or forced follow when user navigates; new modules have stable typed inputs and reduced coupling.

### 17 — Split the provider command reactor by command family

**Priority:** P1 architecture. **Depends on:** 06, 09, 18; do after current lifecycle regressions are baselined.

**Files:** `apps/server/src/orchestration/Layers/ProviderCommandReactor.ts`, `Services/ProviderCommandReactor.ts`, reactor tests, `providerSessionWrites.ts`, scheduler and obligation interfaces.

**Evidence:** one Effect service handles start/recovery, direct steering, approvals, user input, auth, worktrees, usage guard and failover across more than 6,000 lines. Several recent fixes are in this file.

**Steps:** (1) Make a command-family map with each handler's service dependencies and emitted receipts. (2) Extract pure classification functions first, preserving named exports used by tests. (3) Extract approval/user-input handling into a proposed `orchestration/commandHandlers/requests.ts`, with explicit services and no new process-global state. (4) Extract start/recovery and then queued delivery in separate commits. Keep scheduling/registration in the existing service. (5) Preserve per-thread serialization, cancellation masks, idempotency keys, receipt order, authentication pause and same-instance checks. Reuse `providerSessionWrites` rather than reintroducing blind runtime-session writes.

**Checks:** focused reactor tests by affected family, obligations tests, session-write tests; server typecheck/lint. **Done:** same input sequence yields the same commands/events/receipts and durable states; Stop followed by late completion cannot restart a thread. Do not combine extraction with scheduling-policy changes.

### 18 — Formalize queue, stop and usage-guard decisions as named pure policies

**Priority:** P1. **Depends on:** 06, 09, 12 for shared decoding; before 11/17 complete.

**Files:** `apps/server/src/orchestration/Layers/ThreadWorkScheduler.ts`, `ProviderCommandReactor.ts`, `ProviderRuntimeIngestion.ts`, `decider.ts`, `ProviderUsageGuard.ts`, `usageGuardYield.ts`, `usageGuardCredits.ts`, `apps/server/src/persistence/Layers/ThreadWorkObligations.ts`.

**Steps:** (1) Write a transition table for explicit user delivery, held message, synthetic resume, usage pause, auth pause, Stop, sign-off, provider exit and retry. Include obligation state and whether restart is allowed. (2) Locate duplicated decision branches and extract only equivalent predicates into named pure policies next to orchestration. (3) Keep database claims, leases and compare-and-set writes in persistence; keep time and provider calls injected. (4) Preserve explicit delivery's admission behavior under background saturation and cancellation against late live-steer acknowledgment. (5) Add only missing order-sensitive regressions; retain existing ones unchanged through extraction.

**Checks:** scheduler, obligation, decider-settled, guard/yield/credits and targeted ingestion/reactor tests. Include two instances of one driver, restart while paused, Stop during retry and late callback after cancellation. **Done:** one clearly named policy decides each transition; no test relies on sleep; UI dismissal never changes durable work state. Do not change 30-minute stale-task semantics merely to simplify UI logic.

### 19 — Separate projection query shapes from lifecycle updates

**Priority:** P1 maintainability/performance protection. **Depends on:** 06, 09, 18.

**Files:** `apps/server/src/orchestration/Layers/ProjectionPipeline.ts`, `ProjectionSnapshotQuery.ts`, corresponding tests, persistence projection repositories and `Migrations/074*` / `075*`.

**Evidence:** projection pipeline is roughly 4,000 lines and snapshot query roughly 3,500. Duplicate row-decoding/query fragments occur in snapshot and repository modules. September's audit documented a real historical-payload scan regression and explicit query-plan fixes.

**Steps:** (1) Group snapshot operations into shell/list summary, paginated thread detail, and completion/receipt existence. (2) Extract row schemas/mappers shared by current queries into an internal read-model module; do not reuse migration-local schemas. (3) Keep SQL close to its operation and preserve selective columns, indexes, ordering, limits and transaction boundaries. (4) Split pipeline handlers by event family while preserving transactional updates and event ordering. (5) Do not replace separate indexed existence queries with a convenient full snapshot read or JSON payload scan.

**Checks:** projection pipeline/snapshot tests, related repository tests, query-plan regressions. On a disposable representative history fixture, compare results and `EXPLAIN QUERY PLAN` before/after; record fixture shape and measured query times. **Done:** same replay-derived state and pagination, no added writes on read paths, no historical large-payload decoding in existence checks.

### 20 — Separate normalized provider-event ingestion from lifecycle effects

**Priority:** P1. **Depends on:** 17–19.

**Files:** `apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.ts`, its tests, `ActivityPayloadProjection.ts`, provider event contracts, provider service.

**Steps:** (1) Identify raw-to-orchestration event translation, terminal-status decisions, usage/activity handling and follow-up scheduling. (2) Move pure normalization into dedicated modules; leave subscription ownership and Effect services in ingestion. (3) Preserve event identity and deduplication, active-turn matching, interrupted/failed/completed distinctions, and thread-instance routing. (4) Prevent late session lifecycle events from reopening deliberate Stop. (5) Keep output and attachment handling consistent with the completion query and checkpoint receipt logic.

**Checks:** ingestion, activity projection, lifecycle and targeted adapter tests. Use sequences with duplicated event, unknown item, out-of-order terminal event, attachment-only output and late output after Stop. **Done:** input events produce equivalent persisted events; subscription is acquired once and torn down with the service. Do not add a second durable event channel for cleanup convenience.

### 21 — Extract provider-specific parsers and build an adapter capability matrix

**Priority:** P2. **Depends on:** 05, 07, 20; parser-only portions may start earlier.

**Files:** `apps/server/src/provider/Layers/ClaudeAdapter.ts`, `CodexAdapter.ts`, `GrokAdapter.ts`, `OpenCodeAdapter.ts`, Cursor and Antigravity adapters found under `provider/Layers`, `Drivers/`, provider registry/service tests.

**Evidence:** Claude adapter exceeds 5,000 lines; Grok exceeds 2,500. Large adapters own process lifecycle, protocol parsing, permission/auth mapping, effort and native session continuity. Some parsers use unknown-record casts to accommodate SDK drift.

**Steps:** (1) Record per-driver support for resume, interrupt, background-task stop, live steering, approvals, elicitation, usage, images and context limits; use registered drivers, not the shorter AGENTS glossary as the full list. (2) Extract pure provider-native parsers next to each adapter, with saved minimal fixtures for supported protocol shapes. (3) Keep one scoped lifecycle owner per provider process/session. (4) Share a helper only when its semantics and teardown contract match; do not force Claude, Codex, Grok and ACP into one generic protocol. (5) Preserve multi-instance separation and unsupported-capability responses.

**Checks:** each changed adapter's focused tests and service/registry tests. Native CLI two-turn/resume/interrupt checks require available credentials and explicit runtime scope; mocks do not prove those. **Done:** matrix covers all registered drivers and every extraction preserves that driver's advertised behavior.

### 22 — Split desktop preview operations without losing tab/profile ownership

**Priority:** P2; high runtime risk. **Depends on:** 08, 21 only if provider interaction changes.

**Files:** `apps/desktop/src/preview/Manager.ts`, `BrowserSession.ts`, `ActivityLeases.ts`, `userInputSurfaces.ts`, `downloadApproval.ts`, `browserProfileScope.ts`, `CloudflareChallenge.ts`, `PlaywrightInjectedRuntime.ts`, manager tests.

**Evidence:** Manager is 7,559 lines with selector/evaluation schemas, native operations, typed-text verification, input deferral, picture-in-picture, screenshots, tab lifecycle and automation methods. Many helper modules already exist; extend them before inventing new parallel managers.

**Steps:** (1) Extract stateless screenshot/error/geometry helpers into appropriate existing modules. (2) Group selector lookup/evaluation as a scoped automation helper taking the current owned tab, not a global browser. (3) Keep browser session/tab registry and destruction finalizers under one owner. (4) Preserve human-verification stop, same profile/cookies/tab, user input deferral and download approval. (5) Migrate operations in small families and retain resource cleanup when webContents is destroyed mid-call.

**Checks:** preview manager, session, deferral, challenge, download, profile-scope and injected-runtime tests relevant to each move; desktop typecheck. Authorized client acceptance includes new/close/reopen tab, hidden automation, destroyed-tab callback and staged human-verification state. **Done:** no tab is repurposed or duplicated by extraction; gate behavior and listener/session lifetime are unchanged.

### 23 — Split terminal policy and buffering from process ownership

**Priority:** P2. **Depends on:** 08–09.

**Files:** `apps/server/src/terminal/Manager.ts`, terminal tests/helpers, `apps/web/src/components/ThreadTerminalDrawer.tsx`, native terminal bridge for compatibility review.

**Evidence:** server manager exceeds 4,200 lines. It contains geometry owner arbitration, byte-bounded output, shell candidate resolution, process inspection, attach snapshots and lifecycle operations.

**Steps:** (1) Extract pure shell candidate resolution and platform path rules into a terminal-local module. (2) Extract buffer trimming/event compaction with explicit byte counts and sequence inputs. (3) Extract geometry-owner decisions without changing staleness thresholds or ownership identity. (4) Keep PTY spawning, subscription finalizers, process handles and close/reopen state in the manager until independently covered. (5) Preserve UTF-8 tail boundaries, slow-client output caps, snapshot replay and process-exit metadata. Do not share shell quoting across incompatible Windows/POSIX interpreters.

**Checks:** terminal manager/buffering/shell/geometry tests, targeted drawer model tests if signatures move. Authorized runtime acceptance uses only owned terminals and includes split resize, output flood, detach/reopen, exit and retry. **Done:** equivalent byte/sequence behavior and no orphan PTY or hidden subprocess.

### 24 — Reduce web/mobile drift at the client-runtime boundary

**Priority:** P2. **Depends on:** 12, 14, 16.

**Files:** both clients' `src/state/query.ts`, `use-atom-command.ts`, `use-atom-query-runner.ts`, state query/threads files, background activity reporters, archived-thread helpers; `packages/client-runtime/src/state/` and explicit package exports.

**Evidence:** `use-atom-command.ts` is identical in both clients; `query.ts` differs mainly in atom label. Archive/background/activity blocks also duplicate behavior. Tiny wrappers are inexpensive and may be intentionally platform-local.

**Steps:** (1) Classify each duplicate as pure policy, registry/session behavior, React hook, or thin platform facade. (2) Move only shared policy and substantial state machinery into existing client-runtime subpaths. (3) Retain small hooks unless a concrete drift/bug demonstrates benefit from sharing; record the reason instead of adding React peers and a new abstraction solely to remove 20 lines. (4) Preserve atom registry identity, per-environment isolation, disabled-query pending state, error reporting and subscription reference counts. (5) Ensure no DOM/React Native import enters a platform-neutral module.

**Checks:** runtime state/connection tests and affected web/mobile tests; all three package typechecks when shared exports change. **Done:** behavioral duplicates have one owner or a documented platform reason. No new root barrel or unnecessary package-level dependency.

### 25 — Review connection, relay, SSH and Tailscale lifecycle boundaries

**Priority:** P2; verify before refactoring. **Depends on:** 01, 24 where state APIs move.

**Files:** `packages/client-runtime/src/connection/supervisor.ts`, `signalMailbox.ts`, `registry.ts`, connection storage adapters, `packages/ssh/src/tunnel.ts`, `command.ts`, `packages/tailscale/src/tailscale.ts`, web connection settings.

**Evidence:** shared supervisor already has retry generations, interruption handling, backoff and wakeup coordination. SSH tunnel owns scopes and separate external/managed remote-server modes. These existing designs must not be replaced merely because the files are long.

**Steps:** (1) Trace one local, remote/relay, SSH and tailnet connection through acquire/retry/release. (2) Record ownership of transport, credentials, server process and cached session. (3) Extract only repeated pure target/origin/quoting decisions, preferably into existing modules. (4) Retain separate policies for user-disabled connection, transient offline state and rejected credentials. (5) Verify generation changes discard stale attempts and teardown does not stop an externally managed server.

**Checks:** supervisor/mailbox/registry/health tests, SSH tunnel/command/config tests, Tailscale tests. **Done or RETAINED:** no duplicate lifecycle owner; current boundaries either demonstrably simplify or are explicitly retained with the tests that protect them. Do not change firewall, tailnet account settings or saved production credentials during this order.

### 26 — Bound and isolate MCP history/query mechanics

**Priority:** P2. **Depends on:** 09, 19.

**Files:** `apps/server/src/mcp/toolkits/history/ThreadHistoryQuery.ts`, history handlers/types/tests, `McpInvocationContext.ts`, `owningThread.ts`, `PreviewAutomationBroker.ts`, `toolkits/actionApproval/ActionApprovalBroker.ts`.

**Evidence:** history query already has bounded page/text/payload/scan defaults and a worker timeout for regex. Its worker-source string, query normalization, SQL/cursor logic and response construction share one module. MCP ownership and approval are distinct broker boundaries, not disposable glue.

**Steps:** (1) Extract pure cursor fingerprint/validation and request normalization, preserving filter identity and stable pagination ties. (2) Isolate regex worker transport and termination in a dedicated helper with bounded batch input. (3) Keep SQL shaping near history projection queries and avoid full payload retrieval when `includePayload` is false. (4) Confirm thread credential checks happen before data access; preserve separate action-approval and preview gates. (5) Review other toolkits for duplicate schema/handler definitions, changing only a demonstrated mismatch.

**Checks:** history handler, invocation-context, approval/preview broker tests; pathological regex timeout and invalid cursor cases. **Done:** bounded response and scan behavior is unchanged, workers terminate, foreign-thread queries remain rejected, and no tool mutation is triggered by a read-only history query.

### 27 — Keep telemetry bounded and extract only a useful native boundary

**Priority:** P3. **Depends on:** 01, 08 if native bridge typing changes.

**Files:** `native/resource-monitor/src/main.rs`, `Cargo.toml`, `Cargo.lock`, `apps/server/src/resourceTelemetry/NativeTelemetryClient.ts`, `ResourceTelemetryHistory.ts`, `Model.ts`, contract telemetry schemas.

**Evidence:** native monitor already has protocol version 2, input queue capacity 64, entry/byte retention caps, chunked history and PID birth identity; `main.rs` includes tests. Server history retains bounded window normalization and process aggregation. No unbounded-memory defect was established by this audit.

**Steps:** (1) Document those limits and cross-language units from current types. (2) If splitting improves review, move protocol structs/enums to a proposed `protocol.rs`, history retention to `history.rs`, keeping sampling and process ownership in the executable. (3) Preserve serialization casing, version checks, PID/start-time identity, memory accounting and history chunk order. (4) Assess Rust dependency updates within compatible ranges separately from file moves. (5) If the current file remains clearer, mark the split RETAINED with reasoning and retain the compatibility checklist.

**Checks:** `cargo test --locked --manifest-path native/resource-monitor/Cargo.toml`, scoped formatting, server native-telemetry/model/history tests. **Done:** protocol fixtures match both languages and bounds are unchanged; source tests do not constitute native Windows/macOS sampling proof.

### 28 — Review VCS, source-control and agent scheduling for real duplication

**Priority:** P2. **Depends on:** 09, 18.

**Files:** `apps/server/src/vcs/GitVcsDriverCore.ts`, `project/RepositoryIdentityResolver.ts`, `sourceControl/SourceControlProviderRegistry.ts`, `SourceControlRepositoryService.ts`, provider-specific CLI/API modules, `vm/VmAgentTaskScheduler.ts`, `VmAgentCollaboration.ts`, checkpointing modules.

**Evidence:** repository-identity resolution duplicates a block in the Git driver; multiple source-control implementations intentionally vary protocol. Agent scheduling has bounded run retries, deadline and delegated-thread provenance. These are distinct policies and must not be merged with thread scheduling by naming similarity.

**Steps:** (1) Extract identical pure Git remote/repository identity parsing into an existing shared VCS helper after comparing Windows and SSH-URL fixtures. (2) Retain provider-specific error/permission semantics for GitHub, GitLab, Azure DevOps and Bitbucket. (3) Inspect agent scheduler reuse of current durable obligations, receipts and cancellation; remove only redundant bookkeeping with a reproducing test. (4) Preserve delegated thread provenance, worktree isolation, checkpoint refs and reverse operations. (5) Record no-change decisions for already well-separated modules.

**Checks:** repository identity, VCS driver, affected source-control provider/registry, agent scheduler/collaboration, checkpoint tests as appropriate. **Done:** no remote mutation or real PR/repository creation during fixtures; no lost branch/worktree, cancellation or delegation identity.

### 29 — Make standalone distribution identity explicit without inventing a package

**Priority:** P1 product correctness. **Depends on:** 02, 25. Coordinate the release-input policy with 36; it is not a blocking dependency.

**Files:** `apps/server/src/service/pinnedRuntime.ts`, `selfUpdate.ts`, `bootService.ts`, `packages/ssh/src/tunnel.ts`, server update UI/operations, `docs/architecture/server-updates.md`, `docs/reference/fork-identity.md`.

**Evidence:** inherited pinned-runtime installation and self-update explicitly install `t3@<version>`. The earlier audit documents that as upstream, not an owned Solla npm distribution. Internal package and executable names are compatibility identifiers; changing them globally would break more than branding.

**Steps:** (1) Trace every standalone install/update entry, including remote SSH bootstrap and UI manual instructions. (2) Add or reuse a distribution descriptor that distinguishes an owned release artifact, explicitly configured npm package and upstream compatibility runtime. (3) For a Solla build without an owned configured package, keep unsupported self-update unavailable with an accurate supported manual path. (4) Preserve existing upstream functionality only under its explicit identity. (5) Do not invent/publish a Solla npm name or change registries without a user decision and exact external authorization.

**Checks:** pinned-runtime, self-update, boot-service and SSH command tests; relevant update UI logic tests. **Done:** no supported Solla update path silently installs upstream `t3`; internal compatibility identifiers/license remain intact. If an owned package is required but unavailable, finish gating/docs and record that external prerequisite separately.

### 30 — Separate voice and remote-input lifecycle controllers

**Priority:** P2. **Depends on:** 08, 22; voice can proceed independently of preview extraction.

**Files:** `apps/web/src/orchestrator/realtimeSession.ts`, `useOrchestratorSession.ts`, orchestrator tests/harnesses, remote-control encoder/player/dialog, remote-view transform/zoom modules, `apps/desktop/src/app/RemoteInput.ts`.

**Evidence:** realtime session has 2,200+ lines spanning audio metering, microphone floor, idle timers, transport and callbacks. Remote-view/input code was recently fixed and committed in the checkpoint. Timers can be functional here: background audio-floor reconciliation must not be deleted as “animation waste.”

**Steps:** (1) Split voice transport/session lifetime from microphone/audio resources and tool dispatch, retaining current harness seams. (2) Make finalization idempotent for streams, audio contexts, RAFs, intervals and sockets. (3) Keep coordinate transforms shared between viewer rendering and input mapping. (4) Extract embedded native helper source only if packaging will include it deterministically; preserve AppKit/Carbon guards and acknowledgments. (5) Do not remove fallback timers that make backgrounded mobile audio work without proving replacement behavior.

**Checks:** voice harness/scenario suites selected by changed symbols; remote input, touch delay, transform, zoom and wiring tests. Authorized runtime acceptance requires user-input permission and includes long press, pointer movement, disconnect mid-gesture and microphone stop/restart. **Done:** no leaked media/input state and no regression of checkpoint fixes.

### 31 — Upgrade the Expo/native cohort with patch ownership

**Priority:** P2 maintenance, after stable behavioral refactors. **Depends on:** 04, 24, 32 before final acceptance.

**Files:** `apps/mobile/package.json`, `app.config.ts`, Metro/Babel configs, native module manifests, `pnpm-workspace.yaml`, `pnpm-lock.yaml`, all mobile-related files under `patches/`, mobile workflows.

**Steps:** (1) Run the locally installed Expo dependency check under a supported Node runtime and record its current result. (2) Read the current SDK 57 upgrade notes and choose compatible Expo/React/RN/Reanimated/Worklets/navigation versions together; latest individual tags are not the target. (3) Build a patch table: exact package/version, reason, touched upstream symbol, upstream fix status, and behavioral test. (4) Upgrade one SDK step; regenerate native projects only in disposable state when needed, preserving source-controlled native modules/config plugins. (5) Reapply or retire patches with proof, not by deleting a failed patch. (6) Resolve the mobile nested override for the vendored markdown tarball against root pnpm behavior: verify the actual resolved package bytes before changing configuration.

**Checks:** mobile typecheck, app config/native static check tests, scoped native static analysis and affected module tests. Authorized native builds must cover iOS and Android; simulator-only evidence is labeled. **Done:** one coherent dependency set, reproducible patched install, both native platform build results and a recorded interaction pass. If device/signing credentials are missing, leave that acceptance item pending.

### 32 — Split native review model/layout from view lifecycle

**Priority:** P2. **Depends on:** 01; coordinate with 31 to avoid concurrent native edits.

**Files:** `apps/mobile/modules/t3-review-diff/ios/T3ReviewDiffView.swift`, module Kotlin/TypeScript counterparts discovered from its manifest, markdown/composer/terminal native modules, `scripts/mobile-native-static-check.ts`.

**Evidence:** the iOS review view is 2,575 lines and begins with row/token/theme decoding models before large UIKit rendering code. This is authored native code, unlike generated Expo projects.

**Steps:** (1) Extract Decodable row/token/theme payload types into a proposed sibling `ReviewDiffModels.swift`. (2) Extract theme resolution and layout helpers with explicit inputs, keeping UIView lifecycle/event emission in the view. (3) Preserve UTF-16/line-range conversions, token chunk reset keys, row identity, selection/comment anchoring, accessibility and scroll restoration. (4) Inspect Android equivalents for parity; do not assume iOS structure compiles there. (5) Verify native static-analysis discovery includes the new files and native compilation sees them.

**Checks:** native static checks, TS review model tests, authorized iOS/Android compile and interaction fixtures for large diff, token patch, rename/binary file and comment selection. **Done:** no JS/native schema mismatch, no duplicate registrations, same selection and scroll behavior. Other native modules get a retained/refactor disposition based on an actual seam, not a blanket split.

### 33 — Upgrade Electron and its preview/native dependency cohort

**Priority:** P1 support maintenance. **Depends on:** 08, 22, 30; do not overlap those source refactors.

**Files:** `apps/desktop/package.json`, desktop Vite/packaging scripts, preview injected runtime, `pnpm-lock.yaml`, native module packaging and runtime repair scripts.

**Steps:** (1) Refresh Electron release support and read changes from 41 through the selected supported stable line. (2) Choose a specific target version, record bundled Chromium/Node and native addon compatibility. (3) Upgrade Electron first in a focused commit; update Playwright core in a separate dependent step unless compatibility requires pairing. (4) Rebuild native addons and embedded runtime assets using the existing artifact builder; preserve context isolation, preload APIs, preview partitioning and BrowserSession behavior. (5) Recheck app lifecycle, microphone/screen capture, protocol handling, WSL bridge and code signing/preload output. Clear `ELECTRON_RUN_AS_NODE` only for owned desktop launches/build commands as required by the existing launcher workflow.

**Checks:** desktop lifecycle/preview/preload tests, desktop typecheck, artifact helper tests and a platform artifact build. Authorized smoke checks cover Mac and Windows explicitly. **Done:** supported chosen release, correct native dependencies and bundled preload, verified package provenance; install/runtime acceptance is reported separately and requires release scope.

### 34 — Upgrade protocol/SDK/toolchain families independently

**Priority:** P2. **Depends on:** 07, 21 and stable checkpoints from behavioral refactors.

**Files:** server/protocol package manifests, root catalog/overrides/patches, generated protocol packages, Vite+/tsgo config, provider SDK consumers.

**Steps:** (1) Complete a disposition for every direct dependency in `dependencies.json`; inspect current changelog and peer/engine requirements for each selected upgrade. (2) Update Claude SDK, OpenCode SDK and MCP SDK in separate commits, each with parser and lifecycle fixture tests. (3) Update Codex/ACP upstream protocol pins separately from SDK versions, using deterministic regeneration and drift tests; preserve unknown-field tolerance where the protocol allows it. (4) Evaluate Effect 4 beta plus every `@effect/*` peer as one family, including all patches and tsgo diagnostics. Never select Effect 3 because it carries npm's `latest` tag. (5) Upgrade Vite+, its Vite alias, native-preview compiler and plugins as a compatible toolchain step; verify the actual `vp` commands in CI, not assumed aliases.

**Checks:** affected protocol/provider suites, scoped package typechecks/builds, generators producing clean second-run diffs. **Done:** each upgrade has a reason, exact resolved versions, patch disposition and bounded validation evidence. A supported pin may be RETAINED; a newer version alone does not justify destabilizing the runtime.

### 35 — Maintain marketing/media tooling and actual asset reachability

**Priority:** P3. **Depends on:** 02, 29; Astro update independent of app UI extraction.

**Files:** `apps/marketing/src/lib/releases.ts`, `site.ts`, pages/components/styles, `apps/marketing/package.json`, `tools/motion/package.json`, its lockfile and `src/film/`, `assets/`, README media references.

**Evidence:** September's cleanup already removed testimonials, obsolete reconstruction modules and unused avatars. Release fetch now validates fork ownership and handles unavailable storage; preserve it. Motion is outside the root workspace globs and has its own lockfile and old `onlyBuiltDependencies` configuration.

**Steps:** (1) Upgrade Astro within its chosen compatible line and retain release/cache failure cases. (2) Document whether motion intentionally remains standalone; if so, pin its package-manager/Node policy and compatible install-script allowlist there rather than silently merging its lockfile. (3) Search source, CSS, public URL references, README, generated media manifests and renderer scripts before deleting an asset. (4) Preserve originals needed to reproduce shipped recordings even if the web bundle does not import them. (5) Classify large media as shipped, reproducible source, or obsolete; archive/delete only the last category with proof.

**Checks:** marketing release tests, marketing typecheck/build; motion typecheck under its own environment if changed; relative links and asset references. **Done:** valid fork download routes and reproducible media; no fabricated product screenshots or lost original recordings. Publishing the site is a separate action.

### 36 — Make release inputs immutable and simplify build orchestration

**Priority:** P1 release reliability. **Depends on:** 01; finalizes after version-family upgrades.

**Files:** `scripts/build-desktop-artifact.ts`, `build-install-desktop-release.ts`, `windows-ssh-release.ts`, `update-release-package-versions.ts`, script tests, `.github/workflows/release.yml`.

**Evidence:** artifact builder is 1,919 lines; platform installation/build sequencing is distributed across scripts. Thread history showed a wrong inference that a later Mac packaging timestamp meant it included a code change made after the shared web bundle was built. Artifact bytes, not timestamps, corrected that claim.

**Steps:** (1) Trace the exact shared build and per-platform packaging phases. (2) Make source snapshot identity explicit: HEAD, clean/dirty status, intended version and source/bundle hashes. Prefer an immutable committed checkout for release builds; do not build a release while other owners mutate its inputs. (3) Write a small build manifest beside each artifact with actual shared bundle identity and platform target; verify installed/artifact content against it. (4) Separate input validation, build staging and platform packaging helpers without changing install timing or process ownership. (5) Ensure any version edit is applied before the shared build and exactly once. Build-only commands must not unexpectedly install or restart the host.

**Checks:** build-desktop-artifact, build-install-desktop-release, windows-ssh-release and version-update tests. Use fixture packaging plans before an actual authorized release. **Done:** platform artifacts can be traced to the same intended source and shared bundle; test/build/package/install/runtime statuses are distinct. No automatic install merely to finish this cleanup order.

### 37 — Add narrow prevention checks and correct stale planning guidance

**Priority:** P2. **Depends on:** 02–09; final details after extraction.

**Files:** `vite.config.ts`, `oxlint-plugin-t3code/`, `.github/workflows/ci.yml`, root scripts, `.plans/README.md`, `.plans/04-split-chatview-component.md`, other historical plan headers, `docs/README.md`.

**Evidence:** several correctness-related rules are disabled globally and typed lint is disabled for Effect/tsgo integration; this is a compatibility choice, not permission to enable everything at once. Existing custom rules already enforce useful boundaries. Historical plans point to obsolete renderer/Zod/Bun-era architecture.

**Steps:** (1) Add a small script-reference validation to the existing release/tooling smoke path so a nonexistent local entry is caught. (2) Add only one targeted rule for a demonstrated recurring mistake, with valid/invalid examples and narrow exceptions; candidates include new readiness sleeps in integration harnesses or unreasoned boundary `any`. (3) Do not fail CI on all preexisting warnings or arbitrary line counts. (4) Mark obsolete plans historical and link to this plan; leave historical content intact instead of rewriting it as if it were implemented. (5) Add the new plan to the actual documentation index and keep CI-wide work in CI.

**Checks:** changed lint-rule tests and targeted script tests; verify relative documentation links and referenced paths. **Done:** concrete regressions gain prevention without creating a noisy new global gate; an agent cannot mistake an obsolete plan for current implementation instructions.

### 38 — Close the audit across every inventoried file and deliver a clean handoff

**Priority:** P0 completion gate. **Depends on:** all prior orders receiving a terminal disposition.

**Files:** progress ledger, this plan's evidence, `experiments/messages-glass-lab`, remaining config/assets/fixtures and any files not covered by a change.

**Steps:** (1) Regenerate the inventory and account for added, removed and changed files. (2) Assign every original inventory path an area-level disposition: changed by order, retained by reviewed domain, generated/vendor retained, historical documentation, test/fixture support, or explicit deferred prerequisite. Investigate unassigned areas rather than inferring they're dead. (3) Give the standalone experiment an explicit purpose/retention note; remove it only if no current task or reference uses it. (4) Complete every direct dependency and patch disposition. (5) Confirm known backend regressions pass their focused tests and each changed user-facing surface has an authorized real-client result or an explicit pending acceptance item. (6) Record commit IDs, clean status, documentation consistency and any material risks. Commit the final ledger without staging unrelated new work.

**Done:** no task is silently abandoned, no “candidate” is represented as a proven defect, no pending runtime check is labeled passed, and another agent can identify the exact next action from the ledger. If an external prerequisite prevents an order, mark the cleanup implementation partial with that named prerequisite; the audit/plan itself remains delivered.

## 8. Validation commands and how to select the right scope

Run from repository root unless a working directory is explicitly shown. First confirm a supported Node runtime from `package.json`. The commands below are examples with existing test paths; narrow further when an order changes only one behavior.

```bash
# Current state and whitespace checks; read-only.
git status --short
git diff --check

# Representative web unit checks. Use the web config: it declares its unit project.
(cd apps/web && ../../node_modules/.bin/vp test run --project unit src/components/ProviderTaskPanel.test.tsx src/components/chat/heldMessageQueue.test.ts)

# Representative server integration checks with the server's own configuration.
(cd apps/server && ../../node_modules/.bin/vp test run integration/providerService.integration.test.ts)

# Representative server behavior regression.
(cd apps/server && ../../node_modules/.bin/vp test run src/orchestration/Layers/ThreadWorkScheduler.test.ts)

# Typecheck only a changed package (select the relevant command, not all of them).
./node_modules/.bin/vp run --filter @t3tools/web typecheck
./node_modules/.bin/vp run --filter t3 typecheck
./node_modules/.bin/vp run --filter @t3tools/mobile typecheck
./node_modules/.bin/vp run --filter @t3tools/desktop typecheck
./node_modules/.bin/vp run --filter @t3tools/client-runtime typecheck
./node_modules/.bin/vp run --filter @t3tools/contracts typecheck

# Named changed files only; append the actual edited paths for this order.
./node_modules/.bin/vp lint --report-unused-disable-directives apps/web/src/components/ProviderTaskPanel.tsx

# Native monitor scope only, when that order changes Rust.
cargo test --locked --manifest-path native/resource-monitor/Cargo.toml
```

For packages with local test includes/root configuration, use the package's working directory and its local configuration if a root-invoked command fails to discover the requested file. Example: from `apps/web`, use `../../node_modules/.bin/vp test run --project unit src/components/ProviderTaskPanel.test.tsx`. A “no test files found” exit is **not** a pass, including packages that use `--passWithNoTests`. Record discovered file count and actual assertion count.

For a new behavior test, assert externally meaningful outcomes: retained draft, one delivery, correct thread/instance, canceled obligation, bounded payload or released resource. Avoid tests that merely inspect source text to prove a helper was moved. Preserve existing useful tests during refactors; do not replace them with snapshots of the new implementation structure.

Performance measurements require comparable fixtures and conditions. Use a representative long-history dataset with unrelated large tool payloads for query changes; use a slow/disconnected client fixture for stream changes; measure render/paint activity for animation work. Report absolute before/after observations and dataset size. Do not turn one machine's timing into an arbitrary universal CI threshold.

### Surface acceptance checklist for frontend changes

Record each applicable result separately:

- Entry: chat, Settings, command palette, keyboard shortcut, agent workspace.
- Client: web, Electron shell, native mobile. Mobile web is not the native mobile client.
- Provider: each affected registered driver and at least two instances of one driver for identity-sensitive changes.
- Reverse state: stop/start, close/reopen, hide/show, archive/unarchive, snooze/unsnooze, settle/unsettle where supported.
- Connection: local and remote; add relay/SSH/tailnet/multi-environment cases when touched.
- Evidence: source/tests; build/artifact; installed version; actual runtime interaction. Never collapse these into one green checkbox.

## 9. Execution ledger template and handoff prompt

Use one row per order and append a short narrative for failures or intentionally retained code. Keep exact commands in fenced blocks below the row if long.

| Order | State   | Commit | Files / change    | Checks actually run | Result | Remaining acceptance / next step    |
| ----- | ------- | ------ | ----------------- | ------------------- | ------ | ----------------------------------- |
| 01    | PLANNED | —      | Baseline + ledger | —                   | —      | Establish supported local toolchain |

For each deletion, add a reachability record:

```text
Candidate path:
Exports checked:
Import/path/symbol searches:
Route/worker/native/package-export registrations checked:
Other live consumers of its dependencies:
Decision: remove / retain
Reason and validating command:
Commit:
```

For each dependency/patch, add:

```text
Package + owner:
Declared range / locked version / chosen target:
Reason: compatible update / intentional pin / coupled cohort / removed:
Official release-note URL and date checked:
Patch files and their retention/removal proof:
Focused tests, typecheck/build/native acceptance:
Remaining external prerequisite:
Commit:
```

Suggested prompt for the implementing agent:

> Work through `docs/project/codebase-cleanup-plan-2026-09-07.md` from order 01. Existing implementation is checkpointed at `1b6d64185`; do not revert it. Read AGENTS.md, verify current state and execute one ready work order at a time. Preserve the queue/Stop/agent-resume/provider-instance invariants. Do not blindly delete candidates or upgrade to latest. Record exact focused verification and commits in the progress ledger. Follow the plan's ownership, live-state and runtime-approval rules. Continue through all unblocked work and report any external acceptance prerequisite precisely.

## 10. What this audit turn completed

- Recovered the current request and relevant preceding instructions using the live thread-history tool.
- Committed the entire then-current working tree on `main` at `1b6d64185`, including 108 changed/new files. The formatter hook completed successfully.
- Produced the file inventory, reproducible read-only snapshot, complete root-lockfile direct dependency metadata ledger and 38 detailed work orders.
- Verified the installed Mac application's `Info.plist` reports **0.1.473**. Read the installed `app.asar`: `Background tasks`, `Hide this row` and `queued-messages` are present; the old `reappear when it next reports` string is absent. This closes the handoff's unverified installed-Mac-byte check. It is not a visual/native-provider interaction test.
- Found both local 0.1.473 platform artifacts. A fresh read-only Windows SSH check found executable ProductVersion **0.1.473.0**, running processes using that installed executable, and local HTTP health status **200**. See [Windows readback](codebase-cleanup-2026-09-07/windows-readback.json) and [Mac readback](codebase-cleanup-2026-09-07/mac-readback.json). This verifies installed version/process/HTTP state, not visual interaction or native provider correctness.
- Did not implement the planned product refactors, run a full test suite, browse/control the application UI, build a new release or restart/install an application. This is the requested planning handoff; implementation acceptance remains tracked by the orders above.

The audit is complete as a structural review and executable plan. Whole-program correctness, complete semantic review of every line and flawless future agent execution are not claimed.
