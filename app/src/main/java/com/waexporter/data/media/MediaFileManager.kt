package com.waexporter.data.media

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import dagger.hilt.android.qualifiers.ApplicationContext
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.io.File
import java.io.FileOutputStream
import java.io.IOException
import javax.inject.Inject
import javax.inject.Singleton

/**
 * Manages storage and retrieval of notification thumbnails in the app's
 * private internal storage. Full media files are NOT stored here (no auto-download).
 */
@Singleton
class MediaFileManager @Inject constructor(
    @ApplicationContext private val context: Context
) {
    private val thumbnailDir: File by lazy {
        File(context.filesDir, "thumbnails").also { it.mkdirs() }
    }

    /**
     * Saves a bitmap thumbnail to internal storage.
     * Returns the absolute path of the saved file, or null on failure.
     */
    suspend fun saveThumbnail(bitmap: Bitmap, messageId: Long): String? =
        withContext(Dispatchers.IO) {
            try {
                val file = File(thumbnailDir, "thumb_$messageId.webp")
                FileOutputStream(file).use { out ->
                    bitmap.compress(Bitmap.CompressFormat.WEBP_LOSSY, 60, out)
                }
                file.absolutePath
            } catch (e: IOException) {
                null
            }
        }

    /**
     * Loads a thumbnail bitmap from the stored path.
     */
    suspend fun loadThumbnail(path: String): Bitmap? =
        withContext(Dispatchers.IO) {
            try {
                BitmapFactory.decodeFile(path)
            } catch (e: Exception) {
                null
            }
        }

    /**
     * Deletes a specific thumbnail file.
     */
    suspend fun deleteThumbnail(path: String) =
        withContext(Dispatchers.IO) {
            File(path).delete()
        }

    /**
     * Clears all thumbnails — used from the Settings "clear data" action.
     */
    suspend fun clearAll() = withContext(Dispatchers.IO) {
        thumbnailDir.listFiles()?.forEach { it.delete() }
    }

    /**
     * Returns the total size of stored thumbnails in bytes.
     */
    suspend fun totalSizeBytes(): Long = withContext(Dispatchers.IO) {
        thumbnailDir.listFiles()?.sumOf { it.length() } ?: 0L
    }
}
