# Keybindings

Solla Code reads keybindings from:

- `~/.t3/keybindings.json`

The file must be a JSON array of rules:

```json
[
  { "key": "mod+g", "command": "terminal.toggle" },
  { "key": "mod+shift+g", "command": "terminal.new", "when": "terminalFocus" }
]
```

See the full schema for more details: [`packages/contracts/src/keybindings.ts`](../../packages/contracts/src/keybindings.ts)

## Defaults

```json
[
  { "key": "mod+j", "command": "terminal.toggle" },
  { "key": "mod+shift+d", "command": "terminal.splitVertical", "when": "terminalFocus" },
  { "key": "mod+n", "command": "terminal.new", "when": "terminalFocus" },
  { "key": "mod+w", "command": "terminal.close", "when": "terminalFocus" },
  { "key": "mod+shift+j", "command": "preview.toggle" },
  { "key": "mod+r", "command": "preview.refresh", "when": "previewFocus" },
  { "key": "mod+l", "command": "preview.focusUrl", "when": "previewFocus" },
  { "key": "mod+=", "command": "preview.zoomIn", "when": "previewFocus" },
  { "key": "mod+-", "command": "preview.zoomOut", "when": "previewFocus" },
  { "key": "mod+0", "command": "preview.resetZoom", "when": "previewFocus" },
  { "key": "mod+k", "command": "commandPalette.toggle", "when": "!terminalFocus" },
  { "key": "mod+n", "command": "chat.new", "when": "!terminalFocus" },
  { "key": "mod+shift+o", "command": "chat.new", "when": "!terminalFocus" },
  { "key": "mod+shift+n", "command": "chat.newLocal", "when": "!terminalFocus" },
  { "key": "mod+o", "command": "editor.openFavorite" }
]
```

For most up to date defaults, see [`DEFAULT_KEYBINDINGS` in `apps/server/src/keybindings.ts`](../../apps/server/src/keybindings.ts)

## Push to talk

Hold **Cmd+D** on macOS or **Ctrl+D** on Windows and Linux while a send-capable chat composer is
open. Solla Code records for the full time the shortcut is physically held and begins its input
cooldown only after the key is released. It then transcribes the recording locally. With automatic
voice sending off, the text is inserted into the draft and a one-line result chip appears above the
composer; hover or focus expands the full transcript, **Send** submits it, and the close button
dismisses the chip. If you leave that chat before transcription finishes, a notification in the
upper-right shows a preview of the transcript with **Send**, so you can submit it without going
back. With automatic sending on, the completed transcript is sent immediately. The
microphone button beside the composer provides the same behavior. Sent voice messages show a
**Transcribed** badge at the bottom-left of the user bubble.

On current macOS releases, Solla Code first uses Apple's on-device SpeechAnalyzer. Other clients,
and Macs where that API is unavailable, download the quantized `onnx-community/distil-small.en`
model at pinned revision `69be759f982d1d4c5b8a987d4140752742619bd0` and retain it in the
browser or Electron cache. Local model inference does not use the selected coding provider. The
fallback model's first use therefore requires internet access, while subsequent use can work from
the cache.

Microphone permission is requested on first use. Losing window focus stops the recording, as does
releasing the key. Recordings are capped at two minutes. If microphone recording, audio decoding,
the one-time model download, or local inference is unavailable, the composer remains unchanged
and Solla Code shows an error instead of sending an unverified transcript.

While push-to-talk is active, Solla Code temporarily mutes device playback so a notification,
video, or another tab cannot be transcribed back into the composer. The mute is scoped to the
recording and is released on either half of the shortcut chord, a real window blur, page hide,
timeout, cancellation, or teardown. A composer re-render or an arriving message does not end the
recording or steal its insertion target; focus returns to the original input when recording ends.

**Settings → General → Contextual transcription correction** can pass a completed local transcript
through a fast Utility AI model before insertion. The status changes from **Transcribing…** to
**Refining…** while that pass runs. Correction receives only a bounded recent-conversation snapshot,
has a twenty-second deadline, and falls back to the local transcript on any timeout, provider
failure, or implausible rewrite. A dedicated model can be selected there; when the override is off,
correction uses the global **Utility AI model**.

**Cmd+D** and **Ctrl+D** are reserved exclusively for voice transcription and cannot be assigned
to configurable commands. Existing command rules using `mod+d` are removed during startup.

The microphone action remains available beside plan-question **Next/Submit** controls and plan
follow-up **Refine/Implement** controls. Dictation is inserted into whichever input is visibly
active. In particular, a plan question receives the transcript as its custom answer rather than
leaving the text in the conversation draft behind the question. When automatic voice sending is
enabled, Solla Code waits for that answer update to render before advancing or submitting it.

## Configuration

### Rule Shape

Each entry supports:

- `key` (required): shortcut string, like `mod+j`, `ctrl+k`, `cmd+shift+d`
- `command` (required): action ID
- `when` (optional): boolean expression controlling when the shortcut is active

Invalid rules are ignored. Invalid config files are ignored. Warnings are logged by the server.

### Available Commands

- `terminal.toggle`: open/close terminal drawer
- `terminal.split`: split terminal (in focused terminal context by default)
- `terminal.new`: create new terminal (in focused terminal context by default)
- `terminal.close`: close/kill the focused terminal (in focused terminal context by default)
- `preview.toggle`: open/close the in-app browser preview panel (desktop app only)
- `preview.refresh`: reload the active preview tab (in focused preview context by default)
- `preview.focusUrl`: focus the URL input of the preview panel (in focused preview context by default)
- `preview.zoomIn`: zoom the preview viewport in one step (in focused preview context by default)
- `preview.zoomOut`: zoom the preview viewport out one step (in focused preview context by default)
- `preview.resetZoom`: reset the preview zoom to 100% (in focused preview context by default)
- `commandPalette.toggle`: open or close the global command palette
- `chat.new`: create a new chat thread preserving the active thread's branch/worktree state
- `chat.newLocal`: create a new chat thread for the active project in a new environment (local/worktree determined by app settings (default `local`))
- `editor.openFavorite`: open current project/worktree in the last-used editor
- `script.{id}.run`: run a project script by id (for example `script.test.run`)

`filePicker.toggle` opens file search for the active project and defaults to `mod+p`.
`projectSearch.toggle` searches inside the active project's files and defaults to `mod+shift+f`.
Repeating either shortcut closes that search, and switching shortcuts replaces the open search.

The command palette searches active thread titles, projects, branches, user messages, and final
agent responses across connected environments. Message matches show one labeled excerpt while
keeping the thread's project, branch, and machine context visible. Message search begins after two
characters and uses SQLite's ASCII case-insensitive matching.

### Key Syntax

Supported modifiers:

- `mod` (`cmd` on macOS, `ctrl` on non-macOS)
- `cmd` / `meta`
- `ctrl` / `control`
- `shift`
- `alt` / `option`

Examples:

- `mod+j`
- `mod+shift+d`
- `ctrl+l`
- `cmd+k`

### `when` Conditions

Currently available context keys:

- `terminalFocus`
- `terminalOpen`
- `previewFocus`
- `previewOpen`

Supported operators:

- `!` (not)
- `&&` (and)
- `||` (or)
- parentheses: `(` `)`

Examples:

- `"when": "terminalFocus"`
- `"when": "terminalOpen && !terminalFocus"`
- `"when": "terminalFocus || terminalOpen"`

Unknown condition keys evaluate to `false`.

### Precedence

- Rules are evaluated in array order.
- For a key event, the last rule where both `key` matches and `when` evaluates to `true` wins.
- That means precedence is across commands, not only within the same command.
