# WA Web Chat Exporter v2.0

**WA Web Chat Exporter** is a lightweight, privacy-focused browser extension for extracting and exporting chat histories directly from WhatsApp Web without sending any data to external servers.

---

## Key Features

* **Intelligent Dual-Engine Extraction**:
  * **IndexedDB Engine**: Instant local database retrieval from WhatsApp Web's internal storage when cached.
  * **Smart DOM Auto-Scroller**: Resilient auto-scrolling with `MutationObserver`, virtualization triggers, and chronological deduplication when deeper history is needed.
* **Seamless Background Execution**:
  * Closing the extension popup does not interrupt extraction.
  * Auto-downloads the file or copies text to the clipboard upon completion with an in-page floating toast notification.
* **Automatic Phone History Sync**:
  * Automatically detects and clicks the *"Click here to get older messages from your phone"* banner when hitting cache boundaries to load older messages over WebSocket.
* **Context-Aware Date Parsing**:
  * Dynamically handles international and US date formats (`DD/MM/YYYY` and `MM/DD/YYYY`) with chat-context validation to prevent premature extraction stops.
* **Multiple Export Formats**:
  * **TXT**: Clean, chronological transcript with timestamps, sender tags, quoted replies, and media labels.
  * **JSON**: Structured dataset containing timestamps, senders, message types, text, quoted contexts, and document metadata.
  * **CSV**: Spreadsheet-ready table compatible with Excel, Google Sheets, and data pipelines.
* **Extraction Scope Options**:
  * **Date Range**: Filter messages between precise start and end dates/times.
  * **By Count**: Extract the latest *N* messages (e.g., last 100, 500, 3000+).
  * **All Cached**: Extract the entire accessible chat history.
* **Rich Content & Message Types**:
  * Text, Emojis, and formatting
  * Quoted / Replied messages
  * Images, Videos, GIFs, and Stickers
  * Voice Notes and Audio
  * Documents (PDFs, spreadsheets, docs with clean filenames and extensions)
  * Polls, Contacts (vCards), and Location links
  * Deleted / Revoked messages
* **100% Client-Side Privacy**:
  * All operations run strictly inside your browser. No messages, tokens, or personal data ever leave your machine.

---

## Project Structure

```
WA-Exporter/
├── manifest.json                  # Manifest V3 configuration (Chrome & Firefox)
├── README.md                      # Documentation
├── .gitignore                     # Git ignore rules
├── db/
│   ├── page-script.js             # MAIN-world IndexedDB query engine
│   └── bridge.js                  # Content-script postMessage bridge
├── extraction/
│   ├── selectors.js               # Configurable WhatsApp Web DOM selectors
│   ├── parsers.js                 # Message element parsers & date format detector
│   ├── scroller.js                # Progressive DOM scroller & phone sync handler
│   └── main.js                    # Extraction coordinator & background auto-actions
└── popup/
    ├── popup.html                 # Clean popup interface
    ├── popup.css                  # Modern UI (Light & Dark theme support)
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
