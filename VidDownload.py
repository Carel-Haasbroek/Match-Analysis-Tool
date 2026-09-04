import yt_dlp

def download_youtube_video(video_url, output_folder="downloads", browser="chrome"):
    """
    Downloads a YouTube video at the best available quality.

    YouTube blocks unauthenticated requests from many IPs ("Sign in to confirm
    you're not a bot" / HTTP 429). Passing cookies from a signed-in browser
    profile is the supported way around that, so `browser` names the browser to
    read them from ("chrome", "edge", "firefox", ...). Set it to None to skip.
    """
    # Configuration options for yt-dlp
    ydl_opts = {
        # Format selection: downloads best video and best audio,
        # or merges them into best single file if FFmpeg is installed
        'format': 'bestvideo+bestaudio/best',

        # Define output directory and file naming format
        'outtmpl': f'{output_folder}/%(title)s.%(ext)s',

        # Post-processor to merge audio/video tracks into an MP4 container
        'merge_output_format': 'mp4',

        # Retry the throttling errors YouTube hands out instead of giving up
        'retries': 10,
        'extractor_retries': 5,
    }

    if browser:
        # Reuse the signed-in session from the local browser profile
        ydl_opts['cookiesfrombrowser'] = (browser, None, None, None)

    try:
        print(f"Starting download for: {video_url}...")
        # Use YoutubeDL context manager to handle the download
        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            ydl.download([video_url])
        print("🎉 Download completed successfully!")
    except Exception as e:
        print(f"❌ An error occurred: {e}")
        print(
            "\nIf this says 'Sign in to confirm you're not a bot' or 'The page "
            "needs to be reloaded', YouTube is blocking this machine. Try:\n"
            "  1. Sign in to YouTube in the browser named above, then rerun.\n"
            "  2. Point `browser` at whichever browser you are signed in to.\n"
            "  3. Update yt-dlp: python -m pip install -U yt-dlp\n"
        )

if __name__ == "__main__":
    # Prompt the user to enter the video URL in the terminal
    url = input("Enter the YouTube video URL: ").strip()
    if url:
        download_youtube_video(url)
    else:
        print("No URL provided.")
