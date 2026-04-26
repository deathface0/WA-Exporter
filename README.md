# WA Web Chat Exporter

WA Web Chat Exporter is a lightweight local browser extension designed to easily extract and export chat histories directly from WhatsApp Web without sending data to any external server. 

## Features

*   **Extraction Modes**: Choose to export messages between a specific date and time range, or simply capture the last *N* messages.
*   **Media and Context Aware**: Accurately recognizes and tags a variety of message types within the text output:
    *   Text and Emojis
    *   Quoted messages
    *   Deleted messages
    *   Images, Videos, and GIFs (captures Blob URLs when available)
    *   Audio / Voice notes
    *   Documents (PDFs, Excel, Word, Text, Zip, etc. with filenames)
    *   Stickers and Contacts
    *   Location links (Google Maps, Waze, etc.)
*   **Smart Auto-Scrolling**: Intelligently scrolls up through your chat window to automatically load older messages lazily until your target extraction range or count is met.
*   **Export Options**: One-click to copy the formatted text to your clipboard, or seamlessly download it as a `.txt` file.
*   **Modern UI**: Clean, responsive popup interface that natively supports your system's light and dark mode preferences.

## Installation

1. Clone or download this repository to your computer.
2. Open your Chromium-based browser (Chrome, Edge, Brave, etc.) and navigate to `chrome://extensions/`. Firefox is also supported via `about:debugging`.
3. Enable **Developer mode** (usually a toggle in the top right corner).
4. Click on **Load unpacked** and select the folder containing the extension's files (`manifest.json`, `content.js`, etc.).

## Usage

1. Navigate to [WhatsApp Web](https://web.whatsapp.com/) and open the specific chat you wish to export.
2. Click on the WA Web Chat Exporter extension icon in your browser toolbar.
3. Select your preferred extraction method:
    *   **By Date Range**: Select a Start and End timestamp to capture all messages in between.
    *   **By Count**: Enter the amount of recent messages you want to export.
4. Click **Copy Text** or **Download TXT**.
5. Wait for the extension to scroll and fetch your messages. It will let you know once it's done!

*Note: For very large extractions, please allow the browser some time to scroll through and parse the chat history.*

## How it Works

The extension operates completely locally in your browser. It injects a content script that interacts safely with the WhatsApp Web DOM. It simulates user scrolling to force the lazy-loading of older messages, parses complex inline timestamps, and intelligently traverses the DOM structure to extract text and interpret media metadata using element attributes and tags.

## Privacy Note
WA Web Chat Exporter is fully client-side. Your chats are processed locally inside your own browser window. No message data is ever stored remotely, transmitted, or sent to any external server.
