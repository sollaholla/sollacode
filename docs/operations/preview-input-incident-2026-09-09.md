# Preview input and native crash investigation, 2026-09-09

## Confirmed input failures

Mac 0.1.489 compared Electron mouse widget coordinates directly with CDP CSS coordinates.
A native Electron 41.5.0 probe observed a CDP click at (120, 80) reported as (96, 64) at
80% zoom, (150, 100) at 125%, and (180, 120) at 150%. DOM pointer coordinates remained
(120, 80). The mismatch incremented the human-control epoch during automation's own mouse-down.
The correction divides native coordinates by the guest zoom factor before matching. It preserves
real user ownership and interruption. Four zoom variants cover both agent and user clicks.

The installed normal preview harness reproduced the reported interruption on a disposable,
thread-owned about:blank page in 0.1.489. In installed 0.1.490, both a role locator click and
coordinate click succeeded on that same fixture. The Resend campaign was never operated here.

The subsequent normal preview_type call exposed a separate pre-existing defect: a whole string
was sent as Input.dispatchKeyEvent type char. Chromium rejected it with Invalid 'text' parameter.
The correction emits Unicode code points separately, renewing the attribution window at bounded
intervals rather than creating a timer per character. LF is translated to native CR; CRLF input
is normalized. A native Electron textarea probe read back plain text, emoji, accented text, and
multiline text. Existing focus restoration, clear-key release, and interruption paths remain tested.

## Native crash evidence and cleanup correction

The macOS report Solla Code-2026-09-09-094253.ips records version 0.1.490, PID 27682,
EXC_BAD_ACCESS/SIGSEGV on CrBrowserMain at 09:42:49 -0400. This was separate from the
planned update restart at 09:41:34–09:41:51. The replacement app was already responding when
investigated.

The official Electron 41.5.0 arm64 Breakpad symbol UUID matched the crashed framework UUID
4c4c44a2-5555-3144-a1a4-3984082119ef. Symbolication places the top frame at
content::DevToolsSession::DispatchProtocolNotification +112. Disassembly and register state show
a null client vtable load at address 0x10 during notification dispatch. The desktop trace records
guest destruction and control-session cleanup at 13:42:44.669 UTC, shortly before the crash.

An isolated native probe confirmed that a retained Electron Debugger can still report isAttached()
true after BrowserWindow.destroy(), and that the retained handle can safely detach at that point.
Solla's old finalizer skipped this detach twice: an explicit destroyed-guest return and the generic
WebContents liveness guard. The correction retains the Debugger handle for the control session and
cleans it independently of the dead WebContents wrapper. It never attaches to or calls methods on
a destroyed guest. The regression makes the dead guest's debugger getter throw and requires
listener removal and native detach through the retained handle.

Forty isolated teardown cycles with explicit cleanup completed successfully. The simple baseline
teardown stress also completed; it did not reproduce the exact native crash. This establishes a
real cleanup defect and a targeted mitigation consistent with the crash evidence, not proof that
all native crashes are eliminated or that a memory leak caused this crash. A live post-install
check remains a separate proof step.

## Source references

- [Electron mouse event conversion](https://github.com/electron/electron/blob/v41.5.0/shell/common/gin_converters/blink_converter.cc)
- [Electron Debugger lifecycle](https://github.com/electron/electron/blob/v41.5.0/shell/browser/api/electron_api_debugger.cc)
- [Chromium notification dispatch](https://github.com/chromium/chromium/blob/146.0.7680.216/content/browser/devtools/devtools_session.cc)

## Focused checks

Run node_modules/.bin/vitest run apps/desktop/src/preview/Manager.test.ts
apps/desktop/src/preview/userInputDeferral.test.ts (one command). Result: 111 passed.
Desktop tsgo --noEmit and targeted lint passed. Installed input readback is required separately;
a mocked debugger accepting a too-long character payload previously concealed the real failure.
