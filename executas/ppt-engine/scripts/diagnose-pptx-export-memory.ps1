param(
  [Parameter(Mandatory = $true)][string]$HtmlPath,
  [Parameter(Mandatory = $true)][string]$OutputPath,
  [Parameter(Mandatory = $true)][string]$TracePath,
  [Parameter(Mandatory = $true)][string]$TimelinePath,
  [string]$Title = "deck",
  [Nullable[int]]$SingleSlideIndex = $null,
  [int]$SampleIntervalMs = 250
)

$ErrorActionPreference = "Stop"
$engineDir = Split-Path -Parent $PSScriptRoot
$nodePath = (Get-Command node.exe -ErrorAction Stop).Source
$convertScript = Join-Path $PSScriptRoot "convert-deck-html-to-pptx.ts"
$stdoutPath = "$OutputPath.stdout.log"
$stderrPath = "$OutputPath.stderr.log"

foreach ($pathToRemove in @($TracePath, $TimelinePath, $stdoutPath, $stderrPath)) {
  if (Test-Path -LiteralPath $pathToRemove) { Remove-Item -LiteralPath $pathToRemove -Force }
}
$env:PPTX_RASTERIZATION_LEDGER_PATH = $TracePath
$convertArgs = @(
  "--import", "tsx/esm", $convertScript, $HtmlPath, $OutputPath, $Title
)
if ($null -ne $SingleSlideIndex) { $convertArgs += [string]$SingleSlideIndex }
$process = Start-Process -FilePath $nodePath -ArgumentList $convertArgs -WorkingDirectory $engineDir -RedirectStandardOutput $stdoutPath -RedirectStandardError $stderrPath -PassThru -WindowStyle Hidden

function Get-ProcessTreeSamples([int]$rootPid) {
  $all = @(Get-CimInstance Win32_Process)
  $childrenByParent = @{}
  foreach ($entry in $all) {
    $parentId = [int]$entry.ParentProcessId
    if (-not $childrenByParent.ContainsKey($parentId)) {
      $childrenByParent[$parentId] = [System.Collections.Generic.List[object]]::new()
    }
    $childrenByParent[$parentId].Add($entry)
  }
  $known = [System.Collections.Generic.HashSet[int]]::new()
  [void]$known.Add($rootPid)
  $pending = [System.Collections.Generic.Queue[int]]::new()
  $pending.Enqueue($rootPid)
  while ($pending.Count -gt 0) {
    $parent = $pending.Dequeue()
    foreach ($child in @($childrenByParent[$parent])) {
      if ($known.Add([int]$child.ProcessId)) { $pending.Enqueue([int]$child.ProcessId) }
    }
  }
  return @($all | Where-Object { $known.Contains([int]$_.ProcessId) })
}

$samples = [System.Collections.Generic.List[object]]::new()
$rendererPids = [System.Collections.Generic.HashSet[int]]::new()
$nextDiscovery = [DateTime]::MinValue
$lastTreePrivateBytes = [UInt64]0
$lastTreeWorkingSetBytes = [UInt64]0
$lastTreeProcessCount = 0
$lastDiscoveryTimestamp = $null
do {
  # CIM is slow on this host (several seconds per full process-tree query), so
  # use it only to discover renderer PIDs.  The 250ms hot path reads those PIDs
  # directly through .NET, which is fast enough to catch short-lived peaks.
  if ([DateTime]::UtcNow -ge $nextDiscovery) {
    $tree = @(Get-ProcessTreeSamples $process.Id)
    foreach ($renderer in @($tree | Where-Object { $_.Name -ieq "chrome.exe" -and $_.CommandLine -match "--type=renderer" })) {
      [void]$rendererPids.Add([int]$renderer.ProcessId)
    }
    $lastTreeProcessCount = $tree.Count
    $lastTreePrivateBytes = [UInt64]0
    $lastTreeWorkingSetBytes = [UInt64]0
    foreach ($entry in $tree) {
      $lastTreePrivateBytes += [UInt64]$entry.PrivatePageCount
      $lastTreeWorkingSetBytes += [UInt64]$entry.WorkingSetSize
    }
    $lastDiscoveryTimestamp = [DateTime]::UtcNow.ToString("o")
    $nextDiscovery = [DateTime]::UtcNow.AddMilliseconds($(if ($rendererPids.Count -gt 0) { 4000 } else { 500 }))
  }
  $liveRenderers = @()
  foreach ($rendererPid in @($rendererPids)) {
    try { $liveRenderers += Get-Process -Id $rendererPid -ErrorAction Stop } catch { }
  }
  # A renderer can exit between Get-Process and property access. Snapshot its
  # counters defensively so that teardown never discards an otherwise valid
  # measurement run.
  $rendererMeasurements = @()
  foreach ($renderer in $liveRenderers) {
    try {
      $rendererMeasurements += [pscustomobject]@{
        Id = [int]$renderer.Id
        PrivateBytes = [UInt64]$renderer.PrivateMemorySize64
        WorkingSetBytes = [UInt64]$renderer.WorkingSet64
      }
    } catch { }
  }
  $largestRenderer = $rendererMeasurements | Sort-Object PrivateBytes -Descending | Select-Object -First 1
  $samples.Add([ordered]@{
    timestamp = [DateTime]::UtcNow.ToString("o")
    root_pid = $process.Id
    tree_private_bytes = $lastTreePrivateBytes
    tree_working_set_bytes = $lastTreeWorkingSetBytes
    process_count = $lastTreeProcessCount
    tree_snapshot_timestamp = $lastDiscoveryTimestamp
    renderer_private_bytes = if ($largestRenderer) { $largestRenderer.PrivateBytes } else { 0 }
    renderer_working_set_bytes = if ($largestRenderer) { $largestRenderer.WorkingSetBytes } else { 0 }
    renderer_pid = if ($largestRenderer) { $largestRenderer.Id } else { $null }
    renderer_count = $rendererMeasurements.Count
  })
  Start-Sleep -Milliseconds $SampleIntervalMs
} while (-not $process.HasExited)

# Capture the surviving children once more; the parent can exit just before a
# renderer has released its final raster surface.
$tree = @(Get-ProcessTreeSamples $process.Id)
$samples.Add([ordered]@{
  timestamp = [DateTime]::UtcNow.ToString("o")
  root_pid = $process.Id
  tree_private_bytes = [UInt64]0
  tree_working_set_bytes = [UInt64]0
  process_count = $tree.Count
  renderer_private_bytes = [UInt64]0
  renderer_working_set_bytes = [UInt64]0
  renderer_pid = $null
  renderer_count = 0
  final_sample = $true
})

[ordered]@{
  version = 1
  sample_interval_ms = $SampleIntervalMs
  process_exit_code = $process.ExitCode
  samples = $samples
} | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $TimelinePath -Encoding utf8

Get-Content -LiteralPath $stdoutPath
if ((Get-Item -LiteralPath $stderrPath).Length -gt 0) { Get-Content -LiteralPath $stderrPath | Write-Error }
if ($process.ExitCode -ne 0) { exit $process.ExitCode }
