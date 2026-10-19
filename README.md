# WA Web Chat Exporter v3.0

**WA Web Chat Exporter** is a privacy-focused browser extension (Chrome and Firefox, Manifest V3) that exports WhatsApp Web chats to TXT, JSON or CSV. Everything runs in your browser: no data is sent anywhere unless you enable the optional Gemini AI features with your own API key.

---

## Extraction engines

* **Auto (default)**: reads the open chat from WhatsApp Web's own local message store through a minimal, read-only build of [WA-JS](https://github.com/wppconnect-team/wa-js). It does not scroll, so it is faster than the DOM engine (about 17 messages per second, paced on purpose) and gets exact timestamps, types, line breaks, reactions, poll votes and sender names. If WA-JS cannot be used, the export falls back to the DOM engine automatically.
* **Classic DOM**: auto-scrolls the chat and parses the rendered messages, as in v2.

### How the WA-JS engine stays read-only

* It is injected only when you start an export, never when WhatsApp loads or when you open the popup.
* The bundle is vendored and version-pinned (`vendor/wa-js/`); no remote code is ever loaded.
* Only WA-JS' module loader is bundled. The WhatsApp modules it reads (chat and message collections, the local message, reaction and poll-vote tables, contacts) are imported by name, and only if WhatsApp has already loaded them itself. None of WA-JS' events, patches or telemetry are included.
* A small facade (`wajs/host.js`) is the only code with access to the bundle and exposes read functions only; `scripts/check-readonly.mjs` enforces the allowlist.
* Reads are paced in small batches with pauses; one chat at a time.
* If a WhatsApp Web update breaks compatibility, that WhatsApp version is remembered for 7 days and the DOM engine is used directly.

## Features

* **Scopes**: date range, last *N* messages, or everything.
* **Formats**:
  * **TXT**: chronological transcript with replies, media labels, `(forwarded)`/`(edited)` flags, reactions (`[Reactions: 👍2 ❤️1]`) and AI captions/transcripts.
  * **JSON**: metadata plus one object per message. WA-JS exports add `id`, `chatId`, `fromMe`, `senderId`, `senderLid`, `senderPhone`, `isForwarded`, `isEdited`, `mentions`, `reactions`, `poll` (options with `votes`/`voters`), `location` and `media` (with `status`).
  * **CSV**: the v2 columns, followed by `MessageId`, `SenderId`, `IsForwarded`, `IsEdited`, `Reactions` and `MediaStatus`. Cells are protected against formula injection.
* **Media thumbnails**: taken from local sources only (thumbnails stored in the message and WhatsApp's media caches).
* **Download missing media** (WA-JS, off by default): the same call as tapping *Download*, limited to recent images, stickers and voice notes (14 days by default, 30 at most), 30 per export, one at a time with pauses, stopping at the first expired item.
* **Load older messages from phone** (WA-JS, off by default): when the local cache ends before the chosen scope, the chat is scrolled and WhatsApp's *"older messages from your phone"* notice is tapped once, then the newly synced messages are read. If a sync brings nothing, it is not repeated for that chat for 7 days.
* **AI with Google Gemini** (optional, your own API key): image captions in batches of 4 and voice-note transcription (up to 5 minutes), with model fallback, rate limiting and a request budget.
* **Background execution and cancellation**: you can close the popup while an export runs; any export can be cancelled.

## Privacy and limitations

* Exports contain what WhatsApp Web shows you. In groups, participants that are not in your address book appear with the name they chose; their phone number is never requested and stays empty. For address-book contacts, the number WhatsApp already knows locally is included.
* Older media may have expired on WhatsApp's servers. It is reported as `media.status: "expired"`; downloading it is not attempted because WhatsApp would ask the sender's phone to upload it again.
* System notices (pins, security codes, group events) are left out by both engines.
* Cancelling an export keeps the messages collected so far and marks the export as partial.
* The DOM engine only sees what WhatsApp has loaded: older history may need WhatsApp's *"older messages from your phone"* notice, which it taps when needed.

---

## Installation

1. Clone or download this repository.
2. Open your browser's extension page:
   * **Chrome / Brave / Edge**: `chrome://extensions/`, enable **Developer mode**, then **Load unpacked** and select the folder that contains `manifest.json`.
   * **Firefox 128 or later**: `about:debugging#/runtime/this-firefox`, then **Load Temporary Add-on** and select `manifest.json`.

## Usage

1. Open [WhatsApp Web](https://web.whatsapp.com/) and open the chat you want to export.
2. Click the extension icon.
3. Choose the scope, the format and, under advanced options, the engine and extras.
4. Click **Copy Text** or **Download**.

---

## Project structure

```
WA-Exporter/
├── manifest.json            # Manifest V3 (Chrome and Firefox)
├── background.js            # Downloads, Gemini proxy, on-demand WA-JS injection, compatibility cache
├── ai/gemini.js             # Gemini captions and transcription
├── db/
│   ├── bridge.js            # Content-script bridge to the MAIN world (DOM engine)
│   └── page-script.js       # MAIN world: audio capture and thumbnails (DOM engine)
├── export/formatters.js     # TXT / JSON / CSV
├── extraction/
│   ├── main.js              # Orchestrator: WA-JS first, DOM fallback, media and AI pipeline
│   ├── wajs-client.js       # Messages to the WA-JS host
│   ├── wajs-engine.js       # Paced paging, reactions, votes, names, media
│   ├── wajs-mapper.js       # WA-JS messages to the export schema, merge with DOM results
│   ├── selectors.js         # DOM engine: selectors
│   ├── parsers.js           # DOM engine: message parsing
│   └── scroller.js          # DOM engine: auto-scroll
├── wajs/host.js             # MAIN world: read-only facade over the WA-JS bundle
├── vendor/wa-js/<version>/  # Pinned minimal WA-JS bundle, license and build info
├── popup/                   # Popup UI
├── scripts/                 # WA-JS build, read-only check, dev Chrome launcher
└── tests/                   # Node tests with synthetic data
```

## Development

* Tests: `node --test tests/*.test.cjs`
* Read-only check of the WA-JS facade: `node scripts/check-readonly.mjs`
* Rebuild the WA-JS bundle from a pinned tag: `scripts/build-wajs.sh 4.6.1` (the build fails if excluded WA-JS modules or module lookups slip in).

## License

MIT. The bundled WA-JS build (`vendor/wa-js/`) is © WPPConnect Team, licensed under the Apache License 2.0; see the license files in that folder.
