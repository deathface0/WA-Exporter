package com.waexporter.data.db

import androidx.room.*
import com.waexporter.data.db.entity.ChatEntity
import kotlinx.coroutines.flow.Flow

@Dao
interface ChatDao {

    @Query("SELECT * FROM chats ORDER BY lastMessageTimestamp DESC")
    fun getAllChats(): Flow<List<ChatEntity>>

    @Query("SELECT * FROM chats WHERE id = :id LIMIT 1")
    suspend fun getChatById(id: Long): ChatEntity?

    @Query("SELECT * FROM chats WHERE name = :name LIMIT 1")
    suspend fun getChatByName(name: String): ChatEntity?

    @Insert(onConflict = OnConflictStrategy.IGNORE)
    suspend fun insertChat(chat: ChatEntity): Long

    @Update
    suspend fun updateChat(chat: ChatEntity)

    @Query("""
        UPDATE chats
        SET lastMessageTimestamp = :timestamp,
            messageCount = messageCount + 1,
            lastPreviewText = :preview
        WHERE id = :chatId
    """)
    suspend fun bumpChat(chatId: Long, timestamp: Long, preview: String)

    @Query("""
        UPDATE chats
        SET deletedMessageCount = deletedMessageCount + 1
        WHERE id = :chatId
    """)
    suspend fun incrementDeletedCount(chatId: Long)

    @Query("SELECT COUNT(*) FROM chats")
    suspend fun getChatCount(): Int
}
