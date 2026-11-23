# SongShape_Tools: video or song -> audio (ffmpeg) -> lead vocal stem (Demucs htdemucs, CPU). Local only.
# Usage: drag files onto "Rip Video to Vocals.cmd" in this folder. Reads songshape-tools.json here. ASCII only.
param([Parameter(ValueFromRemainingArguments = $true)][string[]]$Files)
$ErrorActionPreference = 'Stop'
$home2 = $PSScriptRoot
$cfg = Get-Content -LiteralPath (Join-Path $home2 'songshape-tools.json') -Raw | ConvertFrom-Json
function P($p) { if ([System.IO.Path]::IsPathRooted($p)) { $p } else { Join-Path $home2 $p } }
$py = P $cfg.python; $ff = P $cfg.ffmpeg; $sep = Join-Path $home2 'scripts\separate_demucs.py'
foreach ($t in @(@('python', $py), @('ffmpeg', $ff), @('separator script', $sep), @('model folder', (P $cfg.torch_home)))) {
  if (-not (Test-Path -LiteralPath $t[1])) { Write-Host ("NOT FOUND: {0} at {1}. Fix songshape-tools.json in {2}." -f $t[0], $t[1], $home2) -ForegroundColor Yellow; exit 1 }
}
$env:TORCH_HOME = P $cfg.torch_home
$env:SS_FFMPEG = $ff
$env:OMP_NUM_THREADS = $(if ($cfg.threads) { [string]$cfg.threads } else { '8' })
if (-not $Files) { Write-Host 'Drag one or more video or audio files (mp4, mkv, mov, webm, mp3, wav...) onto "Rip Video to Vocals.cmd".'; exit 1 }
foreach ($f in $Files) {
  $item = Get-Item -LiteralPath $f
  $out = Join-Path $item.DirectoryName ($item.BaseName + '_songshape')
  New-Item -ItemType Directory -Force -Path $out | Out-Null
  $audio = Join-Path $out ($item.BaseName + '_audio.wav')
  $voc   = Join-Path $out ($item.BaseName + '_vocals.wav')
  Write-Host "1/2 Audio from $($item.Name) ..."
  & $ff -v error -y -i $item.FullName -vn -ac 2 -ar 44100 -c:a pcm_s16le $audio
  if ($LASTEXITCODE) { throw "ffmpeg could not read $($item.Name)" }
  Write-Host '2/2 Vocals (Demucs htdemucs, CPU) ...'
  & $py $sep $audio $voc --device cpu
  if ($LASTEXITCODE) { throw 'Vocal separation failed.' }
  Write-Host "Done: $voc"
}
