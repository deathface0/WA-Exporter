package com.waexporter.service

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import com.waexporter.MainActivity
import dagger.hilt.android.qualifiers.ApplicationContext
import javax.inject.Inject
import javax.inject.Singleton

/**
 * Posts a system notification alerting the user that a previously captured
 * WhatsApp message has been deleted by its sender.
 *
 * This is invoked from [MessageCaptureService.onNotificationRemoved] after
 * we confirm a deletion event and update the database.
 */
@Singleton
class DeletionAlertNotifier @Inject constructor(
    @ApplicationContext private val context: Context
) {
    companion object {
        private const val CHANNEL_ID   = "wa_deletion_alerts"
        private const val CHANNEL_NAME = "Deleted Message Alerts"
        private const val NOTIF_ID_BASE = 9000
    }

    init {
        createChannel()
    }

    /**
     * Posts a notification: "Alice deleted a message you already saved."
     *
     * @param sender    The name of the person who deleted the message.
     * @param chatName  The chat/group name for the tap intent.
     * @param preview   A short text preview of the deleted message content.
     */
    fun notifyDeleted(sender: String, chatName: String, preview: String) {
        val tapIntent = Intent(context, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP
            putExtra("open_chat", chatName)
        }
        val pendingIntent = PendingIntent.getActivity(
            context,
            chatName.hashCode(),
            tapIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        val notification = NotificationCompat.Builder(context, CHANNEL_ID)
            .setSmallIcon(android.R.drawable.ic_delete)
            .setContentTitle("🗑️ $sender deleted a message")
            .setContentText(preview.take(80))
            .setStyle(NotificationCompat.BigTextStyle().bigText(
                "\"$preview\"\n\nTap to view the saved copy."
            ))
            .setPriority(NotificationCompat.PRIORITY_DEFAULT)
            .setContentIntent(pendingIntent)
            .setAutoCancel(true)
            .build()

        NotificationManagerCompat.from(context)
            .notify(NOTIF_ID_BASE + chatName.hashCode(), notification)
    }

    private fun createChannel() {
        val channel = NotificationChannel(
            CHANNEL_ID,
            CHANNEL_NAME,
            NotificationManager.IMPORTANCE_DEFAULT
        ).apply {
            description = "Alerts when a captured WhatsApp message is deleted by its sender"
        }
        (context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager)
            .createNotificationChannel(channel)
    }
}
