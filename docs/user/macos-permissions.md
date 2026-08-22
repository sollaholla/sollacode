# macOS permissions

The macOS desktop app shows a permission setup screen once before it starts any automatic agent
resume. The screen checks existing status without opening a system prompt. A native prompt appears
only after you select **Enable**.

You can skip setup and return at any time through **Settings → Permissions**. macOS owns the actual
switches, so **Manage** opens the corresponding **System Settings → Privacy & Security** pane for
granting or revoking access.

## Permissions Solla Code uses

- **Full Disk Access** is recommended for unrestricted local agent work. Without it, macOS may block
  or prompt separately for Desktop, Documents, Downloads, another app's data, or other protected
  files when a command traverses them. Solla Code checks this grant by opening and immediately
  closing a read-only handle to the protected TCC database; it reads or retains none of its contents.
- **Microphone** is optional and used only for push-to-talk and voice orchestrator conversations you
  start.
- **Screen Recording** is optional and used only when you approve remote screen viewing or control.
- **Accessibility** is optional and used only to send keyboard and pointer input during an approved
  remote-control session.

Solla Code does not request Camera, Contacts, Calendars, Photos, Reminders, or other personal-data
permissions because its built-in features do not use them. A command or third-party tool an agent
runs can still have its own macOS permission requirements; those remain separate and appear only
when that tool is used.

Solla Code also does not request Apple Music access as a built-in permission. A broad filesystem
command can encounter the protected Music library and make macOS display that fallback prompt when
Full Disk Access is not effective for the running app. The fix is to restore Full Disk Access for the
current signed app, not to grant every personal-data category individually.

## After changing a grant

Full Disk Access, Screen Recording, Accessibility, and a previously denied Microphone grant can
require a complete process restart before macOS applies the change. Reloading the window is not
enough. Use **Restart Solla Code** on the permission screen; it arms the replacement process before
teardown, has a deadline for stuck teardown, and carries the auto-resume signal into the new launch.

If you decline Full Disk Access, projects chosen explicitly through Solla Code's folder picker remain
the narrowest way to communicate which files you intend the app to use. Purpose text is included for
Desktop, Documents, Downloads, network volumes, and removable volumes if macOS presents a fallback
folder prompt.

Local macOS artifacts prefer an installed Apple Development code-signing identity. This gives the
bundle a stable designated requirement, but macOS can still pin sensitive local-development grants
to a particular build's CDHash. If no stable identity is available, packaging falls back to ad-hoc
signing and prints a warning because every changed CDHash is a different app. Set
`T3CODE_MACOS_LOCAL_SIGNING_IDENTITY` to choose a specific local certificate.

If Full Disk Access appears enabled in System Settings but Solla Code reports it unavailable, remove
the existing Solla Code entry, add the current `/Applications/Solla Code.app`, and restart. For
Screen Recording or Accessibility, turn the current Solla Code entry off and on, then restart from
the permission screen. The visible switch can otherwise represent a stale grant for an older build
while macOS denies the running process.
