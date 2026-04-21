package com.waexporter.ui.components

import android.content.Context
import android.content.Intent
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.*
import androidx.compose.material3.*
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import coil.compose.AsyncImage
import com.waexporter.ui.theme.MediaAmber

/**
 * Shows a media message placeholder with:
 *  - Type icon + label
 *  - Low-res thumbnail if available (from notification)
 *  - "Open in WhatsApp" tap action (deep-links to WA)
 *  - Red deleted badge if the media was deleted after capture
 */
@Composable
fun MediaPreviewCard(
    mediaType: String,
    mediaLabel: String?,
    thumbnailPath: String?,
    isDeleted: Boolean,
    modifier: Modifier = Modifier,
) {
    val context = LocalContext.current
    val shape = RoundedCornerShape(8.dp)

    Column(
        modifier = modifier
            .clip(shape)
            .background(MaterialTheme.colorScheme.surface)
            .border(
                width = 1.dp,
                color = if (isDeleted) com.waexporter.ui.theme.DeletedRed.copy(0.4f)
                else MaterialTheme.colorScheme.outline.copy(0.3f),
                shape = shape
            )
            .clickable(enabled = !isDeleted) { openWhatsApp(context) }
            .padding(10.dp)
            .widthIn(min = 180.dp, max = 260.dp)
    ) {
        // Thumbnail or icon
        if (thumbnailPath != null) {
            AsyncImage(
                model = thumbnailPath,
                contentDescription = "Media preview",
                contentScale = ContentScale.Crop,
                modifier = Modifier
                    .fillMaxWidth()
                    .height(120.dp)
                    .clip(RoundedCornerShape(6.dp))
            )
            Spacer(Modifier.height(6.dp))
        } else {
            Box(
                modifier = Modifier
                    .fillMaxWidth()
                    .height(72.dp)
                    .background(
                        color = MediaAmber.copy(alpha = 0.1f),
                        shape = RoundedCornerShape(6.dp)
                    ),
                contentAlignment = Alignment.Center
            ) {
                Icon(
                    imageVector = iconFor(mediaType),
                    contentDescription = null,
                    tint = MediaAmber,
                    modifier = Modifier.size(36.dp)
                )
            }
            Spacer(Modifier.height(6.dp))
        }

        // Label row
        Row(
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(4.dp)
        ) {
            Icon(
                imageVector = iconFor(mediaType),
                contentDescription = null,
                tint = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.7f),
                modifier = Modifier.size(14.dp)
            )
            Text(
                text = mediaLabel ?: labelFor(mediaType),
                style = MaterialTheme.typography.labelMedium,
                color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.8f),
            )
            if (!isDeleted) {
                Spacer(Modifier.weight(1f))
                Icon(
                    imageVector = Icons.Default.OpenInNew,
                    contentDescription = "Open in WhatsApp",
                    tint = MaterialTheme.colorScheme.primary,
                    modifier = Modifier.size(14.dp)
                )
            }
        }

        if (!isDeleted) {
            Text(
                text = "Tap to open in WhatsApp",
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.primary.copy(alpha = 0.7f),
            )
        }
    }
}

private fun iconFor(mediaType: String): ImageVector = when (mediaType) {
    "IMAGE"    -> Icons.Default.Image
    "VIDEO"    -> Icons.Default.Videocam
    "AUDIO"    -> Icons.Default.Mic
    "DOCUMENT" -> Icons.Default.Description
    "STICKER"  -> Icons.Default.EmojiEmotions
    "GIF"      -> Icons.Default.Gif
    "LOCATION" -> Icons.Default.LocationOn
    "CONTACT"  -> Icons.Default.Person
    else       -> Icons.Default.AttachFile
}

private fun labelFor(mediaType: String): String = when (mediaType) {
    "IMAGE"    -> "Photo"
    "VIDEO"    -> "Video"
    "AUDIO"    -> "Voice message"
    "DOCUMENT" -> "Document"
    "STICKER"  -> "Sticker"
    "GIF"      -> "GIF"
    "LOCATION" -> "Location"
    "CONTACT"  -> "Contact"
    else       -> "Media"
}

private fun openWhatsApp(context: Context) {
    val intent = context.packageManager.getLaunchIntentForPackage("com.whatsapp")
        ?: context.packageManager.getLaunchIntentForPackage("com.whatsapp.w4b")
        ?: return
    intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
    context.startActivity(intent)
}
