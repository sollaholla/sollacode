import {
  DesktopVoiceTranscriptionInputSchema,
  DesktopVoiceTranscriptionResultSchema,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as DesktopEnvironment from "../../app/DesktopEnvironment.ts";
import { transcribeMacVoice } from "../../voice/MacSpeechTranscription.ts";
import * as IpcChannels from "../channels.ts";
import * as DesktopIpc from "../DesktopIpc.ts";

export const transcribeVoice = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.TRANSCRIBE_VOICE_CHANNEL,
  payload: DesktopVoiceTranscriptionInputSchema,
  result: DesktopVoiceTranscriptionResultSchema,
  handler: Effect.fn("desktop.ipc.voiceTranscription.transcribe")(function* (input) {
    const environment = yield* DesktopEnvironment.DesktopEnvironment;
    return yield* Effect.promise(() => transcribeMacVoice(input, environment));
  }),
});
