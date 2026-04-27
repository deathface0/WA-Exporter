# WA-Exporter for Android

A native Android app that silently captures WhatsApp messages in real time by reading notifications — including messages that the sender later deletes. Everything is stored locally on your device with zero data ever leaving the phone.

## Features

### Real-Time Message Capture
WA-Exporter runs a `NotificationListenerService` in the background. Whenever a WhatsApp or WhatsApp Business notification arrives, the app extracts the sender, text, timestamp, and media type and persists them to a local Room database. Supports both Android's modern `MessagingStyle` API and a legacy fallback parser for older platforms.

### Deleted Message Recovery
When someone deletes a message, WhatsApp sends a "This message was deleted" notification. WA-Exporter intercepts this, marks the original message as deleted, and immediately alerts you with a system notification — so you can always read what was removed. Deletion phrases are matched across 12 locales (English, Spanish, Portuguese, French, German, Italian, Dutch, Turkish).

### Media-Aware Parsing
The capture engine identifies media types from notification content (photos, videos, voice messages, documents, stickers, GIFs, locations, contacts) and saves notification thumbnails to internal storage when available.

### Full-Text Search
Search across all captured messages instantly from a dedicated search screen.

### Multi-Format Export
Export any chat's history in three formats:
- **TXT** — Human-readable, timestamped log (compatible with the browser extension format).
- **JSON** — Structured output with message IDs, deletion flags, and media metadata.
- **CSV** — Spreadsheet-ready with headers.

Exports support filtering by date range or fetching the last *N* messages.

### Biometric App Lock
Optionally protect the app with fingerprint or device credentials on launch.

### Onboarding Flow
A guided setup wizard walks new users through granting Notification Access and disabling battery optimization to ensure reliable background capture.

### Danger Zone
A one-tap irreversible deletion of all captured chats, messages, and thumbnails for complete data cleanup.

## Architecture

```
com.waexporter
├── data
│   ├── db              # Room database, DAOs, entities (ChatEntity, MessageEntity)
│   ├── media           # Thumbnail file I/O (MediaFileManager)
│   └── repository      # MessageRepository — single source of truth with mutex-guarded writes
├── di                  # Hilt dependency injection (DatabaseModule)
├── domain/usecase      # ExportChatUseCase, SearchMessagesUseCase
├── navigation          # Jetpack Navigation Compose graph
├── service             # MessageCaptureService, DeletionAlertNotifier
└── ui
    ├── chat            # Chat detail screen + ViewModel
    ├── components      # ChatListItem, MessageBubble, DeletedMessageBadge, MediaPreviewCard
    ├── export          # Export screen + ViewModel
    ├── home            # Home screen (chat list) + ViewModel
    ├── lock            # Biometric lock screen
    ├── onboarding      # First-run setup wizard
    ├── search          # Search screen + ViewModel
    ├── settings        # Settings screen + ViewModel
    └── theme           # Material 3 color, typography, theme
```

## Tech Stack

| Layer | Technology |
|---|---|
| Language | Kotlin |
| UI | Jetpack Compose + Material 3 |
| DI | Hilt |
| Database | Room |
| Preferences | DataStore |
| Image Loading | Coil |
| Navigation | Navigation Compose |
| Min SDK | 29 (Android 10) |
| Target SDK | 35 |

## Permissions

| Permission | Purpose |
|---|---|
| `BIND_NOTIFICATION_LISTENER_SERVICE` | Core capture engine — reads WhatsApp notifications |
| `FOREGROUND_SERVICE` / `FOREGROUND_SERVICE_SPECIAL_USE` | Keeps the capture service alive |
| `POST_NOTIFICATIONS` | Deletion alert notifications (Android 13+) |
| `REQUEST_IGNORE_BATTERY_OPTIMIZATIONS` | Prompt to disable battery optimization |
| `USE_BIOMETRIC` | App lock screen |
| `VIBRATE` | Alert feedback |

## Building

1. Clone the repository and switch to the `android-dev` branch.
2. Open the project in Android Studio (Ladybug or newer recommended).
3. Sync Gradle and run on a device or emulator with API 29+.

```bash
git clone https://github.com/<user>/WA-Exporter.git
cd WA-Exporter
git switch android-dev
./gradlew assembleDebug
```

## Setup

1. **Install** the debug APK on your Android device.
2. **Grant Notification Access** — the onboarding wizard will guide you to `Settings → Notification access` and prompt you to enable WA-Exporter.
3. **Disable Battery Optimization** — ensures the capture service is not killed by the OS.
4. Messages will start appearing in the app as WhatsApp notifications arrive.

## Privacy

WA-Exporter is fully offline. The app requires no internet permission, no account, and no server. All message data and thumbnails are stored exclusively in the app's private internal storage on your device.
