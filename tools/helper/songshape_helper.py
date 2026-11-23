#!/usr/bin/env python3
"""Song Shape local-only, opt-in separation/alignment helper (Python stdlib).

No bundled models, no pip install, no network fetch, no shell execution. The user explicitly
configures argv arrays for tools already on disk. Bind: IPv4 loopback only. A random per-run
capability token is required on all requests. Origin allowlist: null (file://), and loopback
HTTP pages; not the public web. No filesystem paths are accepted from the page.

python songshape_helper.py --config helper-config.json [--port 8766] [--work-dir <private temp>]
The token is printed once. Do not save it to a project export or include it in screenshots.
"""
import argparse, hmac, json, os, re, secrets, shutil, subprocess, tempfile, threading, time, uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse
MAX_AUDIO = 100 * 1024 * 1024
MAX_JSON = 2 * 1024 * 1024


def allowed_origin(origin):
    if not origin or origin == 'null': return True
    try:
        u = urlparse(origin)
        return u.scheme == 'http' and u.hostname in ('127.0.0.1', 'localhost', '::1') and not u.username and not u.password
    except Exception: return False


def valid_host(host):
    return bool(re.fullmatch(r'(127\.0\.0\.1|localhost)(:\d{1,5})?', host or ''))


def safe_argv(template, **values):
    if not isinstance(template, list) or not template or len(template) > 100 or not all(isinstance(a, str) for a in template):
        raise ValueError('Configure a nonempty argv array for this tool; no shell strings.')
    allowed = {'input', 'output', 'outdir', 'words', 'device'}
    for a in template:
        if any(k not in allowed for k in re.findall(r'\{(\w+)\}', a)): raise ValueError('Unknown config placeholder.')
    return [a.format(**values) for a in template]


def tool_report(config):
    """Each configured tool with its path and whether it exists (v0.2.11 fix6). Shown by the page's Check helper."""
    out = []
    listed = config.get('tools')
    if isinstance(listed, list):
        for t in listed[:40]:
            if isinstance(t, dict) and isinstance(t.get('name'), str):
                p = t.get('path') if isinstance(t.get('path'), str) else ''
                out.append({'name': t['name'][:80], 'path': p[:400], 'found': bool(p) and os.path.exists(p)})
        return out
    for key in ('separator', 'aligner'):
        argv = config.get(key)
        if isinstance(argv, list) and argv:
            exe = argv[0] if os.path.isabs(argv[0]) else (shutil.which(argv[0]) or argv[0])
            out.append({'name': key + ' program', 'path': exe, 'found': os.path.exists(exe)})
            for a in argv[1:]:
                if isinstance(a, str) and a.endswith('.py'): out.append({'name': key + ' script', 'path': a, 'found': os.path.exists(a)})
    ff = os.environ.get('SS_FFMPEG') or shutil.which('ffmpeg') or ''
    out.append({'name': 'ffmpeg', 'path': ff or 'ffmpeg (not on PATH)', 'found': bool(ff) and os.path.exists(ff)})
    th = os.environ.get('TORCH_HOME', '')
    out.append({'name': 'model folder (TORCH_HOME)', 'path': th or '(not set: default cache)', 'found': bool(th) and os.path.isdir(th)})
    return out


def check_tool_paths(template, kind):
    """Clear 'not found' before running: the program and any .py script in the argv must exist."""
    if not isinstance(template, list) or not template: return
    exe = template[0]
    if os.path.isabs(exe) and not os.path.exists(exe): raise ValueError('%s not found: %s. Fix the path in SongShape_Tools\\songshape-tools.json and restart Song Shape.' % (kind, exe))
    if not os.path.isabs(exe) and not shutil.which(exe): raise ValueError('%s not found: %s is not on PATH.' % (kind, exe))
    for a in template[1:]:
        if isinstance(a, str) and a.endswith('.py') and not os.path.exists(a): raise ValueError('%s script not found: %s.' % (kind, a))
    if not (os.environ.get('SS_FFMPEG') and os.path.exists(os.environ['SS_FFMPEG'])) and not shutil.which('ffmpeg'):
        raise ValueError('ffmpeg not found (needed to read the audio). Set "ffmpeg" in SongShape_Tools\\songshape-tools.json and restart Song Shape.')


def run_tool(template, root, timeout, **values):
    argv = safe_argv(template, **values)
    # Capture output privately; never return full logs to a page (may contain local paths/tokens).
    log = root / ('tool-' + uuid.uuid4().hex + '.log')
    with open(log, 'wb') as f:
        p = subprocess.run(argv, shell=False, cwd=str(root), stdout=f, stderr=subprocess.STDOUT, timeout=timeout)
    if p.returncode: raise ValueError('Local tool failed (exit %d). Check its private helper log.' % p.returncode)


class App:
    def __init__(self, config, root, token):
        self.config, self.root, self.token = config, root, token
        self.audio = {}; self.lock = threading.Lock(); self.job_lock = threading.Lock()

    def store(self, data, name):
        ext = '.mp3' if str(name).lower().endswith('.mp3') else '.wav'
        aid = uuid.uuid4().hex
        p = self.root / (aid + ext); p.write_bytes(data)
        with self.lock: self.audio[aid] = p
        return aid, p


class Handler(BaseHTTPRequestHandler):
    server_version = 'SongShapeHelper/0.2.11'
    def log_message(self, *_): pass  # tokens and filenames never go to HTTP logs

    def cors(self):
        o = self.headers.get('Origin')
        if o and allowed_origin(o): self.send_header('Access-Control-Allow-Origin', o)
        self.send_header('Vary', 'Origin')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type, X-SongShape-Token, X-Filename')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        self.send_header('Access-Control-Expose-Headers', 'X-Audio-Id')
        self.send_header('Access-Control-Allow-Private-Network', 'true')
        self.send_header('Cache-Control', 'no-store')
        self.send_header('X-Content-Type-Options', 'nosniff')

    def reply(self, code, data, typ='application/json', headers=None):
        if not isinstance(data, bytes): data = json.dumps(data).encode()
        self.send_response(code); self.cors(); self.send_header('Content-Type', typ); self.send_header('Content-Length', str(len(data)))
        for k, v in (headers or {}).items(): self.send_header(k, v)
        self.end_headers(); self.wfile.write(data)

    def authorized(self):
        if not valid_host(self.headers.get('Host')) or not allowed_origin(self.headers.get('Origin')):
            self.reply(403, {'error': 'Only local Song Shape pages are allowed.'}); return False
        token = self.headers.get('X-SongShape-Token', '')
        if not hmac.compare_digest(token, self.server.app.token):
            self.reply(401, {'error': 'Missing or invalid helper token.'}); return False
        return True

    def body(self, limit):
        n = int(self.headers.get('Content-Length', '0'))
        if n <= 0 or n > limit: raise ValueError('Request is empty or exceeds the size limit.')
        data = self.rfile.read(n)
        if len(data) != n: raise ValueError('Incomplete request.')
        return data

    def do_OPTIONS(self):
        if not valid_host(self.headers.get('Host')) or not allowed_origin(self.headers.get('Origin')):
            self.reply(403, {'error': 'Origin rejected.'}); return
        self.reply(204, b'')

    def do_GET(self):
        if not self.authorized(): return
        if self.path != '/health': self.reply(404, {'error': 'Unknown route.'}); return
        c = self.server.app.config
        self.reply(200, {'ok': True, 'version': '0.2.11-dev', 'separator_configured': bool(c.get('separator')), 'aligner_configured': bool(c.get('aligner')), 'device': c.get('device', 'cpu'),
                         'tools_home': c.get('tools_home') if isinstance(c.get('tools_home'), str) else None, 'tools': tool_report(c)})

    def do_POST(self):
        if not self.authorized(): return
        app = self.server.app
        try:
            if self.path in ('/upload', '/separate'):
                data = self.body(MAX_AUDIO)
                # WAV or MP3 headers only (ffmpeg also validates on actual use).
                if not (data[:4] == b'RIFF' and data[8:12] == b'WAVE' or data[:3] == b'ID3' or len(data) > 1 and data[0] == 0xff and data[1] & 0xe0 == 0xe0):
                    raise ValueError('Only WAV or MP3 bytes are accepted.')
                aid, p = app.store(data, self.headers.get('X-Filename', 'audio.wav'))
                if self.path == '/upload': self.reply(200, {'audio_id': aid}); return
                if not app.config.get('separator'): raise ValueError('No separator configured. Load a vocal stem or configure Demucs/MDX locally.')
                if not app.job_lock.acquire(False): self.reply(409, {'error': 'A tool job is already running.'}); return
                try:
                    check_tool_paths(app.config['separator'], 'Separator')
                    outdir = app.root / (aid + '_stems'); outdir.mkdir()
                    out = outdir / 'vocals.wav'
                    run_tool(app.config['separator'], app.root, app.config.get('timeout_s', 1800), input=str(p), output=str(out), outdir=str(outdir), words='', device=app.config.get('device', 'cpu'))
                    # Demucs writes a nested model/track/vocals.wav; a configured tool may instead write directly.
                    if not out.exists():
                        matches = list(outdir.rglob('vocals.wav'))
                        if len(matches) != 1: raise ValueError('Separator did not produce exactly one vocals.wav.')
                        out = matches[0]
                    if not out.resolve().is_relative_to(app.root.resolve()) or out.stat().st_size > MAX_AUDIO: raise ValueError('Invalid or oversized separator output.')
                    sid = uuid.uuid4().hex
                    with app.lock: app.audio[sid] = out
                    self.reply(200, out.read_bytes(), 'audio/wav', {'X-Audio-Id': sid})
                finally: app.job_lock.release()
            elif self.path == '/align':
                data = json.loads(self.body(MAX_JSON))
                aid = data.get('audio_id')
                with app.lock: p = app.audio.get(aid)
                if not p: raise ValueError('Unknown audio id; upload the stem first.')
                words = data.get('words')
                if not isinstance(words, list) or not words or len(words) > 20000: raise ValueError('words[] is required (1–20,000).')
                if any(not isinstance(w, dict) or not isinstance(w.get('text'), str) or len(w['text']) > 200 for w in words): raise ValueError('Invalid word.')
                if not app.config.get('aligner'): raise ValueError('No aligner configured. Import local word timings or use manual word placement.')
                if not app.job_lock.acquire(False): self.reply(409, {'error': 'A tool job is already running.'}); return
                try:
                    check_tool_paths(app.config['aligner'], 'Aligner')
                    job = uuid.uuid4().hex
                    wp = app.root / (job + '_words.json'); op = app.root / (job + '_alignment.json')
                    wp.write_text(json.dumps({'words': words}), encoding='utf-8')
                    run_tool(app.config['aligner'], app.root, app.config.get('timeout_s', 1800), input=str(p), words=str(wp), output=str(op), outdir=str(app.root), device=app.config.get('device', 'cpu'))
                    if not op.exists() or op.stat().st_size > MAX_JSON: raise ValueError('Aligner output missing or too large.')
                    out = json.loads(op.read_text(encoding='utf-8'))
                    if not isinstance(out, dict) or not isinstance(out.get('words'), list): raise ValueError('Aligner must return a words[] array.')
                    self.reply(200, out)
                finally: app.job_lock.release()
            else: self.reply(404, {'error': 'Unknown route.'})
        except (ValueError, KeyError, json.JSONDecodeError) as e: self.reply(400, {'error': str(e)[:300]})
        except subprocess.TimeoutExpired: self.reply(504, {'error': 'The local tool timed out; its work was stopped.'})
        except Exception: self.reply(500, {'error': 'Local helper error. Check the private work directory and tool configuration.'})


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--config', required=True); ap.add_argument('--port', type=int, default=8766); ap.add_argument('--work-dir')
    a = ap.parse_args()
    cfg = json.loads(Path(a.config).read_text(encoding='utf-8'))
    root = Path(a.work_dir) if a.work_dir else Path(tempfile.mkdtemp(prefix='songshape-helper-'))
    root.mkdir(parents=True, exist_ok=True)
    try: os.chmod(root, 0o700)
    except OSError: pass
    token = secrets.token_urlsafe(32)
    srv = ThreadingHTTPServer(('127.0.0.1', a.port), Handler)
    srv.app = App(cfg, root.resolve(), token)
    print('Song Shape helper: http://127.0.0.1:%d' % a.port, flush=True)
    print('Token (paste in the local page only): ' + token, flush=True)
    print('Private work directory: ' + str(root), flush=True)
    print('No tools run until the page asks. Stop with Ctrl+C. Delete the private work directory yourself when done.')
    try: srv.serve_forever()
    except KeyboardInterrupt: pass
    finally: srv.server_close()

if __name__ == '__main__': main()
