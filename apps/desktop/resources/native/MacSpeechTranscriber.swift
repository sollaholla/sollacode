import AVFoundation
import Foundation
import Speech

private enum TranscriptionError: LocalizedError {
  case unsupportedOperatingSystem
  case unsupportedLocale(String)

  var errorDescription: String? {
    switch self {
    case .unsupportedOperatingSystem:
      return "Apple native transcription requires macOS 26 or newer."
    case .unsupportedLocale(let identifier):
      return "Apple native transcription does not support locale \(identifier)."
    }
  }
}

private struct SuccessPayload: Encodable {
  let text: String
}

@available(macOS 26.0, *)
private func analyze(
  audioPath: String,
  contextualStrings: [String],
  module: any SpeechModule,
  resultTask: Task<[String], Error>
) async throws -> String {
  do {
    let audioFile = try AVAudioFile(forReading: URL(fileURLWithPath: audioPath))
    let context = AnalysisContext()
    if !contextualStrings.isEmpty {
      context.contextualStrings[.general] = Array(contextualStrings.prefix(100))
    }
    // The file initializer starts analysis immediately. Keep the analyzer alive
    // until its final results arrive so the native model is not cancelled early.
    let analyzer = try await SpeechAnalyzer(
      inputAudioFile: audioFile,
      modules: [module],
      options: .init(priority: .userInitiated, modelRetention: .processLifetime),
      analysisContext: context,
      finishAfterFile: true
    )
    let phrases = try await resultTask.value
    _ = analyzer
    return phrases.joined(separator: " ")
  } catch {
    resultTask.cancel()
    throw error
  }
}

@available(macOS 26.0, *)
private func transcribe(
  audioPath: String,
  localeIdentifier: String,
  contextualStrings: [String]
) async throws -> String {
  let requestedLocale = Locale(identifier: localeIdentifier)
  // SpeechTranscriber is Apple's newer transcription model. Dictation remains
  // the compatibility path for unsupported hardware/locales or unavailable assets.
  if SpeechTranscriber.isAvailable,
    let locale = await SpeechTranscriber.supportedLocale(equivalentTo: requestedLocale)
  {
    do {
      let transcriber = SpeechTranscriber(locale: locale, preset: .transcription)
      if let installation = try await AssetInventory.assetInstallationRequest(supporting: [
        transcriber
      ]) {
        try await installation.downloadAndInstall()
      }
      try Task.checkCancellation()
      let resultTask = Task { () throws -> [String] in
        var phrases: [String] = []
        for try await result in transcriber.results {
          let phrase = String(result.text.characters).trimmingCharacters(
            in: .whitespacesAndNewlines)
          if !phrase.isEmpty { phrases.append(phrase) }
        }
        return phrases
      }
      return try await analyze(
        audioPath: audioPath, contextualStrings: contextualStrings,
        module: transcriber, resultTask: resultTask
      )
    } catch {
      if error is CancellationError || Task.isCancelled { throw error }
      // A failed model installation or unsupported native path must not remove
      // transcription on machines where the existing dictation model works.
    }
  }

  try Task.checkCancellation()
  guard let locale = await DictationTranscriber.supportedLocale(equivalentTo: requestedLocale)
  else { throw TranscriptionError.unsupportedLocale(localeIdentifier) }
  let transcriber = DictationTranscriber(locale: locale, preset: .longDictation)
  if let installation = try await AssetInventory.assetInstallationRequest(supporting: [transcriber])
  {
    try await installation.downloadAndInstall()
  }
  try Task.checkCancellation()
  let resultTask = Task { () throws -> [String] in
    var phrases: [String] = []
    for try await result in transcriber.results {
      let phrase = String(result.text.characters).trimmingCharacters(in: .whitespacesAndNewlines)
      if !phrase.isEmpty { phrases.append(phrase) }
    }
    return phrases
  }
  return try await analyze(
    audioPath: audioPath, contextualStrings: contextualStrings,
    module: transcriber, resultTask: resultTask
  )
}

@main
private struct MacSpeechTranscriber {
  static func main() async {
    do {
      guard #available(macOS 26.0, *) else {
        throw TranscriptionError.unsupportedOperatingSystem
      }
      guard CommandLine.arguments.count >= 2 else {
        throw CocoaError(
          .fileNoSuchFile,
          userInfo: [
            NSLocalizedDescriptionKey: "Usage: macos-speech-transcriber <audio-file> [locale]"
          ])
      }
      let text = try await transcribe(
        audioPath: CommandLine.arguments[1],
        localeIdentifier: CommandLine.arguments.count >= 3 ? CommandLine.arguments[2] : "en-US",
        contextualStrings: CommandLine.arguments.count >= 4
          ? Array(CommandLine.arguments.dropFirst(3))
          : []
      )
      let data = try JSONEncoder().encode(SuccessPayload(text: text))
      FileHandle.standardOutput.write(data)
      FileHandle.standardOutput.write(Data([0x0A]))
    } catch {
      let message = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
      FileHandle.standardError.write(Data(message.utf8))
      FileHandle.standardError.write(Data([0x0A]))
      Foundation.exit(EXIT_FAILURE)
    }
  }
}
