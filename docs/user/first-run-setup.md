# First-run setup

A new Solla Code environment opens a two-step provider setup before anything else. You can skip
either step; nothing in the app waits on it.

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

## Default model for new projects

A new project starts on the first ready provider in the app's order: Codex, Claude, Cursor, Grok,
OpenCode, Antigravity, Deep Code, Muse Code, then Kimi Code. Change it from the model picker in
the composer at any time.

## Coming back to setup

Until you add your first project, the Getting Started page offers **Set up providers** (or **Add
providers** once an account is connected) to reopen setup. **Settings → Providers** has the same
controls at any time: the on/off switch, install, sign in, and account switching.

The mobile app does not show provider setup; it uses the providers already configured on the
computer it connects to.
