package com.waexporter.ui.components

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.Group
import androidx.compose.material.icons.filled.Person
import androidx.compose.material3.*
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.waexporter.data.db.entity.ChatEntity
import com.waexporter.ui.theme.DeletedRed
import java.text.SimpleDateFormat
import java.util.*

private val dateFormatter = SimpleDateFormat("MMM d", Locale.getDefault())
private val timeFormatter = SimpleDateFormat("h:mm a", Locale.getDefault())

@Composable
fun ChatListItem(
    chat: ChatEntity,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val isToday = isSameDay(chat.lastMessageTimestamp, System.currentTimeMillis())
    val timeLabel = if (isToday)
        timeFormatter.format(Date(chat.lastMessageTimestamp))
    else
        dateFormatter.format(Date(chat.lastMessageTimestamp))

    ListItem(
        modifier = modifier.clickable(onClick = onClick),
        leadingContent = {
            Icon(
                imageVector = if (chat.isGroup) Icons.Default.Group else Icons.Default.Person,
                contentDescription = null,
                tint = MaterialTheme.colorScheme.primary,
                modifier = Modifier.size(40.dp)
            )
        },
        headlineContent = {
            Text(
                text = chat.name,
                style = MaterialTheme.typography.titleMedium,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis
            )
        },
        supportingContent = {
            Text(
                text = chat.lastPreviewText,
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.6f),
                maxLines = 1,
                overflow = TextOverflow.Ellipsis
            )
        },
        trailingContent = {
            Column(horizontalAlignment = Alignment.End, verticalArrangement = Arrangement.spacedBy(4.dp)) {
                Text(
                    text = timeLabel,
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.5f)
                )
                if (chat.deletedMessageCount > 0) {
                    Badge(containerColor = DeletedRed) {
                        Row(
                            verticalAlignment = Alignment.CenterVertically,
                            horizontalArrangement = Arrangement.spacedBy(2.dp)
                        ) {
                            Icon(Icons.Default.Delete, null, Modifier.size(10.dp))
                            Text("${chat.deletedMessageCount}")
                        }
                    }
                }
            }
        }
    )
}

private fun isSameDay(ts1: Long, ts2: Long): Boolean {
    val cal1 = Calendar.getInstance().apply { timeInMillis = ts1 }
    val cal2 = Calendar.getInstance().apply { timeInMillis = ts2 }
    return cal1.get(Calendar.YEAR) == cal2.get(Calendar.YEAR) &&
            cal1.get(Calendar.DAY_OF_YEAR) == cal2.get(Calendar.DAY_OF_YEAR)
}
