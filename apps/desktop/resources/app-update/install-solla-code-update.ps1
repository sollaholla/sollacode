param(
  [Parameter(Mandatory = $true)]
  [ValidateSet("Preflight", "Install")]
  [string]$Mode,

  [Parameter(Mandatory = $true)]
  [string]$Artifact,

  [Parameter(Mandatory = $true)]
  [string]$Target,

  [int]$WaitPid = 0,
  [int]$WaitBackendPid = 0,
  [string]$HealthUrl = "",
  [string]$LogPath = ""
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

function Start-DetachedProcess {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Path,

    [Parameter(Mandatory = $true)]
    [string]$Arguments
  )

  # Start-Process keeps the relaunched Electron process attached to this
  # PowerShell console. The console host then stays visible, and closing it
  # also closes Solla Code. CreateProcess with DETACHED_PROCESS gives the new
  # desktop root no inherited console while preserving the interactive user
  # and desktop of this updater process.
  Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;

namespace SollaCode.Update
{
    public static class DetachedProcessLauncher
    {
        private const uint DETACHED_PROCESS = 0x00000008;
        private const uint CREATE_NEW_PROCESS_GROUP = 0x00000200;

        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
        private struct STARTUPINFO
        {
            public uint cb;
            public string lpReserved;
            public string lpDesktop;
            public string lpTitle;
            public uint dwX;
            public uint dwY;
            public uint dwXSize;
            public uint dwYSize;
            public uint dwXCountChars;
            public uint dwYCountChars;
            public uint dwFillAttribute;
            public uint dwFlags;
            public ushort wShowWindow;
            public ushort cbReserved2;
            public IntPtr lpReserved2;
            public IntPtr hStdInput;
            public IntPtr hStdOutput;
            public IntPtr hStdError;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct PROCESS_INFORMATION
        {
            public IntPtr hProcess;
            public IntPtr hThread;
            public uint dwProcessId;
            public uint dwThreadId;
        }

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool CreateProcessW(
            string applicationName,
            StringBuilder commandLine,
            IntPtr processAttributes,
            IntPtr threadAttributes,
            [MarshalAs(UnmanagedType.Bool)] bool inheritHandles,
            uint creationFlags,
            IntPtr environment,
            string currentDirectory,
            ref STARTUPINFO startupInfo,
            out PROCESS_INFORMATION processInformation);

        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool CloseHandle(IntPtr handle);

        public static int Start(string path, string arguments, string currentDirectory)
        {
            var startupInfo = new STARTUPINFO
            {
                cb = (uint)Marshal.SizeOf(typeof(STARTUPINFO))
            };
            var commandLine = new StringBuilder("\"" + path + "\" " + arguments);
            PROCESS_INFORMATION processInformation;
            var created = CreateProcessW(
                path,
                commandLine,
                IntPtr.Zero,
                IntPtr.Zero,
                false,
                DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP,
                IntPtr.Zero,
                currentDirectory,
                ref startupInfo,
                out processInformation);
            if (!created)
            {
                throw new Win32Exception(
                    Marshal.GetLastWin32Error(),
                    "Could not start the detached Solla Code process.");
            }

            try
            {
                return unchecked((int)processInformation.dwProcessId);
            }
            finally
            {
                CloseHandle(processInformation.hThread);
                CloseHandle(processInformation.hProcess);
            }
        }
    }
}
'@

  $workingDirectory = Split-Path -Parent $Path
  return [SollaCode.Update.DetachedProcessLauncher]::Start($Path, $Arguments, $workingDirectory)
}

function Get-VerifiedArtifact {
  param([string]$Path)

  $resolved = (Resolve-Path -LiteralPath $Path).Path
  $item = Get-Item -LiteralPath $resolved
  if ($item.PSIsContainer -or $item.Extension.ToLowerInvariant() -ne ".exe") {
    throw "The Windows update artifact must be a Solla Code NSIS .exe installer."
  }

  $stream = [System.IO.File]::OpenRead($resolved)
  try {
    if ($stream.Length -lt 2 -or $stream.ReadByte() -ne 0x4d -or $stream.ReadByte() -ne 0x5a) {
      throw "The update artifact is not a Windows executable."
    }
  }
  finally {
    $stream.Dispose()
  }

  $versionInfo = $item.VersionInfo
  $productName = [string]$versionInfo.ProductName
  $description = [string]$versionInfo.FileDescription
  if ($productName -notmatch "Solla Code" -and $description -notmatch "Solla Code") {
    throw "The executable is not a Solla Code installer."
  }

  $version = [string]$versionInfo.ProductVersion
  if ([string]::IsNullOrWhiteSpace($version)) {
    $version = [string]$versionInfo.FileVersion
  }
  if ([string]::IsNullOrWhiteSpace($version)) {
    throw "The update artifact does not report a product version."
  }

  $signature = Get-AuthenticodeSignature -LiteralPath $resolved
  if ($signature.Status -ne "Valid" -and $signature.Status -ne "NotSigned") {
    throw "The update artifact has an invalid Authenticode signature status: $($signature.Status)."
  }

  return [pscustomobject]@{
    Path = $resolved
    Version = $version
    SignatureStatus = [string]$signature.Status
  }
}

$verified = Get-VerifiedArtifact -Path $Artifact

if ($Mode -eq "Preflight") {
  [pscustomobject]@{
    platform = "win32"
    artifactKind = "nsis"
    version = $verified.Version
    productName = "Solla Code"
    signatureStatus = $verified.SignatureStatus
  } | ConvertTo-Json -Compress
  exit 0
}

if ($WaitPid -le 1 -or $WaitBackendPid -le 1 -or [string]::IsNullOrWhiteSpace($HealthUrl) -or [string]::IsNullOrWhiteSpace($LogPath)) {
  throw "Install mode requires WaitPid, WaitBackendPid, HealthUrl, and LogPath."
}
if (-not [System.IO.Path]::IsPathRooted($Target) -or [System.IO.Path]::GetExtension($Target).ToLowerInvariant() -ne ".exe") {
  throw "The running Solla Code executable target is invalid."
}

Start-Transcript -Path $LogPath -Append | Out-Null
try {
  Write-Output "Windows updater process $PID started."
  Write-Output "Installing Solla Code $($verified.Version) from $($verified.Path)"

  # Give the MCP response time to flush before closing the process that served it.
  Start-Sleep -Seconds 3
  $desktop = Get-Process -Id $WaitPid -ErrorAction Stop
  if (-not $desktop.CloseMainWindow()) {
    throw "Solla Code did not accept a graceful close request; the installer was not started."
  }
  if (-not $desktop.WaitForExit(120000)) {
    throw "Solla Code did not close within 120 seconds; the installer was not started."
  }

  # The backend that served the MCP request must be gone before installation,
  # otherwise its stale listener could be mistaken for the replacement app.
  $backend = Get-Process -Id $WaitBackendPid -ErrorAction SilentlyContinue
  if ($null -ne $backend -and -not $backend.WaitForExit(120000)) {
    throw "The Solla Code backend did not close within 120 seconds; the installer was not started."
  }

  $installer = Start-Process -FilePath $verified.Path -ArgumentList "/S" -Wait -PassThru
  if ($installer.ExitCode -ne 0) {
    throw "The Solla Code installer exited with code $($installer.ExitCode)."
  }
  if (-not (Test-Path -LiteralPath $Target -PathType Leaf)) {
    throw "The Solla Code installer completed but the application executable is missing."
  }

  # The desktop backend intentionally runs Electron as Node. Never leak that
  # flag into the relaunched GUI process.
  Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
  $launchedPid = Start-DetachedProcess -Path $Target -Arguments "--auto-resume"
  Write-Output "Started detached Solla Code process $launchedPid."

  $healthy = $false
  for ($attempt = 0; $attempt -lt 120; $attempt += 1) {
    try {
      $response = Invoke-WebRequest -Uri $HealthUrl -UseBasicParsing -TimeoutSec 2
      if ($response.StatusCode -ge 200 -and $response.StatusCode -lt 400) {
        $healthy = $true
        break
      }
    }
    catch {
      # The listener is expected to be absent while Electron and the backend start.
    }
    Start-Sleep -Seconds 1
  }
  if (-not $healthy) {
    throw "The updated Solla Code app did not become healthy within 120 seconds."
  }

  Write-Output "Solla Code $($verified.Version) is healthy at $HealthUrl"
}
finally {
  Stop-Transcript | Out-Null
}

exit 0
