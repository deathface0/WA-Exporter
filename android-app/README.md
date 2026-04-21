# WA-Exporter — Android

> **Branch:** `android-dev`  
> A native Android companion to the [WA-Exporter browser extension](../README.md) that captures WhatsApp messages in real-time, preserves deleted messages, and keeps media metadata — all stored locally on your device.

---

## How It Works

Unlike the browser extension (which scrapes WhatsApp Web after the fact), the Android app uses Android's **`NotificationListenerService`** to intercept WhatsApp notifications *as they arrive* and persist them to a local [Room](https://developer.android.com/training/data-storage/room) database.

```
WhatsApp sends message
        │
        ▼
NotificationListenerService.onNotificationPosted()
        │
        ├── Extract: sender, text, timestamp, chat name
        ├── Detect:  media type (📷 Photo, 🎥 Video, 🎤 Audio…)
        ├── Try:     low-res thumbnail from notification extras
        │
        ▼
MessageRepository.saveMessage()
        │
        ▼
Room SQLite Database  ←──── Queried by ViewModels → Compose UI
```

When a message is **deleted** by the sender:
```
WhatsApp cancels notification (REASON_APP_CANCEL)
        │
        ▼
onNotificationRemoved() → markDeleted(key) in DB
        │
        ├── Message content already saved ✅
        ├── UI shows red 🗑️ "Deleted by sender" badge
        └── Push notification: "Alice deleted a message you already saved"
```

---

## Features

| Feature | Description |
|---|---|
| **Real-time capture** | Messages captured the moment they arrive, before WhatsApp can delete them |
| **Deleted message recovery** | Content preserved even if sender deletes — highlighted with red badge |
| **Media metadata** | Media type, label, and low-res thumbnail (if available in notification) saved without auto-download |
| **"Open in WhatsApp"** | Tap any media card to jump directly to that chat in WhatsApp |
| **Deletion alerts** | Push notification when a captured message is deleted |
| **Full-text search** | Search across all chats, senders, and media labels |
| **Starred messages** | Bookmark important messages for quick access |
| **Multi-format export** | TXT (browser extension compatible), JSON, CSV — shareable via any Android app |
| **Biometric app lock** | Fingerprint / PIN protection for the captured data |
| **Material 3 dark UI** | WhatsApp-inspired teal palette, animated components |

---

## Tech Stack

| Layer | Technology |
|---|---|
| Language | Kotlin 2.x |
| UI | Jetpack Compose + Material 3 |
| Architecture | MVVM + Clean Architecture |
| DI | Hilt |
| Database | Room (SQLite) |
| Reactive | Kotlin Coroutines + Flow |
| Image loading | Coil |
| Preferences | DataStore |
| Auth | AndroidX Biometric |
| Min SDK | Android 10 (API 29) |
| Target SDK | Android 15 (API 35) |

---

## Project Structure

```
android-app/
└── app/src/main/java/com/waexporter/
    ├── MainActivity.kt                  # Single-activity host + AppGate (lock → onboarding → app)
    ├── WaExporterApp.kt                 # Hilt Application class
    ├── navigation/AppNavGraph.kt        # Compose Navigation
    ├── service/
    │   ├── MessageCaptureService.kt     # NotificationListenerService (core engine)
    │   └── DeletionAlertNotifier.kt     # Posts push notification on deletions
    ├── data/
    │   ├── db/                          # Room: AppDatabase, ChatDao, MessageDao, entities
    │   ├── repository/MessageRepository.kt
    │   └── media/MediaFileManager.kt    # Thumbnail storage (WebP, internal)
    ├── domain/usecase/                  # SearchMessagesUseCase, ExportChatUseCase
    └── ui/
        ├── theme/                       # Color, Type, Theme (Material 3 dark)
        ├── onboarding/                  # 5-step permission setup flow
        ├── lock/                        # Biometric lock screen
        ├── home/                        # Chat list
        ├── chat/                        # Message thread
        ├── search/                      # Debounced search + starred messages
        ├── export/                      # TXT / JSON / CSV export
        ├── settings/                    # Permission links, storage, cache
        └── components/                  # MessageBubble, DeletedMessageBadge, MediaPreviewCard, ChatListItem
```

---

## Setup

### Prerequisites
- Android Studio Ladybug (2024.2.x) or newer
- Android SDK 35
- A physical Android device (emulators cannot receive real WhatsApp notifications)

### Opening the project
1. Open Android Studio
2. **File → Open** → select the `android-app/` folder inside this repo
3. Let Gradle sync complete
4. Connect a physical device and run the **app** configuration

### First-run setup
On first launch, the onboarding flow guides you through:
1. **Notification Access** — Settings → Notification Access → enable WA Exporter
2. **Battery Optimization** — disable to prevent the capture service being killed

### Building a debug APK
```bash
cd android-app
./gradlew assembleDebug
# APK: app/build/outputs/apk/debug/app-debug.apk
```

---

## Permissions

| Permission | Why |
|---|---|
| `BIND_NOTIFICATION_LISTENER_SERVICE` | Core capture — read WhatsApp notifications |
| `POST_NOTIFICATIONS` | Deletion alert push notifications |
| `FOREGROUND_SERVICE` | Keep capture service alive |
| `REQUEST_IGNORE_BATTERY_OPTIMIZATIONS` | Battery exemption prompt |
| `USE_BIOMETRIC` | App lock screen |
| `VIBRATE` | Alert feedback |

> **No internet permission.** All data stays on-device.

---

## Limitations

- **Notification previews must be enabled** in WhatsApp settings. If "Show notifications" is off, no content can be captured.
- **Media files are not downloaded** (no auto-download required). Media type and low-res notification thumbnails are captured; tap to open full media in WhatsApp.
- **Lock screen privacy settings** do not affect capture — the service receives the full notification regardless of lock-screen content visibility.
- **Group messages** may occasionally be truncated if WhatsApp collapses them into a summary notification.

---

## Privacy

All captured data is stored exclusively in the app's private internal storage (`/data/data/com.waexporter/`). No data is transmitted anywhere. Cloud backup is explicitly disabled in the manifest.

This app is intended for **personal message backup** on your own device only.
