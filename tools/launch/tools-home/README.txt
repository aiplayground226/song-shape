SongShape_Tools - the permanent home of Song Shape's local tools (shared by every Song Shape version, v0.2.11 and later)

  songshape-tools.json   the one config: paths to python (venv), ffmpeg, the model folder, the work folder
  venv\                  private Python 3.11 environment: torch + torchaudio (CPU), Demucs 4, numpy, soundfile
  models\hub\checkpoints Demucs htdemucs weights (955717e8-8726e21a.th) and wav2vec2 base weights (aligner)
  scripts\               separate_demucs.py, used by "Rip Video to Vocals.cmd" here
  work\                  the helper's private work folder (temporary audio; delete old files when you like)
  Rip Video to Vocals.cmd  drag a video or song onto it: audio (ffmpeg) then the vocal stem (Demucs, CPU)

ffmpeg stays where winget installed it; songshape-tools.json points at it.

Start Song Shape with Start-SongShape.cmd inside the version folder you want, for example
  D:\SongShape\Song_Shape_v0.2.11-dev\Start-SongShape.cmd
It finds this folder (a SongShape_Tools folder next to the version folders, or the SONGSHAPE_TOOLS
environment variable), checks every tool, and lists any that are NOT FOUND. New Song Shape versions
never need the tools moved: unzip the new version next to this folder and use its Start-SongShape.cmd.
Do not rename or move this folder; if you must, edit songshape-tools.json or set SONGSHAPE_TOOLS.
