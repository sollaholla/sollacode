param(
  [Parameter(Mandatory = $true)]
  [string]$InstallerPath,
  [Parameter(Mandatory = $true)]
  [string]$ExpectedVersion,
  [Parameter(Mandatory = $true)]
  [string]$ExpectedSha256
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$appExecutable = Join-Path $env:LOCALAPPDATA 'Programs\solla-code\Solla Code.exe'

function Get-AppProcesses {
  @(
    Get-CimInstance Win32_Process |
      Where-Object { $_.ExecutablePath -eq $appExecutable }
  )
}

function Get-AppRoots {
  $processes = @(Get-AppProcesses)
  $processIds = @($processes | ForEach-Object { [int]$_.ProcessId })
  @($processes | Where-Object { $processIds -notcontains [int]$_.ParentProcessId })
}

function Stop-ExactAppProcesses {
  $captured = @(Get-AppProcesses)
  if ($captured.Count -eq 0) {
    return
  }

  foreach ($processInfo in $captured) {
    $process = Get-Process -Id ([int]$processInfo.ProcessId) -ErrorAction SilentlyContinue
    if ($null -ne $process -and $process.MainWindowHandle -ne 0) {
      $null = $process.CloseMainWindow()
    }
  }

  $gracefulDeadline = (Get-Date).AddSeconds(12)
  do {
    Start-Sleep -Milliseconds 250
    $remaining = @(Get-AppProcesses)
  } while ($remaining.Count -gt 0 -and (Get-Date) -lt $gracefulDeadline)

  foreach ($processInfo in $remaining) {
    # The process was selected by exact installed executable path. Re-read it
    # immediately before stopping the captured PID so a recycled PID cannot
    # target another application.
    $current = Get-CimInstance Win32_Process -Filter ("ProcessId = {0}" -f $processInfo.ProcessId) -ErrorAction SilentlyContinue
    if ($null -ne $current -and $current.ExecutablePath -eq $appExecutable) {
      Stop-Process -Id ([int]$current.ProcessId) -Force
    }
  }

  $forcedDeadline = (Get-Date).AddSeconds(15)
  do {
    Start-Sleep -Milliseconds 250
    $remaining = @(Get-AppProcesses)
  } while ($remaining.Count -gt 0 -and (Get-Date) -lt $forcedDeadline)
  if ($remaining.Count -gt 0) {
    $summary = @($remaining | ForEach-Object { "PID $($_.ProcessId): $($_.CommandLine)" }) -join '; '
    throw "Captured Solla Code processes did not stop: $summary"
  }
}

function Get-LocalHttpStatus {
  Add-Type -AssemblyName System.Net.Http
  $client = [System.Net.Http.HttpClient]::new()
  $client.Timeout = [TimeSpan]::FromSeconds(5)
  try {
    $response = $client.GetAsync(
      'http://127.0.0.1:3773/',
      [System.Net.Http.HttpCompletionOption]::ResponseHeadersRead
    ).GetAwaiter().GetResult()
    try {
      [int]$response.StatusCode
    } finally {
      $response.Dispose()
    }
  } catch {
    0
  } finally {
    $client.Dispose()
  }
}

function Get-ReadyState {
  $roots = @(Get-AppRoots)
  $explorerSessionIds = @(
    Get-Process -Name explorer -ErrorAction SilentlyContinue |
      Select-Object -ExpandProperty SessionId -Unique
  )
  $listenerProcessIds = @(
    Get-NetTCPConnection -State Listen -LocalPort 3773 -ErrorAction SilentlyContinue |
      Select-Object -ExpandProperty OwningProcess -Unique
  )
  $httpStatus = if ($listenerProcessIds.Count -eq 1) { Get-LocalHttpStatus } else { 0 }
  $rootSessionId = if ($roots.Count -eq 1) { [int]$roots[0].SessionId } else { $null }
  $rootParent = if ($roots.Count -eq 1) {
    Get-CimInstance Win32_Process -Filter ("ProcessId = {0}" -f $roots[0].ParentProcessId) -ErrorAction SilentlyContinue
  } else {
    $null
  }
  $listenerProcess = if ($listenerProcessIds.Count -eq 1) {
    Get-CimInstance Win32_Process -Filter ("ProcessId = {0}" -f $listenerProcessIds[0]) -ErrorAction SilentlyContinue
  } else {
    $null
  }
  $ready =
    $roots.Count -eq 1 -and
    $roots[0].CommandLine -match '(?:^|\s)--auto-resume(?:\s|$)' -and
    $explorerSessionIds -contains $rootSessionId -and
    $listenerProcessIds.Count -eq 1 -and
    $null -ne $listenerProcess -and
    $listenerProcess.ExecutablePath -eq $appExecutable -and
    [int]$listenerProcess.ParentProcessId -eq [int]$roots[0].ProcessId -and
    $httpStatus -eq 200

  [pscustomobject]@{
    Ready = $ready
    Roots = $roots
    RootParent = $rootParent
    RootSessionId = $rootSessionId
    ExplorerSessionIds = $explorerSessionIds
    ListenerProcessIds = $listenerProcessIds
    HttpStatus = $httpStatus
  }
}

function Start-InteractiveAppTask {
  $taskService = New-Object -ComObject 'Schedule.Service'
  $taskService.Connect()
  $taskFolder = $taskService.GetFolder('\')
  $taskDefinition = $taskService.NewTask(0)
  $taskUser = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
  $taskName = "T3CodeRelease-$([Guid]::NewGuid().ToString('N'))"

  # TASK_LOGON_INTERACTIVE_TOKEN ensures the app is created in the signed-in
  # desktop session instead of the transient OpenSSH service session.
  $taskDefinition.Principal.UserId = $taskUser
  $taskDefinition.Principal.LogonType = 3
  $taskDefinition.Principal.RunLevel = 0
  $taskDefinition.Settings.AllowDemandStart = $true
  $taskDefinition.Settings.DisallowStartIfOnBatteries = $false
  $taskDefinition.Settings.StopIfGoingOnBatteries = $false
  $taskDefinition.Settings.ExecutionTimeLimit = 'PT5M'

  $escapedExecutable = $appExecutable.Replace("'", "''")
  $escapedWorkingDirectory = (Split-Path -Parent $appExecutable).Replace("'", "''")
  $launchScript = "Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue; Start-Process -FilePath '$escapedExecutable' -ArgumentList '--auto-resume' -WorkingDirectory '$escapedWorkingDirectory'"
  $encodedLaunchScript = [Convert]::ToBase64String(
    [Text.Encoding]::Unicode.GetBytes($launchScript)
  )
  $taskAction = $taskDefinition.Actions.Create(0)
  $taskAction.Path = Join-Path $PSHOME 'powershell.exe'
  $taskAction.Arguments = "-NoProfile -NonInteractive -WindowStyle Hidden -EncodedCommand $encodedLaunchScript"

  # TASK_CREATE_OR_UPDATE = 6 and TASK_LOGON_INTERACTIVE_TOKEN = 3.
  $taskRegistered = $false
  try {
    $registeredTask = $taskFolder.RegisterTaskDefinition(
      $taskName,
      $taskDefinition,
      6,
      $taskUser,
      $null,
      3,
      $null
    )
    $taskRegistered = $true
    $null = $registeredTask.Run($null)
  } catch {
    if ($taskRegistered) {
      try {
        $taskFolder.DeleteTask($taskName, 0)
      } catch {
        Write-Warning "Could not remove failed release task ${taskName}: $($_.Exception.Message)"
      }
    }
    throw
  }

  [pscustomobject]@{
    Folder = $taskFolder
    Name = $taskName
  }
}

function Remove-InteractiveAppTask {
  param(
    [Parameter(Mandatory = $true)]
    $Task
  )

  try {
    $Task.Folder.DeleteTask($Task.Name, 0)
  } catch {
    Write-Warning "Could not remove temporary release task $($Task.Name): $($_.Exception.Message)"
  }
}

if (-not (Test-Path -LiteralPath $InstallerPath -PathType Leaf)) {
  throw "Windows installer is missing: $InstallerPath"
}
$installerSha = (Get-FileHash -LiteralPath $InstallerPath -Algorithm SHA256).Hash.ToLowerInvariant()
if ($installerSha -ne $ExpectedSha256.ToLowerInvariant()) {
  throw "Windows installer SHA-256 mismatch: $installerSha"
}

Stop-ExactAppProcesses
$installerProcess = Start-Process -FilePath $InstallerPath -ArgumentList '/S' -PassThru -Wait
if ($installerProcess.ExitCode -ne 0) {
  throw "Windows installer exited with code $($installerProcess.ExitCode)"
}

# A silent NSIS install should not launch the app, but older installer settings
# occasionally did. Settle and close only exact-path app processes before the
# one intentional interactive-session --auto-resume launch.
Start-Sleep -Seconds 3
Stop-ExactAppProcesses

if (-not (Test-Path -LiteralPath $appExecutable -PathType Leaf)) {
  throw "Installed Solla Code executable is missing: $appExecutable"
}
$installedVersion = (Get-Item -LiteralPath $appExecutable).VersionInfo.ProductVersion
if ($installedVersion -ne $ExpectedVersion -and $installedVersion -ne "$ExpectedVersion.0") {
  throw "Installed Solla Code version is $installedVersion; expected $ExpectedVersion"
}

$interactiveTask = $null
try {
  $interactiveTask = Start-InteractiveAppTask
  $readyDeadline = (Get-Date).AddSeconds(120)
  do {
    Start-Sleep -Milliseconds 500
    $state = Get-ReadyState
  } while (-not $state.Ready -and (Get-Date) -lt $readyDeadline)
  if (-not $state.Ready) {
    $rootSummary = @($state.Roots | ForEach-Object { "PID $($_.ProcessId), session $($_.SessionId), parent $($_.ParentProcessId): $($_.CommandLine)" }) -join '; '
    throw "Windows release did not become ready. Roots: $rootSummary; Explorer sessions: $($state.ExplorerSessionIds -join ','); listeners: $($state.ListenerProcessIds -join ','); HTTP: $($state.HttpStatus)"
  }
} finally {
  if ($null -ne $interactiveTask) {
    Remove-InteractiveAppTask -Task $interactiveTask
  }
}

# A transient listener is not release proof. Let startup settle, then require
# several consecutive healthy samples. A single missed HTTP sample or one
# backend handoff should not fail an otherwise durable interactive launch.
Start-Sleep -Seconds 10
$stableDeadline = (Get-Date).AddSeconds(30)
$consecutiveStableChecks = 0
do {
  $stableState = Get-ReadyState
  if ($stableState.Ready) {
    $consecutiveStableChecks++
  } else {
    $consecutiveStableChecks = 0
  }
  if ($consecutiveStableChecks -lt 6) {
    Start-Sleep -Milliseconds 500
  }
} while ($consecutiveStableChecks -lt 6 -and (Get-Date) -lt $stableDeadline)
if ($consecutiveStableChecks -lt 6) {
  $rootSummary = @($stableState.Roots | ForEach-Object { "PID $($_.ProcessId), session $($_.SessionId), parent $($_.ParentProcessId): $($_.CommandLine)" }) -join '; '
  throw "Windows release lost its durable --auto-resume process or health check. Roots: $rootSummary; Explorer sessions: $($stableState.ExplorerSessionIds -join ','); listeners: $($stableState.ListenerProcessIds -join ','); HTTP: $($stableState.HttpStatus)"
}

[pscustomobject]@{
  ComputerName = $env:COMPUTERNAME
  InstalledVersion = $installedVersion
  RootProcessId = [int]$stableState.Roots[0].ProcessId
  RootParent = if ($null -eq $stableState.RootParent) { $null } else { $stableState.RootParent.Name }
  RootSessionId = [int]$stableState.RootSessionId
  ExplorerSessionIds = @($stableState.ExplorerSessionIds)
  ListenerProcessId = [int]$stableState.ListenerProcessIds[0]
  HttpStatus = $stableState.HttpStatus
  AutoResume = $true
  Stable = $true
} | ConvertTo-Json -Compress
