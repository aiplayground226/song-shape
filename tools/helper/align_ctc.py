#!/usr/bin/env python3
"""Song Shape v0.2.11 optional local aligner: known-lyrics CTC forced alignment.

Runs on the user's machine only. Needs torch + torchaudio (BSD) installed by the user.
Default model: torchaudio WAV2VEC2_ASR_LARGE_LV60K_960H / BASE_960H (fairseq wav2vec 2.0, MIT-licensed
weights, English letters). 'mms' (MMS_FA) is offered for comparison only: its weights are CC-BY-NC-4.0,
so do not use it for commercial output.

Usage: align_ctc.py <audio> <words.json> <out.json> [--model base|large|mms] [--device cpu|cuda]
words.json: {"words":[{"id":..., "text":...}, ...]}   (skipped words already removed)
out.json: {"words":[{"text","start","end","score","chars":[{"c","start","end","score"}]}], "meta":{...}}
Audio is decoded with the user's ffmpeg (SS_FFMPEG or ffmpeg on PATH). No network except the
first-time torchaudio weight download, which the user starts.
"""
import argparse, json, os, re, subprocess, sys, time

SR = 16000
ONES = 'zero one two three four five six seven eight nine'.split()

def decode(path):
    import numpy as np, torch
    ffmpeg = os.environ.get('SS_FFMPEG', 'ffmpeg')
    raw = subprocess.run([ffmpeg, '-v', 'error', '-i', path, '-ac', '1', '-ar', str(SR), '-f', 'f32le', '-'],
                         stdout=subprocess.PIPE, check=True).stdout
    return torch.from_numpy(np.frombuffer(raw, dtype=np.float32).copy())

def norm(w):
    w = w.lower().replace('\u2019', "'").replace('\u2018', "'")
    w = re.sub(r'\d', lambda m: ' ' + ONES[int(m.group())] + ' ', w)
    w = re.sub(r"[^a-z']", '', w).strip("'")
    # v0.2.11 fix4: a stretched spelling ("ho-nooor", "ooo") is one held word: align it as the plain word.
    return re.sub(r'([a-z])\1{2,}', r'\1', w)

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('audio'); ap.add_argument('words'); ap.add_argument('out')
    ap.add_argument('--model', default='base', choices=['base', 'large', 'mms'])
    ap.add_argument('--device', default='cpu')
    a = ap.parse_args()
    import torch, torchaudio
    import torchaudio.functional as F
    t0 = time.time()
    words = [w for w in json.load(open(a.words, encoding='utf-8'))['words'] if not w.get('skipped')]
    if a.model == 'mms':
        bundle = torchaudio.pipelines.MMS_FA
        model = bundle.get_model(with_star=False).to(a.device).eval()
        d = bundle.get_dict(star=None); blank = 0
        lookup = lambda c: d.get(c)
    else:
        bundle = torchaudio.pipelines.WAV2VEC2_ASR_BASE_960H if a.model == 'base' else torchaudio.pipelines.WAV2VEC2_ASR_LARGE_LV60K_960H
        model = bundle.get_model().to(a.device).eval()
        labels = bundle.get_labels(); d = {c: i for i, c in enumerate(labels)}; blank = 0
        lookup = lambda c: d.get(c.upper())
    wav = decode(a.audio)
    dur = wav.numel() / SR
    chunk, ctx = 20 * SR, 1 * SR
    ems = []
    with torch.inference_mode():
        for s in range(0, wav.numel(), chunk):
            lo_i, hi_i = max(0, s - ctx), min(wav.numel(), s + chunk + ctx)
            em, _ = model(wav[lo_i:hi_i].unsqueeze(0).to(a.device))
            em = em[0].float().cpu()
            fps = em.shape[0] / ((hi_i - lo_i) / SR)
            lo = int(round((s - lo_i) / SR * fps)); hi = lo + int(round(min(chunk, wav.numel() - s) / SR * fps))
            ems.append(em[lo:hi])
    emission = torch.log_softmax(torch.cat(ems), dim=-1)
    frame_s = dur / emission.shape[0]
    # v0.2.11 fix2: a "sung but not in the lyrics" token (star) at the start, between lines and at the end.
    # It absorbs backing vocals, ad-libs and held notes between lines instead of stretching or squeezing
    # lyric words. Its score is log(1 - p_blank): any non-silent sound. Lines come from words[].line_id
    # when the page sends it; without line ids only the start/end stars are used.
    star = emission.shape[1]
    emission = torch.cat([emission, torch.log((1 - emission[:, blank].exp()).clamp_min(1e-8)).unsqueeze(1)], dim=1)
    lines = [w.get('line_id') if isinstance(w.get('line_id'), str) else None for w in words]
    use_lines = any(lines)
    sep = lookup('|') if a.model != 'mms' else None
    def build(lo, hi):
        toks, own, lets = [star], [-2], ['*']
        for wi in range(lo, hi):
            w = words[wi]
            for c in norm(w['text']):
                t = lookup(c)
                if t is not None: toks.append(t); own.append(wi); lets.append(c)
            if wi < hi - 1:
                # v0.2.11 fix4: a word ending in an ellipsis is followed by a pause: allow a gap or a held note there.
                if (use_lines and lines[wi + 1] != lines[wi]) or w.get('pause_after') is True: toks.append(star); own.append(-2); lets.append('*')
                elif sep is not None: toks.append(sep); own.append(-1); lets.append('|')
        toks.append(star); own.append(-2); lets.append('*')
        return toks, own, lets
    # Frames in (near) digital silence: a word placed only there was not heard in the audio.
    hop = max(1, wav.numel() // emission.shape[0])
    fr = wav[: hop * emission.shape[0]].reshape(emission.shape[0], hop).pow(2).mean(1).sqrt()
    silent = fr < max(1e-4, float(torch.quantile(fr, 0.95)) * 0.01)
    # v0.2.11 fix5: tapped line starts are hard anchors. words[i].line_start (seconds, already corrected for tap
    # latency) on a line's first word splits the song: each stretch between two taps is aligned on its own, so a
    # held note or an instrumental gap cannot drag words across a tapped line start. Untapped lines align as before.
    margin = round(0.35 / frame_s); T = emission.shape[0]
    cuts = []  # (word index, frame)
    for wi, w in enumerate(words):
        ls = w.get('line_start')
        if wi == 0 or not isinstance(ls, (int, float)) or isinstance(ls, bool) or not (0 <= ls <= dur): continue
        f = max(0, min(T - 1, int(round(ls / frame_s)) - margin))
        if cuts and f <= cuts[-1][1]: continue  # out of order: ignore this tap
        cuts.append((wi, f))
    bounds = [(0, 0)] + cuts + [(len(words), T)]
    def fits(i0, i1, f0, f1):
        toks = build(i0, i1)[0]
        return f1 - f0 >= len(toks) + sum(1 for x, y in zip(toks, toks[1:]) if x == y)
    keep = [bounds[0]]  # drop a tap whose stretch is too short for its words
    for k in range(1, len(bounds) - 1):
        if fits(keep[-1][0], bounds[k][0], keep[-1][1], bounds[k][1]): keep.append(bounds[k])
    if not fits(keep[-1][0], len(words), keep[-1][1], T) and len(keep) > 1: keep.pop()
    keep.append(bounds[-1])
    per = [[] for _ in words]
    for (i0, f0), (i1, f1) in zip(keep, keep[1:]):
        if i1 <= i0: continue
        toks, own, lets = build(i0, i1)
        ali, scores = F.forced_align(emission[f0:f1].unsqueeze(0).contiguous(), torch.tensor([toks], dtype=torch.int32), blank=blank)
        for sp, wi, c in zip(F.merge_tokens(ali[0], scores[0].exp()), own, lets):
            if wi >= 0:
                sp.start += f0; sp.end += f0
                per[wi].append((sp, c))
    taps_used = len(keep) - 2
    out, prev = [], 0.0
    for wi, w in enumerate(words):
        sps = per[wi]
        if not sps:
            out.append({'id': w.get('id'), 'text': w['text'], 'start': prev, 'end': prev, 'score': None, 'chars': []}); continue
        st, en = sps[0][0].start * frame_s, sps[-1][0].end * frame_s
        sc = sum(float(s.score) for s, _ in sps) / len(sps)
        # A short word aligned to the edge of a gap (e.g. "I" right before "wear") still counts as heard:
        # look 60 ms either side. Words sitting inside a longer silence stay flagged.
        pad = max(1, round(0.06 / frame_s))
        heard = any(not bool(silent[max(0, s.start - pad):s.end + pad].all()) for s, _ in sps)
        out.append({'id': w.get('id'), 'text': w['text'], 'start': round(st, 3), 'end': round(en, 3), 'score': round(sc, 3), 'in_silence': not heard,
                    'chars': [{'c': c, 'start': round(s.start * frame_s, 3), 'end': round(s.end * frame_s, 3), 'score': round(float(s.score), 3)} for s, c in sps]})
        prev = en
    meta = {'aligner': 'torchaudio forced_align', 'model': a.model, 'device': a.device, 'audio_seconds': round(dur, 2),
            'frame_ms': round(frame_s * 1000, 2), 'line_stars': use_lines, 'line_taps_used': taps_used, 'line_taps_sent': len(cuts), 'words_in_silence': sum(1 for o in out if o.get('in_silence')), 'seconds': round(time.time() - t0, 2), 'words': len(words),
            'license_note': 'MMS_FA weights are CC-BY-NC-4.0 (non-commercial)' if a.model == 'mms' else 'wav2vec2 960h weights: fairseq, MIT'}
    json.dump({'words': out, 'meta': meta}, open(a.out, 'w', encoding='utf-8'), ensure_ascii=False)
    print(json.dumps(meta))

if __name__ == '__main__':
    main()
