# wake-task.ps1 — register a one-shot Windows Scheduled Task that WAKES the PC
# at a given time and restarts the Claude Carry runner. This is the belt-and-braces
# path so a resume fires even if the machine went to sleep while waiting.
#
# Node timers can't wake a sleeping PC (and fire late across sleep), so the
# runner's wall-clock loop handles the awake case and THIS handles the asleep
# case. Idempotent: re-registering the same task name replaces it.
#
#   wake-task.ps1 -At "2026-06-13T17:00:30" -RunnerCmd "node C:\...\bin\carry.mjs run"
#   wake-task.ps1 -Remove                       # delete the wake task
#   wake-task.ps1 -AtLogon -RunnerCmd "..."     # register the reboot-recovery task

[CmdletBinding()]
param(
  [string]$At,                                   # ISO local datetime to wake at
  [string]$RunnerCmd,                            # command the task runs
  [switch]$AtLogon,                              # register the at-logon recovery task instead
  [switch]$Remove,                               # remove the wake task
  [string]$TaskName = "Carry-Wake"
)

$ErrorActionPreference = 'Stop'

if ($Remove) {
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
  Write-Host "removed scheduled task '$TaskName'"
  return
}

if (-not $RunnerCmd) { throw "RunnerCmd is required" }

# Run the runner detached via a hidden PowerShell host. cmd.exe /c start makes it
# non-blocking so the scheduled task completes immediately.
$action = New-ScheduledTaskAction -Execute "powershell.exe" `
  -Argument "-NoProfile -WindowStyle Hidden -Command `"$RunnerCmd`""

if ($AtLogon) {
  $trigger = New-ScheduledTaskTrigger -AtLogOn
  $TaskName = "Carry-AtLogon"
} else {
  if (-not $At) { throw "At is required unless -AtLogon" }
  $when = [datetime]::Parse($At)
  $trigger = New-ScheduledTaskTrigger -Once -At $when
}

# THE critical settings: WakeToRun pulls the machine out of sleep; the others
# make sure the task isn't suppressed on battery or skipped if slightly late.
$settings = New-ScheduledTaskSettingsSet `
  -WakeToRun `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -StartWhenAvailable `
  -ExecutionTimeLimit (New-TimeSpan -Hours 0) `
  -MultipleInstances IgnoreNew

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger `
  -Settings $settings -Force -RunLevel Limited | Out-Null

$desc = if ($AtLogon) { "at every logon (reboot recovery)" } else { "once at $At (waking the PC)" }
Write-Host "registered '$TaskName' to run $desc"
