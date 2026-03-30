import re
import time
from youtube_transcript_api import YouTubeTranscriptApi
from youtube_transcript_api.formatters import TextFormatter
from pytubefix import Playlist

def extract_video_id(url):
    regex = r"(?:v=|\/)([0-9A-Za-z_-]{11}).*"
    match = re.search(regex, url)
    if match:
        return match.group(1)
    return None

def get_youtube_transcript(video_url, lang='en'):
    video_id = extract_video_id(video_url)
    if not video_id:
        return None, "Error: Invalid YouTube URL."
    try:
        ytt_api = YouTubeTranscriptApi()
        transcript_list = ytt_api.fetch(video_id, languages=[lang, 'en'])
        formatter = TextFormatter()
        return formatter.format_transcript(transcript_list), None
    except Exception as e:
        return None, f"Could not retrieve transcript: {str(e)}"

def scrape_playlist(playlist_url, lang='en', delay=1.5):
    """
    Scrapes transcripts from all videos in a YouTube playlist.
    
    Args:
        playlist_url: Full YouTube playlist URL
        lang: Preferred language for transcripts
        delay: Seconds to wait between requests (be polite to the API)
    """
    print(f"Loading playlist: {playlist_url}\n")
    
    try:
        pl = Playlist(playlist_url)
        playlist_title = pl.title
        video_urls = list(pl.video_urls)
    except Exception as e:
        print(f"Error loading playlist: {e}")
        return

    total = len(video_urls)
    print(f"Playlist: {playlist_title}")
    print(f"Total videos found: {total}\n")
    print("=" * 60)

    all_transcripts = []
    success_count = 0
    fail_count = 0

    for i, video_url in enumerate(video_urls, start=1):
        video_id = extract_video_id(video_url)
        print(f"[{i}/{total}] Processing: {video_url}")

        transcript, error = get_youtube_transcript(video_url, lang=lang)

        if transcript:
            success_count += 1
            print(f"  ✔ Transcript fetched ({len(transcript)} characters)")
            all_transcripts.append({
                "index": i,
                "url": video_url,
                "video_id": video_id,
                "transcript": transcript
            })
        else:
            fail_count += 1
            print(f"  ✘ Failed — {error}")
            all_transcripts.append({
                "index": i,
                "url": video_url,
                "video_id": video_id,
                "transcript": None
            })

        time.sleep(delay)

    print("\n" + "=" * 60)
    print(f"Done! ✔ {success_count} succeeded  ✘ {fail_count} failed out of {total} videos")

    # Save all transcripts to a single file
    output_filename = f"playlist_transcripts.txt"
    with open(output_filename, "w", encoding="utf-8") as f:
        f.write(f"PLAYLIST: {playlist_title}\n")
        f.write(f"URL: {playlist_url}\n")
        f.write(f"Total Videos: {total} | Success: {success_count} | Failed: {fail_count}\n")
        f.write("=" * 60 + "\n\n")

        for item in all_transcripts:
            f.write(f"VIDEO {item['index']}: {item['url']}\n")
            f.write("-" * 40 + "\n")
            if item["transcript"]:
                f.write(item["transcript"])
            else:
                f.write("[No transcript available]")
            f.write("\n\n" + "=" * 60 + "\n\n")

    print(f"\nAll transcripts saved to: {output_filename}")


if __name__ == "__main__":
    # Example: Python tutorials playlist by Corey Schafer
    playlist_url = "https://www.youtube.com/playlist?list=PL-osiE80TeTt2d9bfVyTiXJA-UTHn6WwU"
    
    scrape_playlist(playlist_url, lang='en', delay=1.5)