package com.waexporter.service

import android.app.Notification
import android.graphics.Bitmap
import android.os.Build
import android.service.notification.NotificationListenerService
import android.service.notification.StatusBarNotification
import android.util.Log
import androidx.core.app.NotificationCompat
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

        // Ignore summary / group-summary notifications (they don't carry real content)
        if (sbn.notification.flags and Notification.FLAG_GROUP_SUMMARY != 0) return

        val style = NotificationCompat.MessagingStyle.extractMessagingStyleFromNotification(sbn.notification)
        if (style != null && style.messages.isNotEmpty()) {
            processMessagingStyle(sbn, style)
        } else {
            // Fallback to legacy parsing for old platforms or non-MessagingStyle formats
            processLegacyNotification(sbn)
        }
    }

    private fun processMessagingStyle(sbn: StatusBarNotification, style: NotificationCompat.MessagingStyle) {
        val capturedAt  = System.currentTimeMillis()
        val notifKey    = sbn.key

        // For groups, conversationTitle is set. For DMs, it's null.
        val isGroup = style.conversationTitle != null
        
        // Combine historic and new messages to capture everything available
        val allMessages = (style.historicMessages + style.messages).filterNotNull()
        if (allMessages.isEmpty()) return

        // Resolve chat name: use conversation title, or fallback to the most recent sender for DMs
        val rawChatName = style.conversationTitle?.toString() 
            ?: allMessages.last().person?.name?.toString() 
            ?: sbn.notification.extras.getCharSequence(Notification.EXTRA_TITLE)?.toString()?.let { parseChatInfo(it, "").first }
            ?: "Unknown"

        val resolvedChatName = cleanChatName(rawChatName)

        for (message in allMessages) {
            val text = message.text?.toString() ?: continue
            val sender = message.person?.name?.toString() ?: resolvedChatName
            val timestamp = message.timestamp

            // ── Deletion detection ──────────────────────────────────────────────
            if (isDeletionPhrase(text)) {
                Log.d(TAG, "Deletion detected (Style) | chat=$resolvedChatName | sender=$sender")
                serviceScope.launch {
                    repository.markDeletedBySender(resolvedChatName, sender)
                    deletionAlertNotifier.notifyDeleted(
                        sender   = sender,
                        chatName = resolvedChatName,
                        preview  = "Message was deleted by sender"
                    )
                }
                continue  // don't save the deletion notice
            }

            // ── Normal message capture ──────────────────────────────────────────
            val mediaType = detectMediaType(text)
            
            // Only attach the thumbnail to the most recent message in the batch
            val thumbnail: Bitmap? = if (message === allMessages.last()) extractThumbnail(sbn.notification.extras) else null

            Log.d(TAG, "Captured (Style) | chat=$resolvedChatName | group=$isGroup | sender=$sender | media=$mediaType | ts=$timestamp")

            serviceScope.launch {
                repository.saveMessage(
                    chatName       = resolvedChatName,
                    isGroup        = isGroup,
                    sender         = sender,
                    text           = if (mediaType != null) "[${mediaLabelFor(mediaType, text)}]" else text,
                    timestamp      = timestamp,
                    capturedAt     = capturedAt,
                    notificationKey = notifKey,
                    mediaType      = mediaType,
                    mediaLabel     = if (mediaType != null) mediaLabelFor(mediaType, text) else null,
                    thumbnailBitmap = thumbnail,
                )
            }
        }
    }

    private fun processLegacyNotification(sbn: StatusBarNotification) {
        val extras  = sbn.notification.extras
        val rawTitle = extras.getCharSequence(Notification.EXTRA_TITLE)?.toString() ?: return
        val text     = extras.getCharSequence(Notification.EXTRA_TEXT)?.toString() ?: return
        val bigText  = extras.getCharSequence(Notification.EXTRA_BIG_TEXT)?.toString()

        val timestamp   = sbn.postTime
        val capturedAt  = System.currentTimeMillis()
        val notifKey    = sbn.key

        // Parse sender and chat name.
        val (chatName, isGroup, sender) = parseChatInfo(rawTitle, text)

        // ── Deletion detection ──────────────────────────────────────────────
        val messageBody = bigText ?: text
        if (isDeletionPhrase(messageBody) || isDeletionPhrase(text)) {
            Log.d(TAG, "Deletion detected (Legacy) | chat=$chatName | sender=$sender")
            serviceScope.launch {
                repository.markDeletedBySender(chatName, sender)
                deletionAlertNotifier.notifyDeleted(
                    sender   = sender,
                    chatName = chatName,
                    preview  = "Message was deleted by sender"
                )
            }
            return
        }

        // ── Normal message capture ──────────────────────────────────────────
        val cleanBody = if (isGroup && messageBody.startsWith("$sender: ")) {
            messageBody.removePrefix("$sender: ")
        } else {
            messageBody
        }

        val mediaType = detectMediaType(text)
        val thumbnail: Bitmap? = extractThumbnail(extras)

        Log.d(TAG, "Captured (Legacy) | chat=$chatName | group=$isGroup | sender=$sender | media=$mediaType")

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

        // NOTE: REASON_APP_CANCEL fires both when WhatsApp deletes a message AND
        // when the user simply reads a conversation. We cannot distinguish the two
        // reliably, so we do NOT mark messages as deleted here.
        // Deletion is detected in onNotificationPosted when WhatsApp sends
        // a "This message was deleted" notification.
        if (reason == REASON_APP_CANCEL) {
            Log.d(TAG, "Notification removed (app_cancel) key=${sbn.key} — ignored (not a reliable deletion signal)")
        }
    }

    // ── Parsing helpers ────────────────────────────────────────────────────

    private fun isWhatsApp(pkg: String) =
        pkg == WHATSAPP_PACKAGE || pkg == WHATSAPP_BUSINESS_PACKAGE

    /**
     * Checks if the notification text matches one of WhatsApp's
     * "message deleted" phrases across common locales.
     */
    private fun isDeletionPhrase(text: String): Boolean {
        val t = text.lowercase().trim()
        return DELETION_PHRASES.any { t.contains(it) }
    }

    private companion object {
        val DELETION_PHRASES = listOf(
            "this message was deleted",              // English
            "you deleted this message",             // English (self)
            "se eliminó este mensaje",              // Spanish
            "este mensaje fue eliminado",           // Spanish alt
            "has eliminado este mensaje",           // Spanish (self)
            "esta mensagem foi apagada",            // Portuguese
            "diese nachricht wurde gelöscht",       // German
            "ce message a été supprimé",            // French
            "questo messaggio è stato eliminato",   // Italian
            "esta mensagem foi eliminada",          // Portuguese (BR)
            "berichten is verwijderd",              // Dutch
            "mesaj silindi",                        // Turkish
        )
    }

    /**
     * Cleans WhatsApp chat titles by removing the "(N messages)" suffix.
     * WhatsApp often appends this to group titles in stacked notifications.
     */
    private fun cleanChatName(title: String): String {
        return title.replace(Regex("""\s*\(\d+\s+[^)]+\)$"""), "").trim()
    }

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
        val cleanTitle = cleanChatName(title)

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
