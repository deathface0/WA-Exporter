package com.waexporter.ui.settings

import android.content.Intent
import android.provider.Settings
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SettingsScreen(
    onBack: () -> Unit,
    viewModel: SettingsViewModel = hiltViewModel(),
) {
    val state by viewModel.state.collectAsStateWithLifecycle()
    val context = LocalContext.current
    var showDeleteDialog by remember { mutableStateOf(false) }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("Settings") },
                navigationIcon = { IconButton(onClick = onBack) { Icon(Icons.Default.ArrowBack, "Back") } }
            )
        }
    ) { padding ->
        LazyColumn(
            modifier = Modifier.fillMaxSize().padding(padding),
            contentPadding = PaddingValues(vertical = 8.dp)
        ) {
            item {
                SettingsSectionHeader("Permissions")
            }
            item {
                ListItem(
                    headlineContent = { Text("Notification Access") },
                    supportingContent = { Text("Required for message capture") },
                    leadingContent = { Icon(Icons.Default.Notifications, null) },
                    trailingContent = {
                        Button(onClick = {
                            context.startActivity(Intent(Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS))
                        }) { Text("Open") }
                    }
                )
            }
            item {
                ListItem(
                    headlineContent = { Text("Battery Optimization") },
                    supportingContent = { Text("Disable to prevent the capture service from being killed") },
                    leadingContent = { Icon(Icons.Default.BatteryFull, null) },
                    trailingContent = {
                        Button(onClick = {
                            val intent = Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS)
                            context.startActivity(intent)
                        }) { Text("Open") }
                    }
                )
            }

            item { SettingsSectionHeader("Storage") }
            item {
                ListItem(
                    headlineContent = { Text("Thumbnail cache") },
                    supportingContent = { Text(state.thumbnailCacheSize) },
                    leadingContent = { Icon(Icons.Default.Image, null) },
                    trailingContent = {
                        TextButton(onClick = viewModel::clearThumbnails) { Text("Clear") }
                    }
                )
            }
            item {
                ListItem(
                    headlineContent = { Text("Captured messages") },
                    supportingContent = { Text("${state.totalMessages} messages · ${state.totalDeleted} deleted") },
                    leadingContent = { Icon(Icons.Default.Forum, null) },
                )
            }

            item { SettingsSectionHeader("About") }
            item {
                ListItem(
                    headlineContent = { Text("WA-Exporter Android") },
                    supportingContent = { Text("Version 1.0.0 · android-dev branch") },
                    leadingContent = { Icon(Icons.Default.Info, null) }
                )
            }

            item { SettingsSectionHeader("Danger Zone") }
            item {
                ListItem(
                    headlineContent = { Text("Delete all chat history", color = MaterialTheme.colorScheme.error) },
                    supportingContent = { Text("Irreversibly erase all captured chats, messages, and thumbnails from this device") },
                    leadingContent = { Icon(Icons.Default.DeleteForever, null, tint = MaterialTheme.colorScheme.error) },
                    trailingContent = {
                        Button(
                            onClick = { showDeleteDialog = true },
                            colors = ButtonDefaults.buttonColors(containerColor = MaterialTheme.colorScheme.error)
                        ) { Text("Delete") }
                    }
                )
            }
        }

        if (showDeleteDialog) {
            AlertDialog(
                onDismissRequest = { showDeleteDialog = false },
                icon = { Icon(Icons.Default.Warning, contentDescription = null, tint = MaterialTheme.colorScheme.error) },
                title = { Text("Erase all history?") },
                text = { Text("Are you sure you want to delete all captured WhatsApp messages? This action cannot be undone and will wipe the local database completely.") },
                confirmButton = {
                    TextButton(
                        onClick = {
                            viewModel.deleteAllHistory()
                            showDeleteDialog = false
                        },
                        colors = ButtonDefaults.textButtonColors(contentColor = MaterialTheme.colorScheme.error)
                    ) {
                        Text("Delete Everything")
                    }
                },
                dismissButton = {
                    TextButton(onClick = { showDeleteDialog = false }) {
                        Text("Cancel")
                    }
                }
            )
        }
    }
}

@Composable
private fun SettingsSectionHeader(title: String) {
    Text(
        text = title.uppercase(),
        style = MaterialTheme.typography.labelSmall,
        color = MaterialTheme.colorScheme.primary,
        modifier = Modifier.padding(start = 16.dp, top = 16.dp, bottom = 4.dp)
    )
}
