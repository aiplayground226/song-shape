#!/usr/bin/env python3
"""Song Shape helper adapter: lead-vocal stem with Demucs (user-installed), written with soundfile.

python separate_demucs.py <input audio> <output vocals.wav> [--model htdemucs] [--device cpu]

Why this file: demucs 4.0.1's own CLI saves through torchaudio, and torchaudio 2.9+ needs the
separate torchcodec package to save. This adapter decodes with Demucs' ffmpeg reader and saves
with soundfile instead. Nothing is installed or downloaded by this script itself; Demucs may
download its model weights the first time (do that while online). Licenses: Demucs code MIT;
htdemucs weights see tools/helper/README.md (MUSDB18 caveat).
"""
import argparse, random, sys, time


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('input'); ap.add_argument('output')
    ap.add_argument('--model', default='htdemucs'); ap.add_argument('--device', default='cpu')
    ap.add_argument('--shifts', type=int, default=1)
    a = ap.parse_args()
    import torch, soundfile as sf
    from demucs.pretrained import get_model
    from demucs.apply import apply_model
    from demucs.audio import AudioFile
    random.seed(0); torch.manual_seed(0)  # Demucs' random shift: same input -> same stem
    t0 = time.time()
    model = get_model(a.model); model.eval()
    wav = AudioFile(a.input).read(streams=0, samplerate=model.samplerate, channels=model.audio_channels)
    ref = wav.mean(0); wav = (wav - ref.mean()) / (ref.std() + 1e-8)
    with torch.no_grad():
        sources = apply_model(model, wav[None], device=a.device, shifts=a.shifts, split=True, overlap=0.25, progress=False)[0]
    sources = sources * (ref.std() + 1e-8) + ref.mean()
    vocals = sources[model.sources.index('vocals')]
    peak = float(vocals.abs().max())
    if peak > 0.999: vocals = vocals / peak * 0.999
    sf.write(a.output, vocals.cpu().numpy().T, model.samplerate, subtype='PCM_16')
    print('vocals written in %.1f s (%s, %s)' % (time.time() - t0, a.model, a.device), file=sys.stderr)


if __name__ == '__main__':
    main()
