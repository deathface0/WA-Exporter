package com.waexporter.ui.components

import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material3.*
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.unit.dp
import com.waexporter.data.db.entity.MessageEntity
import com.waexporter.ui.theme.DeletedRed
import com.waexporter.ui.theme.DeletedRedDim
import java.text.SimpleDateFormat
import java.util.*

private val dateFormat = SimpleDateFormat("h:mm a", Locale.getDefault())

@Composable
fun MessageBubble(
    message: MessageEntity,
    modifier: Modifier = Modifier,
) {
    val isDeleted = message.isDeleted
    val bubbleColor by animateColorAsState(
        targetValue = if (isDeleted) DeletedRedDim.copy(alpha = 0.25f)
        else MaterialTheme.colorScheme.surfaceVariant,
        animationSpec = tween(300),
        label = "bubbleColor"
    )

    Column(
        modifier = modifier
            .fillMaxWidth()
            .padding(horizontal = 12.dp, vertical = 3.dp),
        horizontalAlignment = if (message.isOutgoing) Alignment.End else Alignment.Start
    ) {
        Box(
            modifier = Modifier
                .clip(
                    RoundedCornerShape(
                        topStart = 16.dp, topEnd = 16.dp,
                        bottomStart = if (message.isOutgoing) 16.dp else 4.dp,
                        bottomEnd = if (message.isOutgoing) 4.dp else 16.dp
                    )
                )
                .background(bubbleColor)
                .padding(horizontal = 12.dp, vertical = 8.dp)
                .widthIn(max = 280.dp)
        ) {
            Column {
                // Sender name (only for group chats / incoming)
                if (!message.isOutgoing) {
                    Text(
                        text = message.sender,
                        style = MaterialTheme.typography.labelMedium,
                        color = MaterialTheme.colorScheme.primary,
                    )
                    Spacer(Modifier.height(2.dp))
                }

                // Media preview card (if this is a media message)
                if (message.mediaType != null) {
                    MediaPreviewCard(
                        mediaType = message.mediaType,
                        mediaLabel = message.mediaLabel,
                        thumbnailPath = message.mediaThumbnailPath,
                        isDeleted = isDeleted,
                    )
                    if (message.text.isNotBlank() && !message.text.startsWith("[")) {
                        Spacer(Modifier.height(4.dp))
                    }
                }

                // Message text (caption or plain text)
                val displayText = if (message.mediaType != null) {
                    // Don't show the bracketed placeholder we inserted
                    message.text.removePrefix("[${message.mediaLabel}]").trim()
                } else {
                    message.text
                }

                if (displayText.isNotBlank()) {
                    Text(
                        text = displayText,
                        style = MaterialTheme.typography.bodyMedium.copy(
                            textDecoration = if (isDeleted) TextDecoration.None else TextDecoration.None
                        ),
                        color = if (isDeleted)
                            MaterialTheme.colorScheme.onSurface.copy(alpha = 0.5f)
                        else
                            MaterialTheme.colorScheme.onSurface,
                    )
                }

                // Deleted badge
                if (isDeleted) {
                    Spacer(Modifier.height(4.dp))
                    DeletedMessageBadge()
                }

                // Timestamp
                Spacer(Modifier.height(2.dp))
                Text(
                    text = dateFormat.format(Date(message.timestamp)),
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.45f),
                    modifier = Modifier.align(Alignment.End)
                )
            }
        }
    }
}
