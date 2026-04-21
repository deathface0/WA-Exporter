package com.waexporter.ui.components

import androidx.compose.animation.core.*
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.scale
import androidx.compose.ui.unit.dp
import com.waexporter.ui.theme.DeletedRed

@Composable
fun DeletedMessageBadge(modifier: Modifier = Modifier) {
    // Subtle pulse animation to draw attention
    val infiniteTransition = rememberInfiniteTransition(label = "deletedPulse")
    val scale by infiniteTransition.animateFloat(
        initialValue = 1f,
        targetValue = 1.05f,
        animationSpec = infiniteRepeatable(
            animation = tween(800, easing = EaseInOutSine),
            repeatMode = RepeatMode.Reverse
        ),
        label = "scale"
    )

    Row(
        modifier = modifier
            .scale(scale)
            .background(
                color = DeletedRed.copy(alpha = 0.15f),
                shape = RoundedCornerShape(4.dp)
            )
            .border(0.5.dp, DeletedRed.copy(alpha = 0.4f), RoundedCornerShape(4.dp))
            .padding(horizontal = 6.dp, vertical = 2.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(4.dp)
    ) {
        Icon(
            imageVector = Icons.Default.Delete,
            contentDescription = null,
            tint = DeletedRed,
            modifier = Modifier.size(10.dp)
        )
        Text(
            text = "Deleted by sender",
            style = MaterialTheme.typography.labelSmall,
            color = DeletedRed,
        )
    }
}
