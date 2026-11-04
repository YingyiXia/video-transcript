# Transcript

A minimal, English-language video transcription website. The video stays on the visitor's device. Speech is transcribed in the browser with Whisper. The transcript follows playback, and each timestamp or sentence can seek the video. Transcript text is regular selectable text, so visitors can select all or part of it and copy it with their browser's normal controls. Copy all and Export .txt are also available.

## Preview on this Mac

Double-click `Open Website.command`. It serves the built website at a temporary local address and opens it in the browser. Keep the Terminal window open while using the preview. Opening the source `index.html` directly from Finder will not load Vite's JavaScript and styles.

## Develop and build

```sh
npm install
npm run dev
npm run build
```

The GitHub Actions workflow in `.github/workflows/pages.yml` builds and publishes `dist/` to GitHub Pages. In repository Settings → Pages, select **GitHub Actions** as the source. No custom domain, database, login, or server is required.

The first transcription downloads the Whisper Base model. The browser must support the video's audio codec; MP4 with H.264/AAC or WebM is recommended. Long videos need more time and device memory.
