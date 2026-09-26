/** Private file recognition through Windows' installed SAPI engine; never opens the microphone. */
export const WINDOWS_SPEECH_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding
try {
  $inputData = [Console]::In.ReadToEnd() | ConvertFrom-Json
  Add-Type -AssemblyName System.Speech
  Add-Type -ReferencedAssemblies System.Speech -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Speech.Recognition;
using System.Threading;
public static class SollaSpeech {
  public sealed class Output {
    public string Text = "";
    public bool Reliable = true;
    public string Reason = "";
  }
  public static Output Run(string path, string locale, int timeoutMs) {
    RecognizerInfo selected = null;
    foreach (var info in SpeechRecognitionEngine.InstalledRecognizers()) {
      if (String.Equals(info.Culture.Name, locale, StringComparison.OrdinalIgnoreCase)) {
        selected = info;
        break;
      }
    }
    if (selected == null) throw new InvalidOperationException("No installed Windows speech recognizer for " + locale + ".");
    var output = new Output();
    var phrases = new List<string>();
    using (var recognizer = new SpeechRecognitionEngine(selected))
    using (var completed = new ManualResetEvent(false)) {
      recognizer.LoadGrammar(new DictationGrammar());
      recognizer.SetInputToWaveFile(path);
      recognizer.SpeechRecognized += (sender, e) => {
        if (e.Result.Confidence < 0.60f) output.Reliable = false;
        phrases.Add(e.Result.Text);
      };
      recognizer.SpeechRecognitionRejected += (sender, e) => { output.Reliable = false; };
      recognizer.RecognizeCompleted += (sender, e) => {
        if (e.Error != null || e.Cancelled) {
          output.Reliable = false;
          output.Reason = "Windows speech recognition did not complete.";
        }
        completed.Set();
      };
      recognizer.RecognizeAsync(RecognizeMode.Multiple);
      if (!completed.WaitOne(timeoutMs)) {
        recognizer.RecognizeAsyncCancel();
        // Dispose the recognizer before its completion event's wait handle.
        recognizer.Dispose();
        throw new TimeoutException("Windows speech recognition exceeded its time budget.");
      }
      output.Text = String.Join(" ", phrases).Trim();
      if (output.Text.Length == 0 || !output.Reliable) {
        output.Reliable = false;
        if (output.Reason.Length == 0) output.Reason = "Windows speech recognition was uncertain; use the AI fallback.";
      }
      recognizer.Dispose();
    }
    return output;
  }
}
'@
  $result = [SollaSpeech]::Run($inputData.path, $inputData.locale, $inputData.timeoutMs)
  if ($result.Reliable) {
    @{ status = 'success'; text = $result.Text } | ConvertTo-Json -Compress
  } else {
    @{ status = 'unavailable'; reason = $result.Reason } | ConvertTo-Json -Compress
  }
} catch {
  @{ status = 'unavailable'; reason = $_.Exception.Message } | ConvertTo-Json -Compress
}
`;
