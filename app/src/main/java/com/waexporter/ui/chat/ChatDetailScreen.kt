package com.waexporter.ui.chat

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.waexporter.ui.components.MessageBubble
import com.waexporter.ui.theme.DeletedRed

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ChatDetailScreen(
    chatId: Long,
    chatName: String,
    onBack: () -> Unit,
    onExport: () -> Unit,
    viewModel: ChatDetailViewModel = hiltViewModel(),
) {
    LaunchedEffect(chatId) { viewModel.init(chatId) }

    val state by viewModel.uiState.collectAsStateWithLifecycle()
    val listState = rememberLazyListState()

    // Auto-scroll to bottom when new messages arrive
    LaunchedEffect(state.messages.size) {
        if (state.messages.isNotEmpty()) {
            listState.animateScrollToItem(state.messages.size - 1)
        }
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = {
                    Column {
                        Text(chatName, style = MaterialTheme.typography.titleMedium)
                        Text(
                            "${state.messages.size} messages",
                            style = MaterialTheme.typography.labelSmall,
                            color = MaterialTheme.colorScheme.onSurface.copy(0.5f)
                        )
                    }
                },
                navigationIcon = {
                    IconButton(onClick = onBack) {
                        Icon(Icons.Default.ArrowBack, "Back")
                    }
                },
                actions = {
                    // Toggle deleted-only filter
                    IconButton(onClick = viewModel::toggleDeletedFilter) {
                        Icon(
                            Icons.Default.Delete,
                            contentDescription = "Show deleted only",
                            tint = if (state.showDeletedOnly) DeletedRed
                            else MaterialTheme.colorScheme.onSurface.copy(0.6f)
                        )
                    }
                    IconButton(onClick = onExport) {
                        Icon(Icons.Default.FileDownload, "Export")
                    }
                }
            )
        }
    ) { padding ->
        LazyColumn(
            state = listState,
            modifier = Modifier
                .fillMaxSize()
                .padding(padding),
            contentPadding = PaddingValues(vertical = 8.dp)
        ) {
            items(state.messages, key = { it.id }) { message ->
                MessageBubble(message = message)
            }
        }
    }
}
