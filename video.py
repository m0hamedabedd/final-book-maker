from http.server import BaseHTTPRequestHandler
from urllib.parse import urlparse, parse_qs
import json


class handler(BaseHTTPRequestHandler):
    def do_GET(self):
        parsed = urlparse(self.path)
        params = parse_qs(parsed.query)

        video_id = params.get("id", [None])[0]
        if not video_id:
            self._json(400, {"error": "Missing video id"})
            return

        try:
            from pytubefix import YouTube

            yt = YouTube(f"https://www.youtube.com/watch?v={video_id}")
            self._json(200, {
                "id": video_id,
                "title": yt.title,
                "author": yt.author,
                "lengthSeconds": yt.length,
            })
        except Exception as e:
            self._json(500, {"error": str(e)})

    def _json(self, status: int, body: dict):
        data = json.dumps(body).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, *args):
        pass
