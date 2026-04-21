package com.waexporter.domain.usecase

import com.waexporter.data.db.entity.MessageEntity
import com.waexporter.data.repository.MessageRepository
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.first
import javax.inject.Inject

sealed class ExportFormat { object TXT : ExportFormat(); object JSON : ExportFormat(); object CSV : ExportFormat() }

/**
 * Formats a list of messages from a chat into the requested export format.
 * Extends the browser extension's TXT format while adding JSON and CSV options.
 */
class ExportChatUseCase @Inject constructor(
    private val repository: MessageRepository
) {
    suspend operator fun invoke(
        chatId: Long,
        chatName: String,
        format: ExportFormat,
        startMs: Long? = null,
        endMs: Long? = null,
    ): String {
        val messages: List<MessageEntity> = if (startMs != null && endMs != null) {
            repository.getMessagesByDateRange(chatId, startMs, endMs).first()
        } else {
            repository.getMessagesForChat(chatId).first()
        }

        return when (format) {
            is ExportFormat.TXT  -> formatTxt(chatName, messages)
            is ExportFormat.JSON -> formatJson(chatName, messages)
            is ExportFormat.CSV  -> formatCsv(messages)
        }
    }

    private fun formatTxt(chatName: String, messages: List<MessageEntity>): String {
        val sb = StringBuilder()
        sb.appendLine("# WA-Exporter — $chatName")
        sb.appendLine("# Exported: ${java.util.Date()}")
        sb.appendLine()
        messages.forEach { msg ->
            val date = java.text.SimpleDateFormat("M/d/yyyy h:mm a", java.util.Locale.US)
                .format(java.util.Date(msg.timestamp))
            val deleted = if (msg.isDeleted) " [DELETED]" else ""
            sb.appendLine("[$date] ${msg.sender}: ${msg.text}$deleted")
        }
        return sb.toString()
    }

    private fun formatJson(chatName: String, messages: List<MessageEntity>): String {
        val sb = StringBuilder()
        sb.append("""{"chat":"$chatName","messages":[""")
        messages.forEachIndexed { i, msg ->
            if (i > 0) sb.append(",")
            sb.append("""{""")
            sb.append(""""id":${msg.id},""")
            sb.append(""""sender":"${msg.sender.replace("\"", "\\\"")}",""")
            sb.append(""""text":"${msg.text.replace("\"", "\\\"").replace("\n", "\\n")}",""")
            sb.append(""""timestamp":${msg.timestamp},""")
            sb.append(""""isDeleted":${msg.isDeleted},""")
            sb.append(""""mediaType":${if (msg.mediaType != null) "\"${msg.mediaType}\"" else "null"}""")
            sb.append("}")
        }
        sb.append("]}")
        return sb.toString()
    }

    private fun formatCsv(messages: List<MessageEntity>): String {
        val sb = StringBuilder()
        sb.appendLine("timestamp,sender,text,isDeleted,mediaType")
        messages.forEach { msg ->
            val text = msg.text.replace("\"", "\"\"").replace("\n", " ")
            sb.appendLine("${msg.timestamp},\"${msg.sender}\",\"$text\",${msg.isDeleted},${msg.mediaType ?: ""}")
        }
        return sb.toString()
    }
}
