# Grok Voice for the orchestrator

The orchestrator can speak through [xAI's Speech-to-Speech API](https://docs.x.ai/developers/model-capabilities/audio/speech-to-speech) as well as OpenAI Realtime. Grok is a second voice backend, not a replacement for the Grok CLI coding provider.

## Setup

1. Create an API key at [console.x.ai](https://console.x.ai/).
2. In **Settings → Orchestrator**, set **Voice provider** to **Grok (xAI)**.
3. Paste the key into **Grok Voice API key** and save it. The key is stored on the server only.
4. Pick a Grok Voice model (`grok-voice-latest` is the default) and a voice (`eve` is the default).
5. Enable the orchestrator and start voice as usual.

If no key is saved, the server will use the `XAI_API_KEY` environment variable when it is set. That is the same variable the Grok CLI uses, so a machine that already runs Grok as a coding provider can start voice without pasting the key again. A saved orchestrator key still wins.

OpenAI and Grok Voice keys have separate Settings fields and separate server-side secret slots. You can configure both once and switch **Voice provider** at will; changing providers does not replace or clear the other credential. A key saved by an older build in the former shared field is migrated to whichever provider that settings file selected.

## Environment variables

| Variable      | Required | Role                                                                 |
| ------------- | -------- | -------------------------------------------------------------------- |
| `XAI_API_KEY` | No       | Fallback long-lived key when Settings has no stored orchestrator key |

There is no URL override. Sessions always use `https://api.x.ai/v1/realtime/client_secrets` and `wss://api.x.ai/v1/realtime`.

## What the server does

The long-lived key never reaches a client. The server mints a short-lived client secret with `POST /v1/realtime/client_secrets` (`expires_after.seconds = 600`) and returns that secret plus the WebSocket URL. The browser authenticates with the `xai-client-secret.` WebSocket subprotocol, as [xAI's ephemeral token docs](https://docs.x.ai/developers/model-capabilities/audio/ephemeral-tokens) require.

Model is a query parameter on the WebSocket. Voice, instructions, tools, turn detection, language hint, and PCM format are sent on `session.update`.

## Limitations

- **Transport.** Grok Voice is WebSocket + PCM16. OpenAI stays on WebRTC. Echo cancellation and barge-in therefore depend more on the client on Grok than they do on OpenAI.
- **Turn taking.** Grok's server VAD ends a user turn sooner than OpenAI at the same pause length, and it often transcribes the first words after it has already fired `speech_stopped`. The session asks Grok to wait 2.8s of silence (OpenAI is 2.2s), then holds 1.2s more on the client before the "received" click. The "heard you" click still fires on the first transcript unless VAD has already closed the floor - a 4s server silence made turns never close, so the orb stayed on listening. Streaming `.updated` transcripts are committed on that 1.2s settle even when Grok never sends `speech_started` or a final `.completed`; if VAD never opened a turn, the client asks for the reply itself.
- **Capture.** Grok is WebSocket + PCM. The capture track stays enabled for the whole session so Chromium's `MediaStreamAudioSourceNode` does not go permanently silent; audio is withheld until `session.updated` (and during half-duplex playback) in the PCM sender instead of by muting the track.
- **Usage estimates.** The orchestrator usage table is still token-based and tuned to OpenAI rates. xAI bills voice by the minute. Dollar figures may be missing or wrong for Grok sessions; token counts only appear if the API sends a usage block.
- **Language hints.** xAI rejects bare `es` and `pt`. The app maps those to `es-MX` and `pt-BR`.
- **Custom voices.** An 8-character xAI custom voice id is accepted. It is not listed in the picker until you type it once and save it.

## Capability flags

Registered in `packages/contracts/src/orchestratorVoice.ts` as `ORCHESTRATOR_VOICE_PROVIDERS.xai.capabilities`:

- `voice`, `ephemeralClientSecrets`, `serverVad`, `functionTools`, `reasoningEffort`, `customVoices`
- `transport: "websocket"`
