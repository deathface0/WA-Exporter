package com.waexporter.data.db.entity

import androidx.room.Entity
import androidx.room.ForeignKey
import androidx.room.Index
import androidx.room.PrimaryKey

@Entity(
    tableName = "messages",
    foreignKeys = [
        ForeignKey(
            entity = ChatEntity::class,
            parentColumns = ["id"],
            childColumns = ["chatId"],
            onDelete = ForeignKey.CASCADE
        )
    ],
    indices = [
        Index("chatId"),
        Index("timestamp"),
        Index("notificationKey")
    ]
)
data class MessageEntity(
    @PrimaryKey(autoGenerate = true) val id: Long = 0,
    val chatId: Long,
    val sender: String,                         // Who sent the message
    val text: String,                           // Full message text
    val timestamp: Long,                        // WhatsApp notification postTime
    val capturedAt: Long,                       // System time we stored it
    val isDeleted: Boolean = false,             // True if WA removed the notification after we captured it
    val isOutgoing: Boolean = false,            // True if the notification title matches the user's own name (hard to determine reliably)
    val notificationKey: String? = null,        // StatusBarNotification.key for dedup + deletion tracking
    val mediaType: String? = null,              // "IMAGE","VIDEO","AUDIO","DOCUMENT","STICKER","GIF" or null
    val mediaLabel: String? = null,             // Human label from notification ("Photo", filename, etc.)
    val mediaThumbnailPath: String? = null,     // Path to saved low-res thumbnail inside app internal storage
    val isStarred: Boolean = false,             // Bookmarked by user
)
