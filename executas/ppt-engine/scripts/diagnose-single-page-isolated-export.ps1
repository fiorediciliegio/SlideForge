param(
  [Parameter(Mandatory = $true)][string]$HtmlPath,
  [Parameter(Mandatory = $true)][string]$OutputDirectory,
  [Parameter(Mandatory = $true)][ValidateRange(2, 200)][int]$PageCount,
  [string]$TitlePrefix = "single-page-isolated",
  [int]$SampleIntervalMs = 250
)

$ErrorActionPreference = "Stop"
if (Test-Path -LiteralPath $OutputDirectory) {
  throw "Refusing to reuse an existing output directory: $OutputDirectory"
}
New-Item -ItemType Directory -Path $OutputDirectory | Out-Null
$monitorScript = Join-Path $PSScriptRoot "diagnose-pptx-export-memory.ps1"
$summary = [System.Collections.Generic.List[object]]::new()

for ($pageIndex = 0; $pageIndex -lt $PageCount; $pageIndex++) {
  $pageNumber = $pageIndex + 1
  $tag = "{0:D2}" -f $pageNumber
  $outputPath = Join-Path $OutputDirectory "slide-$tag.pptx"
  $tracePath = Join-Path $OutputDirectory "slide-$tag-trace.jsonl"
  $timelinePath = Join-Path $OutputDirectory "slide-$tag-memory.json"
  & $monitorScript `
    -HtmlPath $HtmlPath `
    -OutputPath $outputPath `
    -TracePath $tracePath `
    -TimelinePath $timelinePath `
    -Title "$TitlePrefix-$tag" `
    -SingleSlideIndex $pageIndex `
    -SampleIntervalMs $SampleIntervalMs
  if ($LASTEXITCODE -ne 0) { throw "Single-page export failed for slide $pageNumber" }

  $timeline = Get-Content -LiteralPath $timelinePath -Raw | ConvertFrom-Json
  $withRenderer = @($timeline.samples | Where-Object { [UInt64]$_.renderer_private_bytes -gt 0 })
  if ($withRenderer.Count -eq 0) { throw "No renderer memory sample was recorded for slide $pageNumber" }
  $peak = $withRenderer | Sort-Object { [UInt64]$_.renderer_private_bytes } -Descending | Select-Object -First 1
  $first = [datetime]$timeline.samples[0].timestamp
  $last = [datetime]$timeline.samples[$timeline.samples.Count - 1].timestamp
  $summary.Add([ordered]@{
    slide_number = $pageNumber
    output_path = $outputPath
    size_bytes = (Get-Item -LiteralPath $outputPath).Length
    elapsed_ms = [math]::Round(($last - $first).TotalMilliseconds, 1)
    renderer_peak_private_bytes = [UInt64]$peak.renderer_private_bytes
    renderer_peak_timestamp = $peak.timestamp
  })
}

$result = [ordered]@{
  version = 1
  page_count = $PageCount
  total_elapsed_ms = [math]::Round(($summary | Measure-Object -Property elapsed_ms -Sum).Sum, 1)
  max_renderer_private_bytes = [UInt64](($summary | Measure-Object -Property renderer_peak_private_bytes -Maximum).Maximum)
  pages = $summary
}
$result | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $OutputDirectory "summary.json") -Encoding utf8
$result | ConvertTo-Json -Depth 4
