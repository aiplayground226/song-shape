#!/usr/bin/env python3
"""Synthesize the fictional Song Shape demo tone: rise, silence, pickup, nosedive.

Original audio. No copyrighted material. Output is 16-bit mono WAV at 44.1 kHz.
"""
from __future__ import annotations

import argparse
import math
from pathlib import Path

import numpy as np

SR = 44100


def envelope(n: int, attack: float = 0.015, release: float = 0.03) -> np.ndarray:
    env = np.ones(n, dtype=np.float64)
    a = min(n, int(SR * attack))
    r = min(n, int(SR * release))
    if a > 0:
        env[:a] = np.linspace(0, 1, a, endpoint=True)
    if r > 0:
        env[-r:] = np.linspace(1, 0, r, endpoint=True)
    return env


def chirp(freq_start: float, freq_end: float, duration: float, amp: float = 0.32) -> np.ndarray:
    n = int(round(SR * duration))
    freq = np.linspace(freq_start, freq_end, n, dtype=np.float64)
    phase = 2 * math.pi * np.cumsum(freq) / SR
    return (amp * np.sin(phase) * envelope(n)).astype(np.float64)


def silence(duration: float) -> np.ndarray:
    return np.zeros(int(round(SR * duration)), dtype=np.float64)


def build() -> np.ndarray:
    # Timeline (seconds):
    # 0.00-0.50  lead-in silence
    # 0.50-2.50  rise 220 Hz -> 698 Hz, arriving at a peak
    # 2.50-2.90  silence (the break)
    # 2.90-3.20  pickup near the peak (~680 Hz)
    # 3.20-5.40  nosedive 660 Hz -> 110 Hz
    # 5.40-6.20  low tail
    # 6.20-6.50  silence
    parts = [
        silence(0.50),
        chirp(220, 698, 2.00, amp=0.34),
        silence(0.40),
        chirp(680, 660, 0.30, amp=0.34),
        chirp(660, 110, 2.20, amp=0.33),
        chirp(110, 98, 0.80, amp=0.22),
        silence(0.30),
    ]
    audio = np.concatenate(parts)
    peak = np.max(np.abs(audio)) or 1.0
    audio = audio / peak * 0.89
    return audio


def write_wav(path: Path, audio: np.ndarray) -> None:
    pcm = np.int16(np.clip(audio, -1, 1) * 32767)
    import wave

    with wave.open(str(path), "w") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(SR)
        wf.writeframes(pcm.tobytes())


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--out",
        type=Path,
        default=Path(__file__).resolve().parents[1] / "demo" / "fictional_tone.wav",
    )
    args = parser.parse_args()
    args.out.parent.mkdir(parents=True, exist_ok=True)
    audio = build()
    write_wav(args.out, audio)
    print(f"wrote {args.out} duration={len(audio)/SR:.3f}s samples={len(audio)}")


if __name__ == "__main__":
    main()
