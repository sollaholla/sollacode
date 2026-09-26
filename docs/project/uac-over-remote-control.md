# Answering UAC over remote control (Windows)

Status: **A shipped in 0.1.527. B designed, not built** — it needs to land with the
Windows machine present.

## The constraint

UAC consent, the lock screen, and Ctrl+Alt+Del run on a separate desktop object,
`WinSta0\Winlogon`. A thread can only capture or inject on the desktop it is attached to,
and attaching to that one requires SYSTEM. This is exactly what stops malware from
clicking "Yes" for you, so it is Windows working correctly rather than a gap to patch.

Both halves of remote control break on it, for that one reason:

- **Input** — `BlockReason()` in `apps/desktop/src/app/RemoteInput.ts` returns
  `secure-desktop` when the input desktop is not `Default`, and it is the one refusal the
  product keeps. Injecting anyway would not reach the prompt; `SendInput` would succeed
  against our own desktop and deliver the keystrokes to whatever window was focused
  there — an admin password typed in the clear into another app.
- **Screen** — capture runs through Electron `desktopCapturer` in the Solla process, which
  is attached to `Default`. A desktop switch invalidates the duplication surface, which is
  why the viewer normally sees `capture-interrupted` while a prompt is up.

RDP does not solve this; it sidesteps it by running the session it renders. TeamViewer and
AnyDesk do solve it, with a SYSTEM service. That is the real price.

## A — make the prompt visible (shipped)

`PromptOnSecureDesktop = 0` under
`HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\System` makes UAC draw on the
ordinary desktop, where normal capture sees it.

The host now reads that value (`Get-SecureDesktopPrompt`, cached 30 s, defaulting to "on"
when absent or unreadable) and reports it as `secureDesktopPrompt` on the host status. The
viewer appends the remedy **only** when the value is `true` — when it is already `false`, a
block means the lock screen, Ctrl+Alt+Del, or UIPI, and naming the setting would be a dead
end.

Deliberately explanation, not a button: the change weakens UAC, needs administrator rights
on that machine, and the elevation prompt it raises lands on the very desktop the session
cannot reach. It is a decision to make at the computer.

**Open question A cannot answer from here:** whether input reaches the prompt once it is
visible. `consent.exe` runs at System integrity and UIPI discards input from below it, even
from an elevated Solla. Reports on this configuration are mixed and it is untested on the
owner's box. If clicks do not land, the remedy buys visibility only — and B is required for
the rest.

## B — a SYSTEM helper on the secure desktop (designed)

The only route to parity without weakening UAC.

**Shape.** A Windows service running as LocalSystem, installed once with an explicit admin
consent. On a desktop switch it spawns a helper into the active session with
`CreateProcessAsUser` and `STARTUPINFO.lpDesktop = "WinSta0\\Winlogon"`, which captures
that desktop and injects into it. Frames and input ride the existing broker relay; nothing
in the transport or the viewer changes.

**Install model (owner's decision, 2026-09-11):** opt-in, prompted on first UAC. Ships
dormant; the first time a `secure-desktop` block interrupts a session, Solla offers to
install the helper with one admin consent. Nothing privileged exists until asked for.

**Greenfield.** There is no service or elevation infrastructure in the product today — no
`sc.exe`, `New-Service`, `CreateProcessAsUser`, or runas anywhere. B adds a privileged
component, an install step, and a code-signing consideration.

**Why it is not built blind.** A wrong keyboard table types a wrong character. A wrong
SYSTEM helper hangs the logon desktop, which is the unrecoverable-remotely version of the
"locks me out completely" failure this product already decided never to inflict. It should
land while the machine can be watched.

**Risks to design against:** never leave a thread attached to the Winlogon desktop after a
switch back; the helper must die with the session, not outlive it; capture on the secure
desktop must fail closed (a black frame, never a stale frame of the ordinary desktop, which
would misrepresent what the owner is approving); and the service must refuse to inject when
it cannot confirm which desktop is actually foreground.

See `remote-input-never-refuses-for-you` and `solla-remote-exposure-posture` in memory.
