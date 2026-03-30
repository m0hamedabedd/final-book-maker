"""
Local development server for the Python API functions.
Run this alongside `pnpm dev` so Vite can proxy /api/* to it.

Usage:
    python api_dev_server.py

Requires:
    pip install youtube-transcript-api pytubefix
"""

import json
import re
import os
import sys
from http.server import BaseHTTPRequestHandler, HTTPServer
from urllib.parse import urlparse, parse_qs


# ── helpers ──────────────────────────────────────────────────────────────────

def extract_video_id(url_or_id: str) -> str | None:
    if re.fullmatch(r"[0-9A-Za-z_-]{11}", url_or_id):
        return url_or_id
    m = re.search(r"(?:v=|/)([0-9A-Za-z_-]{11})", url_or_id)
    return m.group(1) if m else None


def detect_language(text: str) -> str:
    if not text:
        return "en"
    arabic = sum(1 for c in text if "\u0600" <= c <= "\u06FF")
    return "ar" if arabic / len(text) > 0.10 else "en"


def json_response(handler: BaseHTTPRequestHandler, status: int, body: dict):
    data = json.dumps(body, ensure_ascii=False).encode("utf-8")
    handler.send_response(status)
    handler.send_header("Content-Type", "application/json; charset=utf-8")
    handler.send_header("Content-Length", str(len(data)))
    handler.send_header("Cache-Control", "no-store")
    handler.send_header("Access-Control-Allow-Origin", "*")
    handler.end_headers()
    handler.wfile.write(data)


# ── route handlers ────────────────────────────────────────────────────────────

def handle_playlist(handler: BaseHTTPRequestHandler, params: dict):
    playlist_id = (params.get("id") or [None])[0]
    if not playlist_id:
        json_response(handler, 400, {"error": "Missing playlist id"})
        return

    if re.match(r"^(PL|UU|FL|RD|OL)", playlist_id):
        playlist_url = f"https://www.youtube.com/playlist?list={playlist_id}"
    else:
        playlist_url = playlist_id

    try:
        from pytubefix import Playlist
        pl = Playlist(playlist_url)
        videos = []
        for video in pl.videos:
            try:
                videos.append({"id": video.video_id, "title": video.title})
            except Exception:
                m = re.search(r"v=([0-9A-Za-z_-]{11})", video.watch_url)
                if m:
                    videos.append({"id": m.group(1), "title": None})

        json_response(handler, 200, {
            "playlistTitle": pl.title,
            "videoIds": [v["id"] for v in videos],
            "videos": videos,
            "shortIds": [],
            "liveIds": [],
        })
    except Exception as e:
        json_response(handler, 500, {"error": str(e)})


def handle_video(handler: BaseHTTPRequestHandler, params: dict):
    video_id = (params.get("id") or [None])[0]
    if not video_id:
        json_response(handler, 400, {"error": "Missing video id"})
        return
    try:
        from pytubefix import YouTube
        yt = YouTube(f"https://www.youtube.com/watch?v={video_id}")
        json_response(handler, 200, {
            "id": video_id,
            "title": yt.title,
            "author": yt.author,
            "lengthSeconds": yt.length,
        })
    except Exception as e:
        json_response(handler, 500, {"error": str(e)})


def handle_transcript(handler: BaseHTTPRequestHandler, params: dict):
    video_id_raw = (params.get("videoId") or [None])[0]
    if not video_id_raw:
        json_response(handler, 400, {"error": "Missing videoId"})
        return

    video_id = extract_video_id(video_id_raw)
    if not video_id:
        json_response(handler, 400, {"error": f"Cannot parse video id: {video_id_raw}"})
        return

    try:
        from youtube_transcript_api import YouTubeTranscriptApi
        from youtube_transcript_api.formatters import TextFormatter

        ytt = YouTubeTranscriptApi()
        transcript_list = None

        for lang_pref in [["ar", "en"], ["en"], []]:
            try:
                if lang_pref:
                    transcript_list = ytt.fetch(video_id, languages=lang_pref)
                else:
                    available = ytt.list(video_id)
                    first = next(iter(available), None)
                    if first:
                        transcript_list = first.fetch()
                break
            except Exception:
                continue

        if transcript_list is None:
            json_response(handler, 404, {"error": f"No transcript for {video_id}"})
            return

        content = TextFormatter().format_transcript(transcript_list)
        json_response(handler, 200, {
            "videoId": video_id,
            "content": content,
            "lang": detect_language(content),
            "charCount": len(content),
        })
    except Exception as e:
        json_response(handler, 500, {"error": str(e)})


def handle_rewrite(handler: BaseHTTPRequestHandler):
    """Proxy to Gemini — reads GEMINI_API_KEY + GEMINI_MODEL from .env.local"""
    import urllib.request

    api_key = os.environ.get("GEMINI_API_KEY", "")
    model = os.environ.get("GEMINI_MODEL", "gemini-2.0-flash-lite")

    if not api_key:
        json_response(handler, 500, {"error": "GEMINI_API_KEY not set"})
        return

    length = int(handler.headers.get("Content-Length", 0))
    body = handler.rfile.read(length)

    url = f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent?key={api_key}"
    req = urllib.request.Request(
        url,
        data=body,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=120) as resp:
            data = resp.read()
            handler.send_response(resp.status)
            handler.send_header("Content-Type", "application/json")
            handler.send_header("Content-Length", str(len(data)))
            handler.send_header("Cache-Control", "no-store")
            handler.send_header("Access-Control-Allow-Origin", "*")
            handler.end_headers()
            handler.wfile.write(data)
    except urllib.error.HTTPError as e:
        data = e.read()
        handler.send_response(e.code)
        handler.send_header("Content-Type", "application/json")
        handler.send_header("Content-Length", str(len(data)))
        handler.end_headers()
        handler.wfile.write(data)


# ── HTTP handler ──────────────────────────────────────────────────────────────

class Handler(BaseHTTPRequestHandler):
    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()

    def do_GET(self):
        parsed = urlparse(self.path)
        params = parse_qs(parsed.query)
        path = parsed.path.rstrip("/")

        if path == "/api/playlist":
            handle_playlist(self, params)
        elif path == "/api/video":
            handle_video(self, params)
        elif path == "/api/transcript":
            handle_transcript(self, params)
        else:
            json_response(self, 404, {"error": f"Unknown route: {path}"})

    def do_POST(self):
        parsed = urlparse(self.path)
        path = parsed.path.rstrip("/")

        if path == "/api/rewrite":
            handle_rewrite(self)
        else:
            json_response(self, 404, {"error": f"Unknown route: {path}"})

    def log_message(self, fmt, *args):
        print(f"[dev-api] {self.address_string()} - {fmt % args}", file=sys.stderr)


# ── .env.local loader ─────────────────────────────────────────────────────────

def load_env_local():
    for name in (".env.local", ".env"):
        if os.path.exists(name):
            with open(name, encoding="utf-8") as f:
                for line in f:
                    line = line.strip()
                    if not line or line.startswith("#") or "=" not in line:
                        continue
                    key, _, value = line.partition("=")
                    os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))
            print(f"[dev-api] Loaded env from {name}")
            break


# ── entry point ───────────────────────────────────────────────────────────────

if __name__ == "__main__":
    load_env_local()
    port = int(os.environ.get("DEV_API_PORT", "3001"))
    server = HTTPServer(("127.0.0.1", port), Handler)
    print(f"[dev-api] Listening on http://127.0.0.1:{port}")
    print("[dev-api] Press Ctrl+C to stop")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n[dev-api] Stopped")
