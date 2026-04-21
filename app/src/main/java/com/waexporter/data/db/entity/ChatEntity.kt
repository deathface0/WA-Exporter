package com.waexporter.data.db.entity

import androidx.room.Entity
import androidx.room.PrimaryKey

@Entity(tableName = "chats")
data class ChatEntity(
    @PrimaryKey(autoGenerate = true) val id: Long = 0,
    val name: String,                       // Contact name or group name as seen in notification
    val isGroup: Boolean = false,
    val lastMessageTimestamp: Long = 0L,
    val messageCount: Int = 0,
    val deletedMessageCount: Int = 0,        // How many msgs we saved that were later deleted
    val lastPreviewText: String = "",         // Preview for the chat list row
)
