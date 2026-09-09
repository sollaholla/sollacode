# Windows transcription latency, September 9, 2026

## Findings

Windows desktop's transcription IPC called only `transcribeMacVoice`, which immediately returned unavailable on Windows. Every recording therefore used the 166M-parameter distilled Whisper fallback. Its pipeline specified no device, selecting WebAssembly even on a machine with a GPU. The ONNX Runtime version in this checkout defaults to one WASM thread when the page is not cross-origin isolated; Solla's desktop protocol does not supply the isolation headers. Model download, CPU inference, and an optional separate 20-second contextual correction pass are distinct sources of delay. We did not measure the user's previous microphone attempt, so there is no claimed before/after timing for that incident.

A fresh read-only SSH probe of the user's Windows machine confirmed build 26200, Ryzen 7 5800X, RTX 3080, and an installed `en-US` SAPI recognizer (`MS-1033-80-DESK`).

## Implementation

- Windows desktop routes the existing typed transcription IPC to a private, hidden PowerShell process using `System.Speech.Recognition.SpeechRecognitionEngine`. It recognizes a temporary WAV with `RecognizeMode.Multiple`, collecting all phrases through completion. It never opens another microphone or browser.
- The recognizer must match the requested locale. Missing engines, rejected speech, confidence below 0.60 on any phrase, process failure, and timeout return unavailable. The existing client retains the entire original audio for AI fallback; an uncertain partial native transcript is never inserted. Confidence is a heuristic, not a guarantee of accuracy.
- Native recognition gets five seconds plus 250 ms per audio second, capped at 30 seconds, with a three-second outer process allowance. Temporary audio is removed after process completion or failure. The helper and script ship inside the desktop bundle and require no new package installation.
- The same pinned, quantized AI model now prefers WebGPU. GPU loading or inference failure disposes the failed model and retries the same full recording once on WASM. Successful models remain cached; failed initializations no longer poison later recordings. CPU-only fallback still has the existing overall transcription deadline.

The Windows API choice follows Microsoft's [System.Speech file-recognition API](https://learn.microsoft.com/en-us/dotnet/api/system.speech.recognition.speechrecognitionengine.setinputtowavefile?view=netframework-4.8.1). The newer [Windows AI speech API](https://learn.microsoft.com/en-us/windows/ai/apis/speech-recognition) supports on-device transcription but documents MSIX packaging and model-readiness requirements. Solla currently ships an NSIS installer; migrating packaging is outside this fix.

## Verification

47 focused desktop/web tests passed, including GPU initialization/inference fallback, full-audio retry, model reuse, recovery after a failed CPU download, native response validation, and Windows time budgets. Desktop and web typechecks passed. Targeted lint reported only an existing unused catch-variable warning in `pushToTalk.ts`.

On the actual Windows machine, the production helper recognized a 3.724-second synthesized recording in 1.287 seconds including helper startup. An unsupported locale returned unavailable in 1.047 seconds, and temporary-audio cleanup passed. A longer, multi-phrase synthetic sample completed in about 2.4 seconds but failed the confidence threshold on one phrase, correctly returning unavailable for full-audio AI fallback. The successful short sample changed “and” to “in”; these timing checks do not establish human dictation accuracy.

No browser or computer-use verification was performed. Actual microphone-to-composer latency, GPU inference timing in the installed renderer, and subjective transcription accuracy remain unverified. The native timings are prerecorded-file tests, not live-microphone measurements.

## Surfaces

Windows desktop uses native-first recognition through the same IPC used by the composer, microphone button, keyboard shortcut, and terminal voice capture. macOS keeps its existing native recognizer. Web browsers and any desktop native failure use the accelerated AI worker; browser-native mobile dictation remains unchanged. The separate React Native app has its own capture implementation and was not changed. No wire contracts, account settings, paid services, or server-side provider adapters changed. Recognition runs on the client machine, including when connected to a remote environment.
