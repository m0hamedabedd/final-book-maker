from http.server import BaseHTTPRequestHandler
from urllib.parse import urlparse, parse_qs
import json


class handler(BaseHTTPRequestHandler):
    def do_GET(self):
        parsed = urlparse(self.path)
        params = parse_qs(parsed.query)

        playlist_id = params.get("id", [None])[0]
        if not playlist_id:
            self._json(400, {"error": "Missing playlist id"})
            return

        # Build the full playlist URL if a raw ID was passed
        if playlist_id.startswith("PL") or playlist_id.startswith("UU") or playlist_id.startswith("FL") or playlist_id.startswith("RD"):
            playlist_url = f"https://www.youtube.com/playlist?list={playlist_id}"
        else:
            playlist_url = playlist_id  # caller passed a full URL

        try:
            from pytubefix import Playlist

            pl = Playlist(playlist_url)
            # pytubefix exposes .videos (Channel/Playlist objects) and .video_urls
            video_urls = list(pl.video_urls)

            # Extract video IDs and titles together to avoid a second round-trip
            videos = []
            for video in pl.videos:
                try:
                    videos.append({"id": video.video_id, "title": video.title})
                except Exception:
                    # Fall back to just the ID if title fetch fails
                    import re
                    m = re.search(r"v=([0-9A-Za-z_-]{11})", video.watch_url)
                    if m:
                        videos.append({"id": m.group(1), "title": None})

            video_ids = [v["id"] for v in videos]

            self._json(200, {
                "playlistTitle": pl.title,
                "videoIds": video_ids,
                "videos": videos,   # includes titles so the frontend can skip /api/video calls
                "shortIds": [],
                "liveIds": [],
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
        pass  # suppress default stderr logging
