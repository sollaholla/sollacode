# Solla Code redesign: "Obsidian & Gold"

Status: in progress on branch `redesign/gold-black` (worktree `~/Documents/t3-fork-gold`).
Reference: two mockups supplied on 2026-09-02 (desktop 1568×882, phone 441×784 @2x).
Brief: match the mockups one-to-one, but replace every purple accent with gold on black.

This document is the working spec. Every visual decision below is traceable to a
measured element of the mockups; every data decision is traceable to a real field
in the app. Nothing on screen may be invented (no fake metrics, avatars, or copy).

---

## 1. Reference analysis

### 1.1 Desktop mockup (1568×882, 1× CSS px)

| Region         | Measured geometry                                                                                                                                                                                                   | Content                                                            |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| Sidebar        | x 0–290, full height, 1 px right hairline                                                                                                                                                                           | brand row, search, primary nav, AGENTS, THREADS, FAB, Settings     |
| Brand row      | y 14–44; traffic lights x 26–70; bolt mark x 106–124; wordmark x 135–210                                                                                                                                            | bolt glyph + "Solla Code" 15/600                                   |
| Search field   | x 14–234, y 66–96 (h 30), r 8; kbd "⌘K" at x 198–224                                                                                                                                                                | placeholder "Search"; compose button x 243–270                     |
| Primary nav    | rows h 32 at y 110–142 ("All Projects"), 145–177 ("Orchestrator")                                                                                                                                                   | icon 16 px at x 30, label 13/500 at x 50                           |
| AGENTS header  | y 190–204; uppercase 11/600, tracking 0.08em; "+" pill x 244–266                                                                                                                                                    | section toggle + add                                               |
| Agent rows     | h 30, pitch 31 (y 210, 241, 272, 303, 334, 365); active row bg spans x 12–278, r 8                                                                                                                                  | icon x 30, name x 50, 6 px status dot x 258 (spinner when working) |
| Notice         | y 404–430, 12/400 muted, link in accent                                                                                                                                                                             | "Agent access is not granted…" (real copy from agentRegistryState) |
| THREADS header | y 452–466, "+" pill at right                                                                                                                                                                                        |                                                                    |
| Thread rows    | title 13/500 (y 486), subtitle 12/400 muted (+20), branch 11/400 (+18); right meta 11/400 (time) or "Working 1h 20m" in accent with glyph                                                                           | 4 rows, pitch ≈ 58–66 depending on lines                           |
| FAB            | 46 px circle at (45, 773) accent-filled, sparkle glyph; 14 px square badge at (64, 792)                                                                                                                             | orchestrator voice                                                 |
| Settings       | row y 830–860, gear icon                                                                                                                                                                                            |                                                                    |
| Header         | y 0–66 (content row centred y 33); tile 24 px at x 310; title 15/600 x 347 + chevron; subtitle 12/400 muted y 48                                                                                                    | project + thread                                                   |
| Header actions | "Browser" pill x 1218–1340 h 28 r 999 (globe + label + chevron); icons 18 px at x 1380 (sparkle), 1427 (search), 1473 (bell, accent dot), avatar 28 px at 1525 with green dot                                       |                                                                    |
| User bubble    | right aligned, x 1048–1380, y 92–127, r 12, accent-tinted bg; time "2:35 PM" + double check below-right (y 140)                                                                                                     |                                                                    |
| Work card      | x 545–1272; header "● Working <status>" at y 160; narration 13/400 lh 1.5 at y 190; tool rows h 36 header (+ body); rows r 10 with 1 px border                                                                      |                                                                    |
| Tool row       | icon tile 24 px r 6 at x 572; name 12.5/600 at x 598; args mono 11.5 muted-accent at x 715; green check 14 px at x 1247                                                                                             |                                                                    |
| Card footer    | "Show fewer tool calls" pill x 556–724 h 24 r 999; resource pill x 990–1268                                                                                                                                         |                                                                    |
| Working line   | y 782; 14 px accent glyph + "Working for 5m 42s…" 12/400 muted                                                                                                                                                      |                                                                    |
| Composer       | x 490–1335, y 792–870 (h 78), r 16, 1 px border; placeholder 13/400 y 812; left circular controls 28 px at x 514/552/590/628; right controls at x 1220 (lightning), 1265 (mic), 1307 (send 26 px square r 8 accent) |                                                                    |

### 1.2 Phone mockup (441×784 CSS px; measured at 2× and halved)

| Region         | Geometry (1×)                                                                                                                                                                                        | Content                                                                |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| Top bar        | h 40; hamburger x 13–32; bolt x 50–62; wordmark 16/600 x 70–128; green dot x 374; avatar 22 px x 388–410; chevron x 415–423                                                                          |                                                                        |
| Project card   | x 13–428, y 43–99 (h 56), r 12, border; tile 34 px r 8 at x 26; title 15/600 + chevron; subtitle 12/400; "Browser" pill x 329–416 h 22                                                               |                                                                        |
| Chat container | x 13–428, y 108–718, r 14, border, bg one step above app bg; holds bubble, work card, working line, composer                                                                                         |                                                                        |
| User bubble    | x 59–428 (flush to container right edge, top-right corner square), y 109–150, r 14/0/14/14; 14/400; time 11 + double check inside bottom-right                                                       |                                                                        |
| Work card      | x 33–368, y 159–636, r 10, border; header dot + "Working" 13/600 + status 12/400; body 13/400 lh 1.5; tool rows x 45–358 h 26 header r 8                                                             |                                                                        |
| Card footer    | "Show fewer tool calls" pill x 44–156 h 19; resource pill x 178–358                                                                                                                                  |                                                                        |
| Working line   | y 649, accent glyph x 38                                                                                                                                                                             |                                                                        |
| Composer       | x 22–418, y 663–718 (h 55), r 12, border; placeholder 13/400; circular 22 px controls at x 41 (+), 70 (lock), 98 (terminal); mic circle x 353; send 30 px square r 8 accent with 12 px glow at x 392 |                                                                        |
| Tab bar        | x 13–428, y 724–769 (h 45), r 14, border; 5 tabs; active tile x 13–93 accent-tinted r 12; icons 20 px; labels 11/500                                                                                 | Projects (active), Agents (green dot badge), Threads, Search, Settings |
| Home indicator | OS-drawn; content must clear `env(safe-area-inset-bottom)`                                                                                                                                           |                                                                        |

### 1.3 What the mockups keep from the current app

DM Sans (already loaded), JetBrains Mono for tool arguments, Lucide icon set,
sidebar v2 information architecture (search → project scope → orchestrator → agents →
threads → settings), the virtualised timeline, the glass composer shell, the
right-panel model ("Browser" is the preview surface), the mobile off-canvas
sidebar. The redesign is a re-skin plus a handful of structural additions
(bordered work cards, header restructure, phone top bar and tab bar).

---

## 2. Design tokens

Gold replaces every purple in the mockups. Black replaces the navy base.
All values are declared once in `apps/web/src/index.css` and consumed through
the existing shadcn variables so every primitive follows automatically.

### 2.1 Colour

| Token                | Value                    | Use                                                     |
| -------------------- | ------------------------ | ------------------------------------------------------- |
| `--gold-300`         | `#F5D77A`                | text on dark accent surfaces, hover glyphs              |
| `--gold-400`         | `#EAC45A`                | icon accents, links, "Working" labels                   |
| `--gold-500`         | `#D9A93A`                | primary: send button, FAB, active tab, focus ring       |
| `--gold-600`         | `#B98A26`                | pressed states, borders on accent fills                 |
| `--gold-glow`        | `rgb(217 169 58 / 35%)`  | send button and FAB outer glow                          |
| `--gold-tint`        | `rgb(217 169 58 / 10%)`  | selected sidebar row, active tab tile, user bubble base |
| `--gold-tint-strong` | `rgb(217 169 58 / 16%)`  | selected row hover, bubble hover                        |
| `--gold-line`        | `rgb(217 169 58 / 28%)`  | hairline on tinted surfaces                             |
| `--ink-950`          | `#050505`                | app background                                          |
| `--ink-900`          | `#0A0A0B`                | sidebar, header, composer base                          |
| `--ink-850`          | `#0F0F11`                | cards: work card, project card, chat container          |
| `--ink-800`          | `#151517`                | raised: icon tiles, pills, inputs, kbd                  |
| `--ink-750`          | `#1B1B1E`                | hover on raised                                         |
| `--line`             | `rgb(255 255 255 / 8%)`  | default hairline                                        |
| `--line-strong`      | `rgb(255 255 255 / 14%)` | pills and inputs                                        |
| `--text-1`           | `#F4F4F5`                | primary text                                            |
| `--text-2`           | `#B4B4BB`                | secondary (subtitles, narration)                        |
| `--text-3`           | `#7C7C85`                | muted (meta, placeholders)                              |
| `--text-4`           | `#55555C`                | faint (disabled, separators)                            |
| `--ok`               | `#34D399`                | online dots, tool success checks, "Working" dot         |
| `--danger`           | `#F87171`                | failures                                                |
| `--warn`             | `#FB923C`                | warnings (orange, so it never reads as gold)            |
| `--info`             | `#60A5FA`                | informational                                           |

Mapping onto existing variables (dark scheme): `--background: var(--ink-950)`,
`--card: var(--ink-850)`, `--popover: var(--ink-800)`, `--muted: var(--ink-800)`,
`--accent: var(--ink-750)`, `--primary: var(--gold-500)`,
`--primary-foreground: #0B0B0B`, `--ring: var(--gold-500)`, `--border: var(--line)`,
`--input: var(--line-strong)`, `--sidebar: var(--ink-900)`,
`--sidebar-row-selected: var(--gold-tint)`, `--sidebar-row-active: var(--gold-tint-strong)`,
`--sidebar-row-hover: rgb(255 255 255 / 5%)`, `--success: var(--ok)`,
`--warning: var(--warn)`, `--destructive: var(--danger)`. The
`.dark [data-sidebar-version]` override block collapses into the same palette so the
sidebar and workspace share one black.

Light scheme: unchanged layout, `--primary`/`--ring` become `--gold-600` for contrast.
The light theme is kept working, not redesigned.

### 2.2 Typography

| Role                               | Size / weight / line-height              |
| ---------------------------------- | ---------------------------------------- |
| Brand wordmark                     | 15 / 600 / 1 (phone 16)                  |
| Section header (AGENTS, THREADS)   | 11 / 600 / 1, uppercase, tracking 0.08em |
| Sidebar row label                  | 13 / 500 / 1.2                           |
| Thread row title / subtitle / meta | 13/500, 12/400, 11/400                   |
| Header title / subtitle            | 15/600, 12/400                           |
| Chat user text                     | 13.5 / 400 / 1.5 (phone 14.5)            |
| Narration                          | 13 / 400 / 1.55 (phone 13.5)             |
| Tool name / arguments              | 12.5/600 sans, 11.5/400 mono             |
| Pills                              | 12 / 500                                 |
| Composer placeholder               | 13 / 400                                 |
| Tab label                          | 11 / 500                                 |

### 2.3 Shape, depth, iconography

Radii: sidebar row 8, header tile 8 (phone 10), tool row 10, work card 12, project card 12,
chat container 14, composer 16 (phone 12), send button 8, pills 999, kbd 4.
Borders are always 1 px `--line`; tinted surfaces use `--gold-line`.
Shadows: none on flat surfaces; send button and FAB get `0 0 0 4px var(--gold-glow)`
plus `0 8px 24px -12px var(--gold-glow)`. No blur-heavy glass on phones.
Icons: Lucide, stroke 1.75. Sizes: sidebar 16, header actions 18, tool tile 13 in a
24 box, composer circular controls 15 in a 28 circle (phone 18 in 40), tab bar 20.
Brand mark: a gold bolt SVG (`SollaBoltIcon`) with a vertical gradient
`--gold-300 → --gold-600`; the existing gold PNG stays for favicons.

### 2.4 Motion

Keep the repo rule: no continuously repainting animation. Existing duty-cycled
working glyphs stay. New states use 150 ms colour/opacity transitions only.

---

## 3. Component specifications

Each entry: reference → current → target → data.

### 3.1 App chrome

Reference: one continuous black; sidebar and workspace share the same base; grain kept subtle.
Current: `--background` neutral-950, sidebar pure black override, blue focus ring.
Target: tokens above; `body` grain opacity unchanged; focus ring gold.

### 3.2 Sidebar (desktop and the phone sheet)

1. Brand row: traffic-light inset (existing 90 px), `SollaBoltIcon` 18 px, wordmark
   `APP_BASE_NAME`. Height stays `--workspace-topbar-height`.
2. Search: `SidebarMenuButton` becomes an input-looking pill (`--ink-800`, `--line-strong`,
   r 8, h 30) with `SearchIcon`, "Search", kbd. Compose button 28 px square r 8 beside it.
3. Primary nav: the project scope trigger is rendered as an "All Projects" row (folder icon)
   when unscoped, or the scoped project's favicon + name when scoped; the orchestrator entry
   keeps its row with `AudioLinesIcon`.
4. AGENTS: section label uppercase 11/600 `--text-3`; the "+" becomes a 22×16 outlined pill.
   Rows: 30 px, icon 16 px, name 13/500, right slot = working glyph (existing
   `CircleDashedIcon` duty-cycle) or a 6 px status dot (`--ok` when the agent status is
   `running`/`idle`, `--text-4` when `paused`/`stopped`). Approval/input states keep their
   existing amber/indigo glyphs (real state must not be hidden). Agent glyphs come from a
   deterministic keyword map (`paw`, `medical→heart`, `assistant→user`, `doodle→pencil`,
   `world→globe`, `computer→monitor`) with a hashed fallback from a 12-icon set; this is
   decoration, not data.
5. Notice copy: unchanged text, restyled 12/400 `--text-3`, link `--gold-400`.
6. THREADS: same header treatment; "+" = existing new-thread action. Card rows become
   three-line rows: project name 13/500 (with favicon), thread title 12/400 `--text-2`,
   branch 11/400 `--text-3`; right slot = time label or `Working 1h 20m` in `--gold-400`
   with the existing working glyph and side-chat/terminal counts. Selected row bg
   `--gold-tint`, hover `--sidebar-row-hover`. Settled/snoozed rows stay slim.
7. FAB: 46 px gold circle, `SparklesIcon`, glow; action = orchestrator voice toggle
   (existing `useOrchestratorSessionContext().toggle`), tooltip carries the shortcut; the
   14 px square badge opens the orchestrator thread. Hidden when the orchestrator is not
   set up (the row's existing "set up voice" affordance remains).
8. Settings row: unchanged action, gear 16 px.

### 3.3 Thread header (desktop)

Reference: tile + title/subtitle on the left, action cluster on the right.
Target markup (`ChatHeader.tsx`):

- Tile: 24 px `--ink-800` r 8 box containing `ProjectFavicon` (fallback `Globe2Icon`).
- Title: project name 15/600 + `ChevronDownIcon` 14 px; click = project menu
  (new thread in project, project scripts, open in editor, project settings).
- Subtitle: thread title 12/400 `--text-2` (projects have no description field; the
  thread title is the honest second line). Truncates.
- Actions: `Browser` pill = right-panel toggle with the active surface label
  (`PanelLayoutControls`), sparkle = orchestrator voice, search = command palette,
  bell = agent attention (badge dot when `unreadNotifications + openBlockers > 0`),
  avatar = 28 px circle with `UserRoundIcon` (no user photo exists) and a 7 px
  connection dot (`ConnectionStatusDot` semantics); click opens Settings.
  Existing controls (terminal switch, scripts, remote, open-in) move into the project
  menu and the overflow so nothing is lost.

### 3.4 Timeline

1. User bubble (`UserTimelineRow`): bg `--gold-tint` over `--ink-850`, border
   `--gold-line`, r 12 (phone: top-right 0 and flush right), padding 12×14, text 13.5.
   Meta line: `formatShortTimestamp` + `CheckCheckIcon` in `--gold-400` when delivered,
   single check muted when sent, clock glyph when queued (`messageDeliveryState`).
2. Work card: rows belonging to one assistant turn segment render inside one bordered
   `--ink-850` card. Implemented as row-level edge flags computed in
   `MessagesTimeline.logic.ts` (`cardEdge: "start" | "middle" | "end" | "solo"`) so
   LegendList virtualisation is untouched; each row paints its own left/right border and
   the start/end rows paint the top/bottom edge and radius.
3. Turn status header: a new `turn-status` row inserted at the start of the in-flight
   turn's segment: 8 px `--ok` dot, "Working" 13/600, then the existing
   `workingStatusLabel` (e.g. "Follow-up queued for the next safe browser boundary",
   "Compacting context") in 12/400 `--text-3`. When the turn settles the row is removed
   (the settled card has no header, matching the mockup's older turns).
4. Narration (`AssistantTimelineRow` without meta): 13/400 `--text-2`, padding 10×14.
5. Tool rows (`SimpleWorkEntryRow`): bordered `--ink-900` r 10 within the card, 8 px gap;
   header row h 36: icon tile 24 px (`--ink-800`, r 6, glyph 13 px `--text-2`), heading
   12.5/600 `--text-1`, preview mono 11.5 `--gold-300/80` inside a `--ink-800` chip when
   it is an argument string, otherwise `--text-3`; trailing green check 14 px `--ok`
   (failure: `--danger` x; neutral: muted dash). Expanded body keeps its indented style.
6. Group toggle (`WorkGroupToggleTimelineRow`): pill r 999, h 24, border, sparkle glyph,
   "Show fewer tool calls" 12/500, chevron. "+N previous tool calls" uses the same pill.
7. Resource pill: only real numbers. `useResourceTelemetry` already exists for the
   diagnostics page; the pill shows CPU and RAM from it while the turn is working, polled
   at the diagnostics interval, and is omitted entirely when telemetry is unavailable.
   There is no network metric in the app, so NET is not rendered.
8. Working line (`WorkingTimelineRow`): `AudioLinesIcon` 14 px `--gold-400` +
   "Working for 5m 42s…" 12/400 `--text-3`; unreachable-host copy unchanged.
9. Assistant meta row (copy button + time) keeps its place under a settled answer.

### 3.5 Composer

- Shell: r 16 (phone 12), bg `--ink-900`, border `--line-strong`, no drop shadow in dark;
  glass variables retuned to the black palette.
- Editor: placeholder 13/400 `--text-3`; unchanged behaviour.
- Footer left (desktop): circular 28 px ghost buttons in order:
  `+` (attach images: hidden file input feeding the existing image-attachment pipeline),
  lock (runtime mode select, icon-only), infinity (interaction mode select, icon-only),
  sparkle (traits/model options). Model picker collapses to the lightning button on the
  right (icon-only trigger; label in tooltip). Phone footer: `+`, lock, terminal
  (main-surface switch) on the left; mic + send on the right.
- Send: 26 px (phone 30) square r 8 `--gold-500`, glyph `#0B0B0B`, glow; stop state is
  `--danger` square; disabled = 45% opacity. Mic: 28 px circle ghost, recording = `--danger`.
- Status rail (usage pills, task chips) keeps its grid, restyled to the pill tokens.

### 3.6 Phone web layout (≤ 767 px)

1. `MobileTopBar`: h 40 + safe-area top; `SidebarTrigger` (hamburger), bolt + wordmark,
   connection dot, avatar circle, chevron → menu (Settings, Orchestrator, Pair device).
   Replaces the current floating trigger on chat routes.
2. Project card: `ChatHeader` in stacked mode: tile 34 px, title + chevron, subtitle,
   "Browser" pill right-aligned. Bordered `--ink-850` r 12 card with 12 px inset.
3. Chat container: timeline + working line + composer inside one bordered r 14 card with
   12 px horizontal inset; the timeline scroll region lives inside it. Composer inset
   8 px from the container edges.
4. `MobileTabBar`: 45 px + safe-area bottom, r 14 card 13 px inset; tabs: Projects
   (opens the sidebar sheet at the project scope), Agents (sheet with AGENTS expanded;
   badge dot when any agent needs attention), Threads (sheet with THREADS expanded),
   Search (command palette), Settings (route). Active resolution: chat/draft routes →
   Projects, agent routes → Agents, settings → Settings. Logic lives in
   `mobileTabBar.logic.ts` with unit tests.
5. Hidden on phones: desktop header action cluster (moved into the top-bar menu), FAB.

### 3.7 Shared primitives

`Button` default variant → gold on black text; outline/ghost use the ink palette.
`Kbd` → `--ink-800` + `--line-strong`. `Badge` accent → gold tint. Scrollbars 6 px
`rgb(255 255 255 / 10%)`. Popovers `--ink-800` with `--line-strong`. Tooltips unchanged.

---

## 4. Data and honesty rules

- Every label comes from existing state: names, statuses, times, working durations,
  delivery states, agent notices, provider labels.
- No user photo exists → generic avatar glyph. No project description → thread title.
- No network metric exists → no NET pill. CPU/RAM only from real telemetry.
- Agent glyphs are deterministic decoration and are documented as such in the UI code.
- Nothing in the redesign may hide a real state (approvals, input requests, failures,
  unreachable hosts, queued messages) behind a prettier neutral.

## 5. Performance and surfaces

- No new per-frame work: card edges are static classes; telemetry polls reuse the existing
  hook and only mount while a turn is working.
- Timeline virtualisation, LegendList row keys and scroll anchoring are untouched.
- Surfaces: web (local and hosted) and desktop (wraps web) get the redesign. The React
  Native app is a separate surface and is out of scope for this pass; the phone mockup is
  the web app in Safari. Light theme stays functional with gold primaries.
- Docs: `docs/user/` gets an appearance note; `docs/reference/encyclopedia.md` gains
  "work card" and "tab bar".

## 6. Implementation order

1. Tokens and primitives (`index.css`, `button.tsx`, `kbd.tsx`, `badge.tsx`).
2. Sidebar (`SidebarChrome.tsx`, `SidebarV2.tsx`, `AgentStackSidebarEntry.tsx`,
   `OrchestratorSidebarEntry.tsx`, `ui/sidebar.tsx`, `Icons.tsx` bolt).
3. Header (`ChatHeader.tsx`, `PanelLayoutControls.tsx`, `ChatView.tsx` header block).
4. Timeline (`MessagesTimeline.logic.ts` + tests, `MessagesTimeline.tsx`).
5. Composer (`ChatComposer.tsx` footer, `ComposerPrimaryActions.tsx`, `ComposerControl.tsx`,
   `ProviderModelPicker.tsx` trigger).
6. Phone (`MobileTopBar.tsx`, `MobileTabBar.tsx`, `mobileTabBar.logic.ts` + tests,
   `ChatView.tsx` container, `AppSidebarLayout.tsx` mount, `index.css` safe areas).
7. Docs, targeted lint/typecheck/tests for touched files.

## 7. Verification loop

- Clone: worktree `~/Documents/t3-fork-gold`, state `.t3/` seeded from a sanitised
  `VACUUM INTO` snapshot of the installed app (`~/.solla-code/userdata`), all scheduled
  agent tasks paused, obligations cancelled, sessions stopped, startup auto-resume off.
- Dev server: `vp run dev` from the worktree; ports from the `[dev-runner]` line.
- Browser: T3 preview tab, dark appearance forced, viewport 1568×882 for desktop and
  441×784 for phone (mockup at 2×), same "Open World" thread as the mockups.
- Protocol per pass: screenshot → overlay against the mockup → walk the checklist
  (position, size, radius, colour, type, spacing, iconography, states) → fix → repeat.
- Done when: every element in §1 is present with matching geometry within ±2 px, colours
  match the token sheet, no fabricated data, no lint/type errors in touched files, and
  the focused tests pass.

## Addendum — decisions from live review (2026-09-02, evening)

These came out of reviewing the clone with the user watching the preview.

### Turn box: the whole agent turn is one card

- **Rule.** Everything the agent says or does in one turn lives in a single bordered card: commentary, the final reply, tool rows, the show-more/fewer toggle, and the live working line. User messages, provider transitions, folds, and plans sit outside and therefore split one card from the next.
- **How.** The timeline is a virtualized list of independent rows, so the card is painted row by row: `deriveWorkCardEdges` labels each row `start | middle | end | solo` and `applyWorkCardEdges` stamps that onto the row objects (identity-stable per source row). The edge has to live on the row: a side map left already-mounted rows drawing stale edges, which showed up as two boxes butting together with a seam.
- **Look.** `--card` surface, 1px `--line`, 14px radius, 16px gap between cards. Tool rows inside use `ink-900` with the same 1px `--line`, 10px radius; the leading glyph sits in a 24px `ink-800` tile.

### One edge, one type scale

- **Borders.** Exactly one technique: `1px solid var(--line)` (8% white). No `ring-*` used as a border, no `shadow-xs` double edges, no alpha-faded `border-border/70` variants; those were the "inconsistent widths and sharpness". Emphasis comes from surface contrast, never from a thicker or brighter edge. Gold edges (`--gold-line`) are reserved for the user's own bubble.
- **Radii.** 14px cards (turn box, composer banner cards, user bubble), 10px inner rows (tool rows, diff summary), 8px tiles/inputs, full pills. The composer keeps its 22px shell for now because its attachment-strip clip path is authored around 22px; changing it means re-deriving that path, tracked as follow-up.
- **Surfaces.** Page `#050505` → card `#0f0f11` → inner row `#0a0a0b` → tile/chip `#151517`. The composer, the banner stack (version notice, agent alerts, blockers), and the user bubble all use the card surface and edge; glass blur and inner highlights are off in dark.
- **Type.** DM Sans everywhere; body 13.5/1.55, tool heading 12.5/600, mono args 11.5 JetBrains Mono, meta 11, sidebar rows 13/500, section headers 11/600 uppercase 0.08em, header title 15/600.
- **Preview caveat.** The in-app preview panel renders the guest at a fractional scale (measured `devicePixelRatio` 0.913), so every 1px edge is resampled and some read heavier than others there. The real window renders at integer scale; judge hairlines in the app window, not the panel.

### Agent icons are a persisted feature, not a heuristic

- `VmAgent.icon` (nullable, migration 073) holds a lucide id from the closed `VM_AGENT_ICONS` set (72 outlined, uncoloured glyphs — the monochrome equivalent of an emoji).
- **Chosen by the AI.** `agent_builder` `create_agent` takes `icon` and is told to always pick one. If an agent still has none, its own first run is instructed (in the per-turn agent context) to call `agent_workspace` `set_icon` as the very first step, then continue with the request. The registry broadcasts the change so the sidebar updates live.
- **Until then** the client derives a glyph from the name (`resolveAgentGlyphKey`), so no row ever shows a generic robot.
- The status dot stays where it already was (trailing slot); the duplicate I had added is gone.

## Addendum 3: mobile shell and the wormhole orb

### Phone shell (under `md`)

- `SidebarInsetChromeProvider` lets the layout slot a top and bottom bar into `SidebarInset` without every route knowing about phones. `AppSidebarLayout` mounts `MobileTopBar` (navigation trigger, mark, app name) on top and `MobileTabBar` (Projects / Agents / Threads / Search / Settings) on the bottom; both are `md:hidden`, and the floating `SidebarControl` is hidden on `max-md` so the two never overlap.
- Tab logic lives in `mobileTabBarLogic.ts` (active tab from the pathname, sidebar anchor to reveal per tab) and is unit-tested; the bar itself opens the mobile sidebar and scrolls the matching section into view, or opens the command palette / settings route directly.
- The agent workspace header becomes a bordered card on phones (`max-md:mx-3 max-md:mt-2 max-md:rounded-[14px]`), the same 14px card rule as everything else.
- **Not visually verified.** The in-app preview cannot be resized to a phone viewport in this environment (preset and freeform resizes time out), so the phone shell is covered by the logic tests and typecheck only. Check it in the real app or the mobile skill before shipping.

### The orb is a WebGL wormhole

- One shared `BlackHoleOrb` component now backs the sidebar talk button, the listening overlay (150px) and the floating bubble (56px). It draws through `blackHoleShader.ts`; if WebGL is unavailable the old CSS layers render instead (`data-orb-renderer="webgl|css"`).
- **Picture.** Inside the rim the far universe (a soft galaxy plus a star field) is looked up by direction, with the deflection growing to a full wrap at the edge, which stretches it into rings; a thin Einstein ring sits at 98% radius. Outside, a point-mass lens maps each pixel back to its source position, so stars behind the throat appear as tangential arcs that tighten toward the rim. Sampling the source plane once is what draws the arc; the earlier tangential multi-tap "streak" only broke each arc into beads and was removed. No spiral-arm swirl and no dragged-space twist: the user asked for the calm Interstellar look, not a vortex.
- **Voice.** `u_intensity` (from the `--orb-intensity` inline variable, set per frame by the overlay and bubble loops) brightens the interior, widens the halo and warms the bloom inside the rim. `u_brightness` dims the idle palette.
- **Sharpness.** Every pixel is four rotated-grid samples, the inside/outside pictures are blended across a one-pixel band at the rim instead of switched, and stars are gaussians a few device pixels wide instead of sub-pixel steps. The backing store is at least two pixels per CSS pixel (capped at three, 1024px): the preview panel reports `devicePixelRatio` 0.91, and a canvas sized to that upscaled a soft render, which is what "pixelated" was.
- **Lifecycle.** Never call `loseContext()` on cleanup: StrictMode double-mounts and the second mount reuses the same canvas context, which then fails to compile. The first frame is drawn synchronously because `requestAnimationFrame` does not fire in a background tab.
- Settings shows an 80px preview beside the Floating bubble switch (`orchestrator-orb-preview`).

## Addendum 4: alignment pass, motion, no sidebar orb

### Alignment pass

Measured with a DOM audit (every button's box, radius and icon offset) rather than by eye, on the thread page, the agent page and settings. The rules that fell out of it:

- **32px row controls.** Composer controls are 32px at every breakpoint (`sm:h-8 sm:min-h-8` on the shared class, since the `sm` size variant of Button and SelectTrigger otherwise shrinks them to 28); icon-only composer controls are `size-8`, including the model picker, traits, plan toggle and the context meter. The sidebar search row is 32px like its neighbours.
- **28px pills.** Section-header actions in both sidebar sections are 28px; the agent header's Remote control chip is a 28px pill like the Browser control beside it (`RemoteConnectionControl` takes a `className`).
- **24px icon buttons are 8px-radius `rounded-md`**: terminal toggle, emoji button, settings info/reset buttons.
- **Radius ladder.** Full for composer circles and status pills; 14px cards (turn box, user bubble now included, it was 16); 10px form fields (inputs, textareas, selects share `rounded-lg`); 8px 24–32px icon buttons and sidebar rows.
- The composer's send button stays a 10px gold square beside a round mic on purpose (the mockup's one square).

### Motion

`index.css` ends with a motion block, all inside `prefers-reduced-motion: no-preference`: every button, link, menu item, tab, switch and combobox eases colour, border, shadow and transform over 160ms on a soft curve; small controls compress to 0.97 on press (sidebar rows excluded); `.motion-enter` / `.motion-fade` / `.motion-scale-in` utilities for content that appears. Applied to timeline rows, the agent workspace and the draft hero; popups already use Base UI's starting/ending-style transitions.

### No sidebar orb

The sidebar footer orb added earlier in the redesign is gone. The orchestrator's home is the floating always-on-top bubble (a separate window), plus the sidebar's Orchestrator row and the orchestrator route; a second orb inside the sidebar duplicated it. `resolveVoiceOrbTint` (voice state → orb tint) now lives beside `BlackHoleOrb` for the route and the bubble.

## Addendum 5 — terminal workspace, settings audit, provider usage (2026-09-03)

**Send button.** The composer's send square is solid gold in every state. The
"artwork" environment-identification mode used to paint the per-channel stage
art (a dark nightly sky) behind a transparent button, which read as a dead
control. Channel identity now lives only in the sidebar header.

**One layout per thread.** Terminal "groups" are gone from the workspace. The
plus button (and ⌘N) adds a pane to the thread's single split tree — beside the
active pane when it is wide, beneath it when it is tall — instead of opening a
second group that hid the panes already on screen. Threads persisted with
several groups are merged into one layout when terminal mode opens. The cap is
six panes per layout (`MAX_TERMINALS_PER_GROUP`); the plus disables with a
"(max 6 panes)" label at the limit. Panes sit in a 6px gutter with 8px corners.

**Selection.** The focused pane carries a gold edge with a soft outer glow,
its header tints gold, the sidebar row gets a gold left bar on a gold tint,
and the tab strip underlines the active tab in gold on a faint gold wash.

**Launch pad.** A thread with no terminals shows a launch pad instead of an
auto-opened shell: the installed provider CLIs (from the provider registry,
via `providerDriverLaunchCommand`) as checkboxes with nothing preselected, a
"Terminals each" stepper (panes per selected provider, or plain shells when
none is selected), Launch, a Browser shortcut and a "just open a blank shell"
link. Launch opens every pane at once as a two-column grid
(`launchTerminalGrid`) and types each provider's command once its shell is up.

**Browser pane.** The plus is a menu — Terminal or Browser — and Browser docks
the thread's preview as a pane (`BROWSER_PANE_ID`, a layout leaf without a
PTY). The store keeps it through server reconciliation and never marks it
pending; closing it only removes the leaf.

**Annotation focus.** Selecting a preview element for a follow-up comment used
to lose keystrokes to the composer. The guest preload now reports an
`editor-focus` signal while its comment box is focused, which flips input
ownership to the guest and suppresses the app's key reclaim.

**Motion.** Per-row and hero enter animations are removed: virtualized rows
remount constantly, so an entry animation replayed as flicker. Control
transitions stay; content never animates on remount.

**Settings audit.** General is regrouped into Threads, Projects, Models,
Background work, Voice input and About. Time format, assistant streaming and
diff whitespace moved to Appearance › Content next to Word wrap; the provider
usage bar and update checks moved to Providers › Provider preferences. Settings
are searchable: a search box at the top of the settings sidebar filters a
static index (`settingsSearchIndex.ts`) across every tab; a result navigates
with the row id as the hash, and the layout scrolls to and flashes the row.
Rows derive their id from their title (`settingsRowAnchor`).

**Provider usage.** Each provider row shows a ring badge for the quota nearest
its limit; Usage and Configure are separate, mutually exclusive disclosures.
The usage panel has gold quota bars with an elapsed-time marker and reset
countdowns, provider reset credits, and "Activity on this device": tokens and
provider-reported cost per turn, folded from `context-window.updated`
activities into a persisted ledger (`providerUsageLedger.ts`) keyed by turn,
with today / 7 / 30 day / all-time cards, a 14-day bar chart and a daily
table. Window labels are title-cased; windows a provider stops reporting are
pruned after seven days (`lastSeenAt`). The provider usage bar defaults on.

## Addendum 6 — usage card, agent power switch, rollout (2026-09-03)

**Composer usage card.** The provider usage popover (usage-bar badge) is
rebuilt on the settings quota treatment: a wrapping header (title, reported
time, status pill, pill-shaped Refresh / Switch user actions that never
break mid-label), one bordered row per window with a gold/amber/red bar, an
elapsed-time marker, a "left" countdown and a single "Resets …" line, and
reset credits and the external link in matching rows. The neutral bar colour
is gold everywhere the usage bar draws one.

**Terminal mode starts empty.** Entering terminal mode no longer seeds a
placeholder "Terminal 1"; the launch pad is the empty state. Fullscreen is
disabled with a single pane and drops when a single pane remains.

**Agent cursor.** The desktop pointer events carry the guest viewport size;
the renderer places the agent cursor by fraction of the drawn webview rect,
so it lands where the agent clicked at any zoom or fit.

**Agent power switch.** Agents can be started and stopped by the user: the
workspace header carries a "● Running · Stop" / "○ Stopped · Start" pill and
the sidebar row reveals a power button beside the delete X. Stopping sets the
agent `stopped` (grey dot), interrupts its in-flight turn, and makes the
scheduler skip its due tasks (the SQL claim excludes agents whose status is
not `running`, so occurrences stay armed and resume on start). Run-now is
refused while stopped. The Agent Builder MCP tool gained `start_agent` and
`stop_agent`.

**Rollout.** Main's working-tree drift since the branch was cut (55 files:
preview automation, usage-limit failover, Grok adapter, remote control,
timeline padding) was three-way merged into the worktree before 0.1.388 was
built from it.

## Addendum 7 — Siri dictation dropping words in the composer

**Symptom.** Dictating into the chat composer intermittently deleted words from
the middle of a sentence, leaving the surrounding spaces behind.

**Cause.** `ComposerPromptEditor` is a controlled Lexical editor. Every edit is
emitted upward into `composerDraftStore` and handed back as `value`; applying it
runs `$setComposerEditorPrompt`, which calls `root.clear()` and rebuilds every
text node, then force-moves the caret.

macOS dictation streams words and then makes a post-processing pass that
replaces earlier words in place, anchored to the DOM text nodes it originally
wrote. A controlled write-back landing between those two phases clears the root
underneath the pending replacement, so the word is dropped.

It fires because the editor can emit V1 then V2 before React re-renders. V1
arrives back as `value`, and the old check (`previousSnapshot.value !== value`)
could not tell that lagging echo apart from a genuine external edit, so it
rewrote the editor with the stale string.

**Fix.** `apps/web/src/components/composerDictationSync.ts`:

- `resolveComposerControlledSync` returns `defer` while a composition is open or
  within `COMPOSER_DICTATION_SETTLE_MS` (400 ms) of `compositionend` /
  `insertReplacementText`. Nothing clears the root or moves the caret while an
  input method owns the text.
- `resolveComposerDictationFlush` resolves the divergence once dictation lets
  go. The editor's text wins — a `value` that still disagrees is a lagging echo,
  and writing it back is the word loss itself. Inline chips are the exception:
  they only exist as nodes, so a terminal-context or skill change still rewrites.

The window only ever _delays_ an external write; it never drops one.

**Verified** on the dev server (:7537): text typed while a composition was held
open survived the flush intact (no missing words, no doubled spaces) and the
draft store converged to the editor's full text, so a send ships the spoken
words rather than the stale echo. Mention insertion still rewrites and restores
the caret. 12 unit tests in `composerDictationSync.test.ts`; full web suite at
the known-red baseline (7 failures in `branding` + `previewAutomationRequestConsumer`).

## Addendum 8 — Preview guests no longer mount for every thread at boot

**Symptom.** The app ran slowly under load with no matching work on the UI
thread. Measured on the installed 0.1.394: one preview renderer held a full CPU
core indefinitely and the GPU process sat around 50%, while the app's own
renderer was idle (0 React commits over 8s on the heaviest thread).

**Cause.** `ElectronBrowserHost` mapped over _every_ thread's hosted sessions
and mounted a live `<webview>` for each, unconditionally, at startup. A guest is
a full renderer process running a real page. This workspace had 18 persisted
preview sessions — including a two-hour YouTube video, an Instagram reel, TikTok
Studio, a Suno playlist and two local game servers — so every launch quietly
resumed all of them offscreen.

Native `sample` confirmed the shape: the hot renderer was pure JIT with no
paint, GC or WebGL frames, i.e. a guest page's own JavaScript, unrelated to
Solla's UI.

**Fix.** Guests now mount on demand.

- `apps/web/src/browser/previewGuestMountPolicy.ts` — a thread's guests mount
  only when that thread is demanded.
- `apps/web/src/browser/previewGuestDemandStore.ts` — session-scoped demand
  (deliberately not persisted, so a fresh launch starts with none running), plus
  attach tracking and `waitForPreviewGuestAttached`.
- Opening a thread demands it (`_chat.$environmentId.$threadId`).
- **Agents keep full access**: every automation request demands its thread on
  entry, and `requireReadyTab` waits (up to 10s) for the guest to attach before
  driving it. An agent can still reach a tab the user has never opened.

Demand is sticky for the session, so switching back to a thread is instant and
nothing unmounts a guest that has already earned its place (which would drop a
page's login or in-page state). Background _rendering_ is unchanged — parked
guests still render and stay drivable, per Addendum 5; what is removed is the
boot-time fleet.

**Verified**: full web suite at the known-red baseline (7 failures in `branding`

- `previewAutomationRequestConsumer`, unchanged from before the change);
  typecheck adds no errors; 6 unit tests in `previewGuestMountPolicy.test.ts`.
