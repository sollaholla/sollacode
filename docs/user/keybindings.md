# Keybindings

Solla Code reads keybindings from:

- Packaged desktop: `~/.solla-code/userdata/keybindings.json`
- Standalone source server: `~/.t3/userdata/keybindings.json`
- Development: `<stateDir>/keybindings.json` (see [state directories](../reference/fork-identity.md#state-directories))

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

Hold **Cmd+D** on macOS or **Ctrl+D** on Windows and Linux, or hold the microphone
button, to record a voice note. Releasing it adds a playable attachment to the current draft.
The text field stays separate: add written instructions, remove the recording, or send them
together. Voice notes are never automatically submitted by the automatic dictation setting.

When you press **Send**, the connected host transcribes the recording. The sent message keeps
its audio player and a collapsible **Transcribed** chip. Providers receive an explicitly labeled
voice transcript followed by your typed text, plus the original recording's host file path.
This also works with text-only coding providers; it does not require native model audio support.

Apple Silicon desktop hosts prepare a high-quality [Parakeet speech model](https://huggingface.co/mlx-community/parakeet-tdt-0.6b-v3) automatically in the
background. This one-time download includes a private runtime and approximately 2.3 GB of model
data; it survives app updates. Recordings use the prepared model locally. During setup, or if that
model is unavailable, macOS uses Apple's on-device speech recognizer. Windows uses its installed
speech recognizer. The remaining fallback is the local CPU model `onnx-community/distil-small.en` at revision
`69be759f982d1d4c5b8a987d4140752742619bd0`. The fallback downloads once into the host's
voice-model cache. The recording is not uploaded to a cloud transcription service. On a remote
connection, the host is the computer running Solla Code, rather than the phone recording the note.
Transcription can still mishear names or ambiguous words; the retained recording lets you check
the original speech.

The model is NVIDIA Parakeet TDT 0.6B v3, converted for MLX by MLX Community and provided under
[CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). Solla downloads the pinned model without
changing its weights.

Microphone permission is requested on first use. Releasing the shortcut, losing window focus,
or reaching approximately two minutes stops recording. Audio preparation and host transcription
have bounded deadlines. If preparation or transcription fails, the note stays in the unsent draft
and the error is shown. Only one host transcription runs at once; a simultaneous send reports
that the host is busy so the recording can be retried.

While recording in the desktop app, Solla Code temporarily mutes device playback and restores it
when recording ends. Microphone input is unavailable while answering a structured provider question;
use that question's text controls. The iOS keyboard's own dictation still edits the text field normally.

Terminal dictation continues to insert recognized text into the terminal. Its optional contextual
correction applies to that text workflow. They do not rewrite or submit
chat voice notes. Native mobile clients can play received recordings and expand their transcripts;
recording a new note is currently available in desktop and supported web browsers.

**Cmd+D** and **Ctrl+D** are reserved exclusively for voice input and cannot be assigned to
configurable commands. Existing command rules using `mod+d` are removed during startup.

## Configuration

### Rule Shape

Each entry supports:

- `key` (required): shortcut string, like `mod+j`, `ctrl+k`, `cmd+shift+d`
- `command` (required): action ID
- `when` (optional): boolean expression controlling when the shortcut is active

Invalid rules are ignored. Invalid config files are ignored. Warnings are logged by the server.

### Available Commands

- `terminal.toggle`: open/close terminal drawer
- `terminal.splitVertical` and `terminal.splitHorizontal`: split the focused terminal vertically or horizontally
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
