# Preview Google sign-in and responsive sizing — 2026-09-09

## Causes and changes

Pinterest's Google iframe advertises `is_fedcm_supported=true` under Electron 41.5.0.
The current page reported `IdentityCredential` as a function and logged repeated
`FedCM get() rejects with NetworkError: Error retrieving a token` and prompt-dismissed errors.
Electron does not override Chromium's default identity-dialog controller, which dismisses
requests rather than showing browser UI. Preview webPreferences now disable `FedCm`
through the native Blink feature setting so authentication libraries can choose their
normal OAuth popup fallback. This does not rewrite third-party authentication code,
URLs, credentials, or responses.

Sources: [Electron browser client](https://github.com/electron/electron/blob/v41.5.0/shell/browser/electron_browser_client.h),
[Chromium default identity dialog](https://github.com/chromium/chromium/blob/main/content/public/browser/webid/identity_request_dialog_controller.cc).

Responsive guest sizing used a timed feedback loop to compensate for the desktop
embedder's zoom, but the visible transform ignored that compensation. The larger
guest therefore extended past its frame and resize handles. The loop also raced
initial guest attachment and snapshot staging, causing overshoot and resize timeouts.

The desktop bridge now exposes Electron webFrame's actual embedder zoom. Host size
uses its reciprocal directly; the presentation transform applies the inverse so
page CSS dimensions and visual rails agree. There is no measurement loop or startup
calibration. The getter is optional for compatibility with older desktop shells.

## Verification

- 133 focused tests passed across viewport compensation/layout, webview preferences,
  popup manager, toolbar, and serialized resize actions.
- Web and desktop typechecks passed (existing Effect suggestions only); scoped lint passed.
- Native Electron 41.5.0 isolated fixture: at host zoom 0.9 and guest zoom 1, a
  390 × 844 element produced a 351 × 760 CSS viewport. Applying host compensation
  and inverse display scale produced 390 × 844 while retaining a 195 × 422 visible
  footprint at presentation scale 0.5. The unsupported IdentityCredential API was absent.
- Installed Mac 0.1.496 is healthy. The user confirmed Pinterest displays the Google
  popup and works properly. Live readback subsequently showed Pinterest's business
  creation page. Preserve that native preference fix; the experimental credentials
  wrapper was removed before shipping because the installed flow already works.
- Installed 0.1.497 exposed the timed calibration race during repeated hidden-tab
  resizing. Its replacement uses direct embedder zoom; final 0.1.498 runtime checks
  are pending.

## Surface coverage

The preference is shared by all desktop preview webviews on macOS, Windows, and Linux.
The hosted webview correction covers presets, responsive controls, dragging, and
thumbnail presentation. Remote web/mobile clients receive the same desktop guest and
its reported frame; the new optional desktop-only zoom getter does not change WebSocket schemas or provider adapters.

## Composer/guest input isolation follow-up

The user reported bidirectional text leakage while a long agent insertion overlapped
human typing. Native CDP character packets were routed through Chromium's currently
focused widget, and the action-wide key exemption hid physical input during a burst.

Text insertion now executes as one edit inside the selected guest document. It does
not call native focus, bring-to-front, synthetic mouse clicks, or keyboard dispatch.
The browser edit preserves normal input events and undo, reads the result back, and
fails if the field rejects it; there is no fallback to globally focused keyboard input.
Physical input updates an interruption generation synchronously. Input commands check
that generation before/after CDP calls, and admission checks again after remembering
app focus. Only an explicitly dispatched key is exempt from keyboard reclamation.
An edit already executing is atomic in the guest renderer; no remaining character
stream can migrate into the composer.

Native Electron 41.5.0 fixture using the exact production insertion expression passed
8,803-character Unicode/multiline insertion and clearing in textarea and contenteditable
fields while the host composer retained focus and its original contents. A contenteditable
trailing line break can have an extra rendering newline in innerText; exact readback was
verified with a non-newline final character. Manager regressions cover first-key
interruption during setup, no native input for text, and physical-key reclamation during
an agent action window. Installed follow-up verification is pending in 0.1.499.
