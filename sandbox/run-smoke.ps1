$ErrorActionPreference = 'Stop'
$installerDir = 'C:\mkEventInstaller'
$resultsDir   = 'C:\mkEventResults'
New-Item -ItemType Directory -Force -Path $resultsDir | Out-Null

function Write-Result($verdict, $detail) {
  "$verdict`n$detail" | Set-Content -Path (Join-Path $resultsDir 'result.txt')
}

try {
  $installer = Get-ChildItem -Path $installerDir -Filter '*.exe' | Select-Object -First 1
  if (-not $installer) { Write-Result 'FAIL' 'No installer .exe found in C:\mkEventInstaller'; exit 1 }

  # Simulate the real download experience so SmartScreen behavior is representative when run manually.
  try { Unblock-File -Path $installer.FullName -ErrorAction SilentlyContinue } catch {}

  # Silent install (NSIS). perMachine=false installs to LOCALAPPDATA\Programs\mkEvent.
  Start-Process -FilePath $installer.FullName -ArgumentList '/S' -Wait
  Start-Sleep -Seconds 5

  $exe = Join-Path $env:LOCALAPPDATA 'Programs\mkEvent\mkEvent.exe'
  if (-not (Test-Path $exe)) { Write-Result 'FAIL' "App not installed at $exe"; exit 1 }

  $resultJson = Join-Path $resultsDir 'smoke-result.json'
  if (Test-Path $resultJson) { Remove-Item $resultJson -Force }

  Start-Process -FilePath $exe -ArgumentList "--smoke-check --smoke-result=$resultJson" -Wait

  if (-not (Test-Path $resultJson)) { Write-Result 'FAIL' 'Smoke check produced no result file (app did not reach smoke mode)'; exit 1 }

  $r = Get-Content $resultJson -Raw | ConvertFrom-Json
  $summary = ($r.checks | ForEach-Object { "$($_.name)=$([bool]$_.ok)" }) -join ' '
  if ($r.ok) { Write-Result 'PASS' $summary; exit 0 } else { Write-Result 'FAIL' $summary; exit 1 }
}
catch {
  Write-Result 'FAIL' $_.Exception.Message
  exit 1
}
