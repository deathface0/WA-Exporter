package com.waexporter.data.repository

import android.graphics.Bitmap
import com.waexporter.data.db.ChatDao
import com.waexporter.data.db.MessageDao
import com.waexporter.data.db.entity.ChatEntity
import com.waexporter.data.db.entity.MessageEntity
import com.waexporter.data.media.MediaFileManager
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import javax.inject.Inject
import javax.inject.Singleton

@Singleton
class MessageRepository @Inject constructor(
    private val chatDao: ChatDao,
    private val messageDao: MessageDao,
    private val mediaFileManager: MediaFileManager,
) {
    // ── Chat queries ─────────────────────────────────────────────────────────

    fun getAllChats(): Flow<List<ChatEntity>> = chatDao.getAllChats()

    // ── Message queries ──────────────────────────────────────────────────────

    fun getMessagesForChat(chatId: Long): Flow<List<MessageEntity>> =
        messageDao.getMessagesForChat(chatId)

    fun getDeletedMessages(): Flow<List<MessageEntity>> =
        messageDao.getDeletedMessages()

    fun getStarredMessages(): Flow<List<MessageEntity>> =
        messageDao.getStarredMessages()

    fun searchMessages(query: String): Flow<List<MessageEntity>> =
        messageDao.searchMessages(query.trim())

    fun getMessagesByDateRange(chatId: Long, start: Long, end: Long): Flow<List<MessageEntity>> =
        messageDao.getMessagesByDateRange(chatId, start, end)

    fun getLastNMessages(chatId: Long, count: Int): Flow<List<MessageEntity>> =
        messageDao.getLastNMessages(chatId, count)

    // ── Write operations ─────────────────────────────────────────────────────

    private val saveMutex = Mutex()

    /**
     * Persists a captured notification as a message.
     * Creates the chat row if it does not yet exist.
     * Returns the new message ID.
     */
    suspend fun saveMessage(
        chatName: String,
        isGroup: Boolean,
        sender: String,
        text: String,
        timestamp: Long,
        capturedAt: Long,
        notificationKey: String?,
        mediaType: String?,
        mediaLabel: String?,
        thumbnailBitmap: Bitmap?,
    ): Long = saveMutex.withLock {
        // Upsert chat
        var chat = chatDao.getChatByName(chatName)
        val chatId: Long
        if (chat == null) {
            chatId = chatDao.insertChat(
                ChatEntity(
                    name = chatName,
                    isGroup = isGroup,
                    lastMessageTimestamp = timestamp,
                    messageCount = 0,
                    lastPreviewText = buildPreview(sender, text, mediaType)
                )
            )
        } else {
            chatId = chat.id
        }

        // Content-based dedup: skip if we already have this exact message
        // (protects against notification re-delivery without blocking new messages
        //  in the same chat — WhatsApp reuses the same notification key per chat)
        val duplicate = messageDao.findDuplicate(chatId, sender, text, timestamp)
        if (duplicate != null) return@withLock duplicate.id

        // Build partial entity to get the auto-generated ID
        val partialEntity = MessageEntity(
            chatId = chatId,
            sender = sender,
            text = text,
            timestamp = timestamp,
            capturedAt = capturedAt,
            notificationKey = notificationKey,
            mediaType = mediaType,
            mediaLabel = mediaLabel,
        )
        val messageId = messageDao.insertMessage(partialEntity)

        // Save thumbnail if present
        val thumbPath = thumbnailBitmap?.let { mediaFileManager.saveThumbnail(it, messageId) }

        // Update the message row with the thumbnail path
        if (thumbPath != null) {
            messageDao.updateMessage(partialEntity.copy(id = messageId, mediaThumbnailPath = thumbPath))
        }

        // Bump chat stats
        chatDao.bumpChat(chatId, timestamp, buildPreview(sender, text, mediaType))

        return@withLock messageId
    }

    /**
     * Marks a previously captured message as deleted by the sender.
     * Also increments the chat's deleted counter.
     */
    suspend fun markDeleted(notificationKey: String) {
        val message = messageDao.getByNotificationKey(notificationKey) ?: return
        messageDao.markDeletedByKey(notificationKey)
        chatDao.incrementDeletedCount(message.chatId)
    }

    /**
     * Marks the latest non-deleted message from [sender] in [chatName] as deleted.
     * Used when WhatsApp posts a "This message was deleted" notification.
     */
    suspend fun markDeletedBySender(chatName: String, sender: String) {
        val chat = chatDao.getChatByName(chatName) ?: return
        val affected = messageDao.markLatestDeletedBySender(chat.id, sender)
        if (affected > 0) chatDao.incrementDeletedCount(chat.id)
    }

    suspend fun setStarred(messageId: Long, starred: Boolean) =
        messageDao.setStarred(messageId, starred)

    suspend fun countDeleted(): Int = messageDao.countDeleted()

    suspend fun thumbnailStorageSizeBytes(): Long = mediaFileManager.totalSizeBytes()

    suspend fun clearAllThumbnails() = mediaFileManager.clearAll()

    // ── Helpers ──────────────────────────────────────────────────────────────

    private fun buildPreview(sender: String, text: String, mediaType: String?): String {
        val body = when (mediaType) {
            "IMAGE"    -> "📷 Photo"
            "VIDEO"    -> "🎥 Video"
            "AUDIO"    -> "🎤 Voice message"
            "DOCUMENT" -> "📄 Document"
            "STICKER"  -> "😊 Sticker"
            "GIF"      -> "GIF"
            else       -> text.take(80)
        }
        return "$sender: $body"
    }
}
