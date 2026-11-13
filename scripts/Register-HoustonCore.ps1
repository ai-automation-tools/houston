<#
.SYNOPSIS
    Starts the harness's Core at logon, with no window, through a Scheduled Task.

.DESCRIPTION
    Registers a task for the current user that runs `node core/main.js` from this checkout
    when the user logs on. It runs under `conhost.exe --headless`, so no console window
    appears, at the user's normal (not elevated) level, with no time limit and one copy at a
    time. With no console, the Core's start line and any failure to start go to core.log in
    its data folder (%LOCALAPPDATA%\houston-core by default).

    Ending the task (or -Unregister) stops the Core cleanly: it stops its sessions, writes
    core.stop and exits within a few seconds (it watches for its conhost to go).
    Killing node.exe itself is a crash instead: the sessions' containers end with it and the
    next start records them as interrupted.

.PARAMETER TaskPath
    The Task Scheduler folder. Default: \Houston\

.PARAMETER TaskName
    Default: Houston Core

.PARAMETER StartNow
    Also start the task now and wait for the Core's start line in core.log.

.PARAMETER Unregister
    Stop and remove the task instead.

.EXAMPLE
    pwsh -NoProfile -File scripts\Register-HoustonCore.ps1 -StartNow

.EXAMPLE
    pwsh -NoProfile -File scripts\Register-HoustonCore.ps1 -Unregister
#>
[CmdletBinding()]
param(
    [string] $TaskPath = '\Houston\',
    [string] $TaskName = 'Houston Core',
    [switch] $StartNow,
    [switch] $Unregister
)
$ErrorActionPreference = 'Stop'

if (-not $TaskPath.EndsWith('\')) { $TaskPath += '\' }
$existing = Get-ScheduledTask -TaskPath $TaskPath -TaskName $TaskName -ErrorAction SilentlyContinue

if ($Unregister) {
    if (-not $existing) { Write-Output "No task $TaskPath$TaskName."; return }
    Stop-ScheduledTask -TaskPath $TaskPath -TaskName $TaskName
    # The Core notices its conhost is gone within about 2 s, then stops its sessions.
    $main = Join-Path (Split-Path -Parent $PSScriptRoot) 'core\main.js'
    for ($i = 0; $i -lt 30 -and @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -like "*$main*--exit-with-parent*" }).Count; $i++) { Start-Sleep -Milliseconds 500 }
    Unregister-ScheduledTask -TaskPath $TaskPath -TaskName $TaskName -Confirm:$false
    Write-Output "Removed $TaskPath$TaskName. A Core it started has ended."
    return
}

$root = Split-Path -Parent $PSScriptRoot
$main = Join-Path $root 'core\main.js'
if (-not (Test-Path $main)) { throw "No core\main.js under $root." }
if (-not (Test-Path (Join-Path $root 'node_modules\@microsoft\mxc-sdk'))) { throw "Dependencies aren't installed in $root. Run 'npm install' there first." }
$node = (Get-Command node.exe -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source
$conhost = Join-Path $env:SystemRoot 'System32\conhost.exe'
$user = "$env:USERDOMAIN\$env:USERNAME"

# Ending the task ends conhost but not node, so --exit-with-parent makes the Core stop when conhost goes.
$action = New-ScheduledTaskAction -Execute $conhost -Argument "--headless `"$node`" `"$main`" --exit-with-parent" -WorkingDirectory $root
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $user
$principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew `
    -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
$description = "Houston's Core (the agent harness), started at logon with no window from $root. Its log: core.log in its data folder. Made by scripts\Register-HoustonCore.ps1."
Register-ScheduledTask -TaskPath $TaskPath -TaskName $TaskName -Action $action -Trigger $trigger -Principal $principal `
    -Settings $settings -Description $description -Force | Out-Null
Write-Output "$(if ($existing) { 'Updated' } else { 'Registered' }) $TaskPath$TaskName`: at logon, $node $main"

if ($StartNow) {
    $dataDir = if ($env:HOUSTON_CORE_DATA) { $env:HOUSTON_CORE_DATA } else { Join-Path $env:LOCALAPPDATA 'houston-core' }
    $log = Join-Path $dataDir 'core.log'
    if ((Get-ScheduledTask -TaskPath $TaskPath -TaskName $TaskName).State -eq 'Running') { Write-Output 'The task is already running; the Core keeps going.'; return }
    $before = @(if (Test-Path $log) { Get-Content $log }).Count
    Start-ScheduledTask -TaskPath $TaskPath -TaskName $TaskName
    $deadline = (Get-Date).AddSeconds(30)
    while ((Get-Date) -lt $deadline) {
        $new = @(if (Test-Path $log) { Get-Content $log | Select-Object -Skip $before })
        if ($new.Count) { Write-Output "core.log: $($new[-1])"; return }
        Start-Sleep -Milliseconds 500
    }
    throw "The task started but the Core wrote nothing to $log in 30 s. Run 'npm run core' in $root to see why."
}
