package com.waexporter.ui.onboarding

import android.content.Intent
import android.provider.Settings
import androidx.compose.animation.*
import androidx.compose.animation.core.*
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import com.waexporter.ui.theme.CapturedBlue
import com.waexporter.ui.theme.DeletedRed
import com.waexporter.ui.theme.Teal80

private data class OnboardingPage(
    val icon: ImageVector,
    val iconTint: Color,
    val title: String,
    val body: String,
    val actionLabel: String? = null,
    val onAction: (android.content.Context) -> Unit = {},
)

@Composable
fun OnboardingScreen(onFinish: () -> Unit) {
    val context = LocalContext.current
    var pageIndex by remember { mutableIntStateOf(0) }

    val pages = remember {
        listOf(
            OnboardingPage(
                icon = Icons.Default.Shield,
                iconTint = Teal80,
                title = "Welcome to WA Exporter",
                body = "Your personal WhatsApp message vault.\n\nCaptures messages in real-time — even deleted ones — and keeps them safe on your device.",
            ),
            OnboardingPage(
                icon = Icons.Default.Notifications,
                iconTint = CapturedBlue,
                title = "Grant Notification Access",
                body = "WA Exporter reads WhatsApp notifications to capture messages as they arrive.\n\nThis is the only permission needed. No internet access, no account required.",
                actionLabel = "Open Notification Settings",
                onAction = { ctx ->
                    ctx.startActivity(Intent(Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS))
                }
            ),
            OnboardingPage(
                icon = Icons.Default.Delete,
                iconTint = DeletedRed,
                title = "Never Lose a Message",
                body = "When someone deletes a message, WA Exporter already has it.\n\nDeleted messages are highlighted with a red badge so you can spot them instantly.",
            ),
            OnboardingPage(
                icon = Icons.Default.BatteryFull,
                iconTint = Teal80,
                title = "Keep the Service Running",
                body = "Android may stop background services to save battery.\n\nDisable battery optimization for WA Exporter to ensure capture runs 24/7.",
                actionLabel = "Open Battery Settings",
                onAction = { ctx ->
                    ctx.startActivity(Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS))
                }
            ),
            OnboardingPage(
                icon = Icons.Default.CheckCircle,
                iconTint = Teal80,
                title = "You're all set!",
                body = "WA Exporter will now capture your WhatsApp messages in the background.\n\nOpen the app anytime to browse, search, and export your history.",
            ),
        )
    }

    val page = pages[pageIndex]
    val isLast = pageIndex == pages.lastIndex

    // Gradient background that shifts subtly per page
    val gradientAlpha by animateFloatAsState(
        targetValue = 0.06f + pageIndex * 0.01f,
        animationSpec = tween(600),
        label = "grad"
    )

    Box(
        modifier = Modifier
            .fillMaxSize()
            .background(MaterialTheme.colorScheme.background)
    ) {
        // Subtle radial glow top-centre
        Box(
            modifier = Modifier
                .size(300.dp)
                .align(Alignment.TopCenter)
                .offset(y = (-80).dp)
                .background(
                    brush = Brush.radialGradient(
                        colors = listOf(
                            page.iconTint.copy(alpha = gradientAlpha),
                            Color.Transparent
                        )
                    ),
                    shape = CircleShape
                )
        )

        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(32.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            Spacer(Modifier.weight(0.8f))

            // Animated icon
            AnimatedContent(
                targetState = pageIndex,
                transitionSpec = {
                    fadeIn(tween(400)) + slideInVertically { it / 6 } togetherWith
                            fadeOut(tween(200))
                },
                label = "icon"
            ) { idx ->
                Box(
                    modifier = Modifier
                        .size(100.dp)
                        .clip(RoundedCornerShape(28.dp))
                        .background(pages[idx].iconTint.copy(alpha = 0.15f)),
                    contentAlignment = Alignment.Center
                ) {
                    Icon(
                        imageVector = pages[idx].icon,
                        contentDescription = null,
                        tint = pages[idx].iconTint,
                        modifier = Modifier.size(52.dp)
                    )
                }
            }

            Spacer(Modifier.height(36.dp))

            // Title
            AnimatedContent(
                targetState = pageIndex,
                transitionSpec = { fadeIn(tween(350)) togetherWith fadeOut(tween(200)) },
                label = "title"
            ) { idx ->
                Text(
                    text = pages[idx].title,
                    style = MaterialTheme.typography.headlineMedium,
                    fontWeight = FontWeight.Bold,
                    textAlign = TextAlign.Center,
                    color = MaterialTheme.colorScheme.onBackground,
                )
            }

            Spacer(Modifier.height(16.dp))

            // Body
            AnimatedContent(
                targetState = pageIndex,
                transitionSpec = { fadeIn(tween(400)) togetherWith fadeOut(tween(200)) },
                label = "body"
            ) { idx ->
                Text(
                    text = pages[idx].body,
                    style = MaterialTheme.typography.bodyLarge,
                    textAlign = TextAlign.Center,
                    color = MaterialTheme.colorScheme.onBackground.copy(alpha = 0.65f),
                    lineHeight = MaterialTheme.typography.bodyLarge.lineHeight,
                )
            }

            Spacer(Modifier.height(28.dp))

            // Optional action button
            AnimatedVisibility(visible = page.actionLabel != null) {
                OutlinedButton(
                    onClick = { page.onAction(context) },
                    modifier = Modifier.fillMaxWidth(),
                    shape = RoundedCornerShape(12.dp),
                ) {
                    Icon(Icons.Default.OpenInNew, null, Modifier.size(16.dp))
                    Spacer(Modifier.width(8.dp))
                    Text(page.actionLabel ?: "")
                }
            }

            Spacer(Modifier.weight(1f))

            // Page dots
            Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                repeat(pages.size) { i ->
                    val width by animateDpAsState(
                        targetValue = if (i == pageIndex) 24.dp else 6.dp,
                        animationSpec = spring(stiffness = Spring.StiffnessMedium),
                        label = "dot_$i"
                    )
                    Box(
                        modifier = Modifier
                            .height(6.dp)
                            .width(width)
                            .clip(CircleShape)
                            .background(
                                if (i == pageIndex) MaterialTheme.colorScheme.primary
                                else MaterialTheme.colorScheme.onSurface.copy(alpha = 0.2f)
                            )
                    )
                }
            }

            Spacer(Modifier.height(24.dp))

            // Next / Get started button
            Button(
                onClick = {
                    if (isLast) onFinish() else pageIndex++
                },
                modifier = Modifier
                    .fillMaxWidth()
                    .height(54.dp),
                shape = RoundedCornerShape(14.dp),
            ) {
                Text(
                    text = if (isLast) "Get Started" else "Next",
                    style = MaterialTheme.typography.titleMedium,
                    fontWeight = FontWeight.SemiBold,
                )
                if (!isLast) {
                    Spacer(Modifier.width(8.dp))
                    Icon(Icons.Default.ArrowForward, null, Modifier.size(18.dp))
                }
            }

            // Skip (only on early pages)
            AnimatedVisibility(!isLast && pageIndex < pages.lastIndex - 1) {
                TextButton(onClick = { pageIndex = pages.lastIndex }) {
                    Text("Skip", color = MaterialTheme.colorScheme.onSurface.copy(0.4f))
                }
            }

            Spacer(Modifier.height(8.dp))
        }
    }
}
