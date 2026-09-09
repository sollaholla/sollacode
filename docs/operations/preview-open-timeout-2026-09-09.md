# Preview open timeout during Microsoft sign-in

The Outlook sidechat's `preview_open` request for `https://entra.microsoft.com`
timed out after 15 seconds on Mac 0.1.500. A separate reproduction in the maintainer
thread also timed out despite creating a usable tab that reached Microsoft's sign-in
page. A subsequent status returned the tab; closing it timed out because the unfinished
open held the thread's lifecycle queue.

Open readiness and result assembly included optional renderer viewport measurements and
page diagnostics without their own deadlines. Navigation can leave those promises pending.
Native viewport measurement and web-host optional diagnostics now have 750 ms deadlines.
A missing measurement is omitted; a known human-verification gate is preserved. This does
not change input admission, popup handling, navigation readiness, or the tool's 15-second
request limit.

Focused validation: 106 tests across desktop PreviewManager, open readiness, and diagnostic
deadline tests passed. The native regression uses a renderer whose viewport query never
resolves. Web helper tests cover successful completion, a stalled renderer, and a late
navigation rejection after fallback. Desktop and web typechecks and scoped lint passed.

Installed Mac 0.1.501 passed both fresh Microsoft opens: background opening returned
`outcome: created`, a tab ID, `available: true`, and the Microsoft sign-in title in
1,104 ms. The exact reported `open: true, show: true, reuseExistingTab: false`
arguments returned in 980 ms. The next close completed in 64 ms, and status confirmed
no remaining test tabs. The sidechat's separate Chrome sign-in session was untouched.
The app remained HTTP 200 after these checks.

The installed main bundle SHA-256 is
`4ae4594f3ae49cbf21eb6b614920849543bf2b238d8f1c5b93019b07af990310`.
The guest preload remains byte-identical to the user-confirmed Pinterest popup build:
`db3d97bfc3599d16e75980070c9c636d09f21aecec588d5f96c82b51a6d0c381`.

Windows 0.1.501 passed the guarded stable-startup check and an independent readback:
installed and server versions 0.1.501, interactive root PID 42348 in session 1,
backend listener PID 39048, `--auto-resume`, and HTTP 200. Its installed main and
guest-preload hashes match the Mac values above. The Microsoft open/close runtime
reproduction was performed on macOS; Windows verification covered the shipped
payload and stable application/backend startup.
