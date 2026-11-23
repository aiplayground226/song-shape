# Song Shape launcher (v0.2.11+). Finds the shared tools home (SongShape_Tools), checks every tool,
# writes this version's helper config, starts the local helper (127.0.0.1 only) and opens the app.
# ASCII only (Windows PowerShell 5.1). Nothing is installed, moved or downloaded.
# -CheckOnly: list the tools and write the helper config, then stop (starts nothing).
param([switch]$CheckOnly)
$ErrorActionPreference = 'Stop'
$app = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)       # ...\Song_Shape_v0.2.11-dev
$version = 'v0.2.11'
$Host.UI.RawUI.WindowTitle = "Song Shape $version - $app"
Write-Host "Song Shape $version"
Write-Host "App folder: $app"

# 1. The tools home: SONGSHAPE_TOOLS, else a SongShape_Tools folder next to this version or any folder above it.
$cfgPath = $null
if ($env:SONGSHAPE_TOOLS) { $cfgPath = Join-Path $env:SONGSHAPE_TOOLS 'songshape-tools.json' }
else {
  $d = $app
  while ($d) {
    $c = Join-Path (Join-Path $d 'SongShape_Tools') 'songshape-tools.json'
    if (Test-Path -LiteralPath $c) { $cfgPath = $c; break }
    $p = Split-Path -Parent $d; if ($p -eq $d) { break }; $d = $p
  }
}
function Open-AppOnly($why) {
  Write-Host ''
  Write-Host "NOT FOUND: $why" -ForegroundColor Yellow
  if ($CheckOnly) { exit 1 }
  Write-Host 'Opening the app without the helper (load a vocal stem yourself, or fix the tools config and start again).'
  Start-Process (Join-Path $app 'index.html')
  exit 1
}
if (-not $cfgPath -or -not (Test-Path -LiteralPath $cfgPath)) { Open-AppOnly 'the tools config SongShape_Tools\songshape-tools.json (set SONGSHAPE_TOOLS or put SongShape_Tools next to the Song Shape folders)' }
$toolsHome = Split-Path -Parent $cfgPath
Write-Host "Tools home: $toolsHome"
$cfg = Get-Content -LiteralPath $cfgPath -Raw | ConvertFrom-Json
function Resolve-ToolPath($p) { if (-not $p) { return $null }; if ([System.IO.Path]::IsPathRooted($p)) { return $p }; return (Join-Path $toolsHome $p) }

# 2. Check each tool.
$tools = [ordered]@{
  'python (helper venv)'          = Resolve-ToolPath $cfg.python
  'ffmpeg (audio from mp4/mp3/wav)' = Resolve-ToolPath $cfg.ffmpeg
  'model folder (TORCH_HOME)'     = Resolve-ToolPath $cfg.torch_home
  'Demucs htdemucs weights'       = Join-Path (Resolve-ToolPath $cfg.torch_home) 'hub\checkpoints\955717e8-8726e21a.th'
  'wav2vec2 base weights'         = Join-Path (Resolve-ToolPath $cfg.torch_home) 'hub\checkpoints\wav2vec2_fairseq_base_ls960_asr_ls960.pth'
  'separator script (this version)' = Join-Path $app 'tools\helper\separate_demucs.py'
  'aligner script (this version)' = Join-Path $app 'tools\helper\align_ctc.py'
  'helper (this version)'         = Join-Path $app 'tools\helper\songshape_helper.py'
}
$missing = @()
Write-Host ''
foreach ($k in $tools.Keys) {
  $p = $tools[$k]; $ok = $p -and (Test-Path -LiteralPath $p)
  if ($ok) { Write-Host ('  found      {0,-34} {1}' -f $k, $p) } else { Write-Host ('  NOT FOUND  {0,-34} {1}' -f $k, $p) -ForegroundColor Yellow; $missing += $k }
}
Write-Host ''
if ($missing -contains 'python (helper venv)' -or $missing -contains 'helper (this version)') { Open-AppOnly ('python or the helper: ' + ($missing -join ', ')) }
if ($missing.Count) { Write-Host ('Some tools are missing (' + ($missing -join ', ') + '). The helper starts anyway; the page shows what is missing under Check helper.') -ForegroundColor Yellow }

# 3. This version's helper config (written into the tools work folder; holds no token).
$work = Resolve-ToolPath $(if ($cfg.work_dir) { $cfg.work_dir } else { 'work' })
New-Item -ItemType Directory -Force -Path $work | Out-Null
$py = $tools['python (helper venv)']
$device = $(if ($cfg.device) { $cfg.device } else { 'cpu' })
$toolList = @(); foreach ($k in $tools.Keys) { $toolList += [ordered]@{ name = $k; path = $tools[$k] } }
$helperCfg = [ordered]@{
  device = $device; timeout_s = 1800; tools_home = $toolsHome; tools = $toolList
  separator = @($py, $tools['separator script (this version)'], '{input}', '{output}', '--model', 'htdemucs', '--device', '{device}')
  aligner   = @($py, $tools['aligner script (this version)'], '{input}', '{words}', '{output}', '--model', 'base', '--device', '{device}')
}
$helperCfgPath = Join-Path $work ("helper-config.$version.json")
($helperCfg | ConvertTo-Json -Depth 5) | Set-Content -LiteralPath $helperCfgPath -Encoding ASCII

if ($CheckOnly) { Write-Host "Check only. Helper config written: $helperCfgPath"; exit $(if ($missing.Count) { 2 } else { 0 }) }

# 4. Environment for the tools, then the page and the helper.
$env:TORCH_HOME = $tools['model folder (TORCH_HOME)']
if ($tools['ffmpeg (audio from mp4/mp3/wav)']) { $env:SS_FFMPEG = $tools['ffmpeg (audio from mp4/mp3/wav)'] }
$env:OMP_NUM_THREADS = $(if ($cfg.threads) { [string]$cfg.threads } else { '8' })
$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if ($node) {
  Start-Process -WindowStyle Minimized -FilePath $node -ArgumentList @("`"$app\tools\serve-local.js`"", '8765')
  Start-Sleep -Seconds 1
  Start-Process 'http://127.0.0.1:8765/'
} else { Start-Process (Join-Path $app 'index.html') }
Write-Host 'Helper: CPU mode, 127.0.0.1 only. Keep this window open; copy the Token line into the page (Stage 0). Close the window to stop.'
& $py (Join-Path $app 'tools\helper\songshape_helper.py') --config $helperCfgPath --port 8766 --work-dir $work
