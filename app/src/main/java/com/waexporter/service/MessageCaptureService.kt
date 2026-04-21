package com.waexporter.service

import android.app.Notification
import android.graphics.Bitmap
import android.os.Build
import android.service.notification.NotificationListenerService
import android.service.notification.StatusBarNotification
import android.util.Log
import com.waexporter.data.repository.MessageRepository
import dagger.hilt.android.AndroidEntryPoint
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import javax.inject.Inject
private const val TAG = "WaCapture"
private const val WHATSAPP_PACKAGE = "com.whatsapp"
private const val WHATSAPP_BUSINESS_PACKAGE = "com.whatsapp.w4b"

/**
 * Core capture engine.
 *
 * Listens to ALL system notifications, filters for WhatsApp / WhatsApp Business,
 * extracts message metadata + media type + notification thumbnail, and persists
 * everything to the Room database via [MessageRepository].
 *
 * Deletion detection: when WhatsApp removes a notification due to the sender
 * deleting a message (REASON_APP_CANCEL), the previously captured message is
 * marked as deleted in the database — preserving the content.
 */
@AndroidEntryPoint
class MessageCaptureService : NotificationListenerService() {

    @Inject
    lateinit var repository: MessageRepository

    @Inject
    lateinit var deletionAlertNotifier: DeletionAlertNotifier

    private val serviceScope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    // ── Lifecycle ─────────────────────────────────────────────────────────────

    override fun onListenerConnected() {
        super.onListenerConnected()
        Log.i(TAG, "NotificationListenerService connected")
    }

    override fun onDestroy() {
        super.onDestroy()
        serviceScope.cancel()
    }

    // ── Notification events ────────────────────────────────────────────────

    override fun onNotificationPosted(sbn: StatusBarNotification) {
        if (!isWhatsApp(sbn.packageName)) return

        val extras  = sbn.notification.extras
        val rawTitle = extras.getCharSequence(Notification.EXTRA_TITLE)?.toString() ?: return
        val text     = extras.getCharSequence(Notification.EXTRA_TEXT)?.toString() ?: return
        val bigText  = extras.getCharSequence(Notification.EXTRA_BIG_TEXT)?.toString()

        // Ignore summary / group-summary notifications (they don't carry real content)
        if (sbn.notification.flags and Notification.FLAG_GROUP_SUMMARY != 0) return

        val timestamp   = sbn.postTime
        val capturedAt  = System.currentTimeMillis()
        val notifKey    = sbn.key

        // Parse sender and chat name.
        // Individual chat  → title = "Contact Name"
        // Group chat       → title = "Group Name", text starts with "Sender: message"
        val (chatName, isGroup, sender) = parseChatInfo(rawTitle, text)

        // Determine the actual message body (prefer bigText for full content)
        val messageBody = bigText ?: text

        // Strip the "Sender: " prefix from group message body if present
        val cleanBody = if (isGroup && messageBody.startsWith("$sender: ")) {
            messageBody.removePrefix("$sender: ")
        } else {
            messageBody
        }

        // Detect media type from notification text emoji / keywords
        val mediaType = detectMediaType(text)

        // Extract low-res thumbnail from notification extras (best-effort)
        val thumbnail: Bitmap? = extractThumbnail(extras)

        Log.d(TAG, "Captured | chat=$chatName | group=$isGroup | sender=$sender | media=$mediaType")

        serviceScope.launch {
            repository.saveMessage(
                chatName       = chatName,
                isGroup        = isGroup,
                sender         = sender,
                text           = if (mediaType != null) "[${mediaLabelFor(mediaType, text)}]" else cleanBody,
                timestamp      = timestamp,
                capturedAt     = capturedAt,
                notificationKey = notifKey,
                mediaType      = mediaType,
                mediaLabel     = if (mediaType != null) mediaLabelFor(mediaType, text) else null,
                thumbnailBitmap = thumbnail,
            )
        }
    }

    override fun onNotificationRemoved(
        sbn: StatusBarNotification,
        rankingMap: RankingMap?,
        reason: Int
    ) {
        if (!isWhatsApp(sbn.packageName)) return

        // REASON_APP_CANCEL (8) = the app explicitly cancelled the notification.
        // WhatsApp does this when the user deletes a sent message.
        if (reason == REASON_APP_CANCEL) {
            val key = sbn.key
            val extras = sbn.notification.extras
            val rawTitle = extras.getCharSequence(Notification.EXTRA_TITLE)?.toString() ?: ""
            val text = extras.getCharSequence(Notification.EXTRA_TEXT)?.toString() ?: ""
            val (chatName, _, sender) = parseChatInfo(rawTitle, text)

            Log.d(TAG, "Notification removed (app_cancel) key=$key — flagging as deleted")
            serviceScope.launch {
                repository.markDeleted(key)
                // Fire a deletion alert push notification
                deletionAlertNotifier.notifyDeleted(
                    sender  = sender,
                    chatName = chatName,
                    preview  = text.take(120)
                )
            }
        }
    }

    // ── Parsing helpers ────────────────────────────────────────────────────

    private fun isWhatsApp(pkg: String) =
        pkg == WHATSAPP_PACKAGE || pkg == WHATSAPP_BUSINESS_PACKAGE

    /**
     * Returns Triple(chatName, isGroup, senderName).
     *
     * WhatsApp notification formats:
     *   Individual: title = "Alice", text = "Hey!"
     *   Group:      title = "Family Group", text = "Alice: Hey!"
     *
     * Detects groups via three WhatsApp notification title formats:
     *
     *  1. Stacked group:  title = "Family (5 messages): Alice"   text = "Hello!"
     *  2. Single group:   title = "Family"                       text = "Alice: Hello!"
     *  3. Individual DM:  title = "Alice"                        text = "Hello!"
     */
    private fun parseChatInfo(title: String, text: String): Triple<String, Boolean, String> {
        // ── Format 1: stacked group ─ "GroupName (N messages): SenderName"
        val stackedGroupPattern = Regex("""^(.+?)\s*\(\d+\s+[^)]+\):\s*(.+)$""")
        val stackedMatch = stackedGroupPattern.find(title)
        if (stackedMatch != null) {
            val chatName = stackedMatch.groupValues[1].trim()
            val sender   = stackedMatch.groupValues[2].trim()
            return Triple(chatName, true, sender)
        }

        // Strip a bare count suffix like "GroupName (5 messages)" (no sender after it)
        val cleanTitle = title.replace(Regex("""\s*\(\d+\s+[^)]+\)$"""), "").trim()

        // ── Format 2: single group ─ text starts with "Sender: …"
        val groupPattern = Regex("""^(.{1,50}):\s.+""")
        if (groupPattern.matches(text)) {
            val sender = groupPattern.find(text)!!.groupValues[1].trim()
            return Triple(cleanTitle, true, sender)
        }

        // ── Format 3: individual DM
        return Triple(cleanTitle, false, cleanTitle)
    }

    /**
     * Detects media type from the notification text content.
     * WhatsApp uses emoji prefixes and keywords in different locales.
     */
    private fun detectMediaType(text: String): String? {
        val t = text.lowercase()
        return when {
            text.contains("📷") || t == "photo" || t.contains("image")                    -> "IMAGE"
            text.contains("🎥") || t == "video"                                           -> "VIDEO"
            text.contains("🎤") || t.contains("voice message") || t.contains("audio")     -> "AUDIO"
            text.contains("🎵") || t.contains("audio")                                    -> "AUDIO"
            text.contains("📄") || t.contains("document") || t.contains("pdf")            -> "DOCUMENT"
            text.contains("😊") || t == "sticker"                                         -> "STICKER"
            t == "gif" || t.contains("gif")                                                -> "GIF"
            text.contains("📍") || t.contains("location")                                  -> "LOCATION"
            text.contains("👤") || t.contains("contact")                                  -> "CONTACT"
            else                                                                            -> null
        }
    }

    private fun mediaLabelFor(mediaType: String, originalText: String): String = when (mediaType) {
        "IMAGE"    -> "Photo"
        "VIDEO"    -> "Video"
        "AUDIO"    -> "Voice message"
        "DOCUMENT" -> {
            // Try to extract filename from text like "📄 report.pdf"
            val filename = originalText.replace("📄", "").trim()
            if (filename.isNotBlank() && filename != "document") "Document: $filename" else "Document"
        }
        "STICKER"  -> "Sticker"
        "GIF"      -> "GIF"
        "LOCATION" -> "Location"
        "CONTACT"  -> "Contact"
        else       -> originalText
    }

    /**
     * Attempts to extract a Bitmap from notification extras.
     * WhatsApp sometimes includes a contact photo or image thumbnail.
     * Returns null if nothing is available — that's fine, we fall back to type icon in the UI.
     */
    @Suppress("DEPRECATION")
    private fun extractThumbnail(extras: android.os.Bundle): Bitmap? {
        return try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                extras.getParcelable(Notification.EXTRA_PICTURE, Bitmap::class.java)
                    ?: extras.getParcelable(Notification.EXTRA_LARGE_ICON, Bitmap::class.java)
            } else {
                (extras.getParcelable(Notification.EXTRA_PICTURE) as? Bitmap)
                    ?: (extras.getParcelable(Notification.EXTRA_LARGE_ICON) as? Bitmap)
            }
        } catch (e: Exception) {
            Log.w(TAG, "Could not extract thumbnail: ${e.message}")
            null
        }
    }
}
