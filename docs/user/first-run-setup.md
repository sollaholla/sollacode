# First-run setup

A new Solla Code environment opens a short setup before anything else: choose your AI tools, choose
a few preferences, then a quick tour. Every part can be skipped and nothing in the app waits on it.
Setup fills the window so there is one thing to look at.

## Step 1: choose your AI providers

Solla Code lists the built-in providers and checks this computer for each one. Providers that are
already installed start checked, and signed-in accounts show their email. Cursor stays off until you
turn it on, so it shows **Not checked while off**.

Select **Continue** to turn on exactly the providers you checked and turn the rest off. Providers
that are off are not checked in the background. **Skip setup**
leaves every provider as it was.

## Step 2: sign in

Each chosen provider shows what it still needs:

- **Install** runs the provider's one-click installer when this computer supports one. Otherwise
  the row shows the install command to copy.
- **Sign in** opens the provider's own sign-in (Codex, Claude, Antigravity, and Muse Code) without
  leaving Solla Code.
- Providers that sign in from a terminal (Grok, Kimi Code, OpenCode) show the exact command to copy.
  Run it on the computer running Solla Code, then select **Check again**. Solla Code also re-checks
  when you return to the window.
- Providers without either flow, such as Deep Code's API key, show **Open Settings** to finish in
  **Settings → Providers**.

Select **Done** when every provider is ready, or **Finish later** to stop here. Either choice is
saved on the computer running Solla Code, so setup does not open again on other devices or after a
restart.

## Preferences

**Make it yours** shows a few real settings on one screen. Each change applies straight away, so
**Skip** only skips the rest of the screen and anything you already changed stays changed.

| Choice          | What it does                                                        | Starts |
| --------------- | ------------------------------------------------------------------- | ------ |
| Auto/Light/Dark | The app's colors. Auto follows your computer.                       | Auto   |
| Agents          | AI helpers for repeat jobs.                                         | On     |
| Voice assistant | Talk to the app. Finish its setup in **Settings → Orchestrator**.   | Off    |
| Usage bar       | Shows how much of your AI plan is left.                             | On     |
| Agent alerts    | A notification when an agent needs you. Asks your permission first. | Off    |
| Sounds          | Short tones for voice and calls.                                    | On     |

These are the same settings you find in **Settings**. **Agent alerts** does not appear where the
browser has no notifications.

## The tour

Six short steps, one idea each, with a small moving picture:

1. Start with a folder
2. Ask in plain words
3. Choose your AI
4. Each task is a thread
5. Find anything
6. Agents work on their own

Use **Next** and **Back**, the arrow keys, or swipe on a phone. **Skip** or Escape ends it at any
step, and the small replay icon beside the title plays that step's picture again. **Back** on the
first step returns to your preferences.

If you close the app partway through, setup reopens where you stopped on that device. Finishing or
skipping is saved on the computer running Solla Code, so the tour does not appear again on your other
devices. With **Reduce motion** turned on in your system settings, each step shows its finished
picture without moving.

## Replaying the tour

- **Settings → General**, under **About**: select **Replay** beside **Welcome tour**.
- The command palette: search for **Replay the welcome tour**.

Replaying opens over what you were doing and returns you there, and it changes no settings.

## Default model for new projects

A new project starts on the first ready provider in the app's order: Codex, Claude, Cursor, Grok,
OpenCode, Antigravity, Deep Code, Muse Code, then Kimi Code. Change it from the model picker in
the composer at any time.

Claude and Codex list their models newest version first, then by name. A manual order you set in
Settings still comes first.

## Coming back to setup

Until you add your first project, the Getting Started page offers **Set up providers** (or **Add
providers** once an account is connected) to reopen setup. **Settings → Providers** has the same
controls at any time: the on/off switch, install, sign in, and account switching.

Setup only appears on an environment with no projects, so anyone already working in Solla Code does
not see it after an update.

The mobile app does not show provider setup, preferences, or the tour; it uses what is already
configured on the computer it connects to. Opening Solla Code in a phone's browser shows the same
setup as the desktop.
