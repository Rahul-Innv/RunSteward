# keep-awake.ps1 — hold the PC awake for the duration of a child process, then
# release. Uses the Win32 SetThreadExecutionState API (the same mechanism media
# players use). When this script exits, the request clears automatically, so the
# machine can sleep again while the queue is idle/waiting.
#
#   keep-awake.ps1 -WatchPid 1234     # stay awake until pid 1234 exits
#
# The runner calls this while a task is actively running and lets it exit when
# the task finishes — so we keep the PC awake mid-task but allow sleep while
# waiting for a usage-limit reset (the wake task handles the asleep case).

[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][int]$WatchPid
)

$signature = @'
[DllImport("kernel32.dll", SetLastError = true)]
public static extern uint SetThreadExecutionState(uint esFlags);
'@
$native = Add-Type -MemberDefinition $signature -Name 'Power' -Namespace 'NQ' -PassThru

$ES_CONTINUOUS = [uint32]"0x80000000"
$ES_SYSTEM_REQUIRED = [uint32]"0x00000001"

# assert: keep the system awake until the state is reset
$native::SetThreadExecutionState($ES_CONTINUOUS -bor $ES_SYSTEM_REQUIRED) | Out-Null
Write-Host "keep-awake engaged while pid $WatchPid runs"

try {
  Wait-Process -Id $WatchPid -ErrorAction SilentlyContinue
} finally {
  # release: allow the machine to sleep again
  $native::SetThreadExecutionState($ES_CONTINUOUS) | Out-Null
  Write-Host "keep-awake released"
}
