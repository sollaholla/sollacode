import * as Schema from "effect/Schema";

import { ModelSelection } from "./orchestration.ts";

export const VoiceTranscriptCorrectionInput = Schema.Struct({
  cwd: Schema.String,
  transcript: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(8_000)),
  conversationContext: Schema.String.check(Schema.isMaxLength(12_000)),
  modelSelection: ModelSelection,
});
export type VoiceTranscriptCorrectionInput = Schema.Codec.Encoded<
  typeof VoiceTranscriptCorrectionInput
>;

export const VoiceTranscriptCorrectionResult = Schema.Struct({
  transcript: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(8_000)),
});
export type VoiceTranscriptCorrectionResult = typeof VoiceTranscriptCorrectionResult.Type;
