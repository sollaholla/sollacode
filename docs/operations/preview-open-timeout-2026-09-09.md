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

Installed runtime verification follows in this record after packaging 0.1.501.
