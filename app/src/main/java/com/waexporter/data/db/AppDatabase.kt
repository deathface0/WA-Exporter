package com.waexporter.data.db

import androidx.room.Database
import androidx.room.RoomDatabase
import com.waexporter.data.db.entity.ChatEntity
import com.waexporter.data.db.entity.MessageEntity

@Database(
    entities = [ChatEntity::class, MessageEntity::class],
    version = 1,
    exportSchema = true
)
abstract class AppDatabase : RoomDatabase() {
    abstract fun chatDao(): ChatDao
    abstract fun messageDao(): MessageDao

    companion object {
        const val DATABASE_NAME = "wa_exporter.db"
    }
}
