from http.server import BaseHTTPRequestHandler
from urllib.parse import urlparse, parse_qs
import json
import re


def extract_video_id(url_or_id: str) -> str | None:
    """Accept either a bare video ID or a full YouTube URL."""
    if re.fullmatch(r"[0-9A-Za-z_-]{11}", url_or_id):
        return url_or_id
    m = re.search(r"(?:v=|/)([0-9A-Za-z_-]{11})", url_or_id)
    return m.group(1) if m else None


def detect_language(text: str) -> str:
    """Very lightweight heuristic: if >10 % of chars are Arabic, call it 'ar'."""
    if not text:
        return "en"
    arabic = sum(1 for c in text if "\u0600" <= c <= "\u06FF")
    return "ar" if arabic / len(text) > 0.10 else "en"


class handler(BaseHTTPRequestHandler):
    def do_GET(self):
        parsed = urlparse(self.path)
        params = parse_qs(parsed.query)

        video_id_raw = params.get("videoId", [None])[0]
        # jobId is not used in this implementation (no async jobs needed)
        # but we keep the parameter so the frontend doesn't break if it sends one.

        if not video_id_raw:
            self._json(400, {"error": "Missing videoId"})
            return

        video_id = extract_video_id(video_id_raw)
        if not video_id:
            self._json(400, {"error": f"Could not parse video id from: {video_id_raw}"})
            return

        try:
            from youtube_transcript_api import YouTubeTranscriptApi
            from youtube_transcript_api.formatters import TextFormatter

            ytt = YouTubeTranscriptApi()

            # Try to get transcript — prefer Arabic then English then any available
            transcript_list = None
            lang_used = "en"

            for lang_pref in [["ar", "en"], ["en"], []]:
                try:
                    if lang_pref:
                        transcript_list = ytt.fetch(video_id, languages=lang_pref)
                    else:
                        # Fall back to whatever is available
                        available = ytt.list(video_id)
                        first = next(iter(available), None)
                        if first:
                            transcript_list = first.fetch()
                    break
                except Exception:
                    continue

            if transcript_list is None:
                self._json(404, {"error": f"No transcript available for video {video_id}"})
                return

            formatter = TextFormatter()
            content = formatter.format_transcript(transcript_list)
            lang = detect_language(content)

            self._json(200, {
                "videoId": video_id,
                "content": content,
                "lang": lang,
                "charCount": len(content),
            })

        except Exception as e:
            self._json(500, {"error": str(e)})

    def _json(self, status: int, body: dict):
        data = json.dumps(body, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, *args):
        pass
