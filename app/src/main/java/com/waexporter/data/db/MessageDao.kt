package com.waexporter.data.db

import androidx.room.*
import com.waexporter.data.db.entity.MessageEntity
import kotlinx.coroutines.flow.Flow

@Dao
interface MessageDao {

    @Query("SELECT * FROM messages WHERE chatId = :chatId ORDER BY timestamp ASC")
    fun getMessagesForChat(chatId: Long): Flow<List<MessageEntity>>

    @Query("SELECT * FROM messages WHERE isDeleted = 1 ORDER BY timestamp DESC")
    fun getDeletedMessages(): Flow<List<MessageEntity>>

    @Query("SELECT * FROM messages WHERE isStarred = 1 ORDER BY timestamp DESC")
    fun getStarredMessages(): Flow<List<MessageEntity>>

    @Query("""
        SELECT * FROM messages
        WHERE text LIKE '%' || :query || '%'
           OR sender LIKE '%' || :query || '%'
           OR mediaLabel LIKE '%' || :query || '%'
        ORDER BY timestamp DESC
        LIMIT 200
    """)
    fun searchMessages(query: String): Flow<List<MessageEntity>>

    @Query("""
        SELECT * FROM messages
        WHERE chatId = :chatId
          AND timestamp BETWEEN :start AND :end
        ORDER BY timestamp ASC
    """)
    fun getMessagesByDateRange(chatId: Long, start: Long, end: Long): Flow<List<MessageEntity>>

    @Query("""
        SELECT * FROM messages
        WHERE chatId = :chatId
        ORDER BY timestamp DESC
        LIMIT :count
    """)
    fun getLastNMessages(chatId: Long, count: Int): Flow<List<MessageEntity>>

    @Query("SELECT * FROM messages WHERE notificationKey = :key LIMIT 1")
    suspend fun getByNotificationKey(key: String): MessageEntity?

    @Insert(onConflict = OnConflictStrategy.IGNORE)
    suspend fun insertMessage(message: MessageEntity): Long

    @Update
    suspend fun updateMessage(message: MessageEntity)

    @Query("UPDATE messages SET isDeleted = 1 WHERE notificationKey = :key")
    suspend fun markDeletedByKey(key: String)

    @Query("UPDATE messages SET isStarred = :starred WHERE id = :id")
    suspend fun setStarred(id: Long, starred: Boolean)

    @Query("SELECT COUNT(*) FROM messages WHERE chatId = :chatId")
    suspend fun countForChat(chatId: Long): Int

    @Query("SELECT COUNT(*) FROM messages WHERE isDeleted = 1")
    suspend fun countDeleted(): Int
}
