# WA Web Chat Exporter v2.0

**WA Web Chat Exporter** is a lightweight, privacy-focused browser extension for extracting and exporting chat histories directly from WhatsApp Web without sending any data to external servers.

---

## Key Features

* **Intelligent Dual-Engine Extraction**:
  * **IndexedDB Engine**: Instant local database retrieval from WhatsApp Web's internal storage when cached.
  * **Smart DOM Auto-Scroller**: Resilient auto-scrolling with `MutationObserver`, virtualization triggers, and phone history sync banners.
  * **Visual DOM Sequencing**: Assigns continuous DOM sequence indices (`domIndex`) across scroll batches to guarantee 100% faithful visual chat ordering even with ambiguous dates or missing date headers.
* **Seamless Background Execution**:
  * Manifest V3 service worker / background script bridge keeps extractions running if the popup closes.
  * Auto-downloads files or copies to clipboard upon completion with an in-page toast notification.
* **Automatic Phone History Sync**:
  * Automatically detects and triggers the *"Click here to get older messages from your phone"* banner when hitting local cache boundaries to pull deeper chat logs.
* **Context-Aware Date Parsing**:
  * Resolves ambiguous `DD/MM/YYYY` vs `MM/DD/YYYY` formats with chat context validation and isolated date divider tracking.
* **Local Media Thumbnail Capture**:
  * Extracts media blobs directly from WhatsApp Web memory, downscales via Offscreen Canvas, and embeds lightweight base64 Data URIs (120px / 160px / 256px) into JSON and CSV exports.
* **High-Efficiency AI Image Captioning (Google Gemini)**:
  * **Batched Vision Calls**: Captions up to 4 images per API request, cutting latency by 75% and maximizing free-tier quotas.
  * **Dynamic Model Fallback Cascade**: Prioritizes high-RPD models (`gemini-3.5-flash-lite`, `gemini-3.1-flash-lite`) with automatic fallback to `gemini-3.7-flash` and others on 429/404 errors.
  * **Customizable Prompts**: Localized defaults with support for user-defined descriptive prompts.
  * **Key Validation & Safety**: Built-in RPM rate-limiting and API key status checker.
* **AI Voice Note Transcription (Google Gemini)**:
  * **Zero-Disk Blob Interception**: Automates the native decryption pipeline in the page context (`MAIN` world) to capture ephemeral voice note audio Blobs in-memory without spamming local downloads.
  * **Speech-to-Text (STT) Processing**: Converts raw Opus/OGG audio streams to base64 and transcribes speech using Google Gemini models.
  * **Duration-Aware**: Automatically protects API quotas by safely processing voice notes under 5 minutes.
  * **Integrated Workflow**: Can be run concurrently or independently alongside image captioning with custom toggle controls.
* **Multiple Export Formats**:
  * **TXT**: Clean, chronological transcript with timestamps, senders, replies, media labels, image AI descriptions, and voice note transcriptions (`[Voice Note] [AI Transcript: "..."]`).
  * **JSON**: Structured schema containing metadata, timestamps, senders, message types, thumbnails, AI captions, AI transcripts, and reply trees.
  * **CSV**: Tabular data ready for Excel, Sheets, and data pipelines (with dedicated `Thumbnail`, `AICaption`, and `AITranscript` columns).
* **Extraction Scope Options**:
  * **Date Range**: Filter messages between precise start and end dates/times.
  * **By Count**: Extract the latest *N* messages (e.g., 50, 100, 500, 3000+).
  * **All Cached**: Extract all accessible chat history.
* **Comprehensive Content Support**:
  * Text formatting, emojis, quoted replies, images, videos, GIFs, voice notes/audio, stickers, documents, polls, contacts (vCards), location links, and deleted/revoked messages.
* **100% Client-Side Privacy**:
  * All operations run strictly inside your browser. No data ever leaves your computer unless you explicitly enable Gemini AI captioning or voice note transcription with your own API key.

---

## Project Structure

```
WA-Exporter/
├── manifest.json                  # Manifest V3 configuration (Chrome & Firefox)
├── background.js                  # Background service worker & API proxy
├── README.md                      # Documentation
├── .gitignore                     # Git ignore rules
├── ai/
│   └── gemini.js                  # Batched Gemini vision & audio STT client, model cascade & rate limiter
├── db/
│   ├── page-script.js             # MAIN-world IndexedDB, audio blob interceptor & canvas engine
│   └── bridge.js                  # Content-script postMessage bridge
├── extraction/
│   ├── selectors.js               # WhatsApp Web DOM selectors
│   ├── parsers.js                 # Message element parsers & date format detector
│   ├── scroller.js                # DOM scroller with visual indexing & phone sync
│   └── main.js                    # Extraction coordinator & background auto-actions
└── popup/
    ├── popup.html                 # Extension popup interface with AI options & progress
    ├── popup.css                  # UI styling with dark mode support
    └── popup.js                   # Popup UI logic, formatters, and event listeners
```

---

## Installation

1. Clone or download this repository.
2. Open your browser's extension management page:
   * **Chrome / Brave / Edge**: `chrome://extensions/`
   * **Firefox**: `about:debugging#/runtime/this-firefox`
3. Enable **Developer mode**.
4. Click **Load unpacked** (or **Load Temporary Add-on** in Firefox) and select the project folder containing `manifest.json`.

---

## Usage

1. Open [WhatsApp Web](https://web.whatsapp.com/) and navigate to the chat you wish to export.
2. Click the **WA Chat Exporter** extension icon in your browser toolbar.
3. Choose your **Extraction Scope** (*Date Range*, *By Count*, or *All Cached*).
4. Choose your **Export Format** (*TXT*, *JSON*, or *CSV*).
5. Click **Copy Text** or **Download**. You can safely close the popup while extraction runs in the background.

---

## License

MIT License. Local and privacy-friendly.
