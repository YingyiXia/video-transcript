# Transcript

A minimal, English-language video transcription website. The video stays on the visitor's device. Speech mode transcribes with Whisper. Music mode separates vocals with Demucs ONNX, then transcribes the isolated vocals with Whisper. The transcript follows playback, and each timestamp or sentence can seek the video. Transcript text is regular selectable text. Copy all, Export .txt, and Export .srt are available.

## Preview on this Mac

Double-click `Open Website.command`. It serves the built website at a temporary local address and opens it in the browser. Keep the Terminal window open while using the preview. Opening the source `index.html` directly from Finder will not load Vite's JavaScript and styles.

## Develop and build

```sh
npm install
npm run dev
npm run build
```

The GitHub Actions workflow in `.github/workflows/pages.yml` builds and publishes `dist/` to GitHub Pages. In repository Settings → Pages, select **GitHub Actions** as the source. No custom domain, database, login, or server is required.

The first transcription downloads the Whisper Base model. Music mode also downloads a 166 MB Demucs vocals model. Both run on the visitor's device; no video or audio is uploaded. The browser must support the video's audio codec; MP4 with H.264/AAC or WebM is recommended. Audio is decoded and transcribed in short sections so memory use does not grow with the full video length. There is no fixed file-size limit, but long videos and music mode still need more processing time and device memory. Lyrics accuracy and timing vary with the mix, singing style, and device.

The vocals model and browser separation algorithm follow [StemSplit/demucs-onnx](https://github.com/StemSplit/demucs-onnx) (MIT). Speech recognition uses a browser conversion of OpenAI Whisper through Transformers.js.
