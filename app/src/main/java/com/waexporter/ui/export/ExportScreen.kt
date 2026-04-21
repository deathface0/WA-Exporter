package com.waexporter.ui.export

import android.content.Intent
import androidx.compose.foundation.layout.*
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.waexporter.domain.usecase.ExportFormat

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ExportScreen(
    chatId: Long,
    chatName: String,
    onBack: () -> Unit,
    viewModel: ExportViewModel = hiltViewModel(),
) {
    val state by viewModel.state.collectAsStateWithLifecycle()
    val context = LocalContext.current

    // Auto-share when export completes
    LaunchedEffect(state.exportedText) {
        val text = state.exportedText ?: return@LaunchedEffect
        val ext = when (state.selectedFormat) {
            is ExportFormat.TXT  -> "txt"
            is ExportFormat.JSON -> "json"
            is ExportFormat.CSV  -> "csv"
        }
        val shareIntent = Intent(Intent.ACTION_SEND).apply {
            type = "text/plain"
            putExtra(Intent.EXTRA_TEXT, text)
            putExtra(Intent.EXTRA_SUBJECT, "WA-Exporter — $chatName.$ext")
        }
        context.startActivity(Intent.createChooser(shareIntent, "Share chat export"))
        viewModel.clearExport()
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("Export — $chatName") },
                navigationIcon = { IconButton(onClick = onBack) { Icon(Icons.Default.ArrowBack, "Back") } }
            )
        }
    ) { padding ->
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(padding)
                .padding(24.dp),
            verticalArrangement = Arrangement.spacedBy(20.dp)
        ) {
            Text("Format", style = MaterialTheme.typography.titleSmall)

            val formats = listOf(
                ExportFormat.TXT  to "TXT  — Plain text (browser extension compatible)",
                ExportFormat.JSON to "JSON — Structured data",
                ExportFormat.CSV  to "CSV  — Spreadsheet ready",
            )

            formats.forEach { (format, label) ->
                Row(
                    verticalAlignment = Alignment.CenterVertically,
                    modifier = Modifier.fillMaxWidth()
                ) {
                    RadioButton(
                        selected = state.selectedFormat::class == format::class,
                        onClick = { viewModel.setFormat(format) }
                    )
                    Spacer(Modifier.width(8.dp))
                    Text(label, style = MaterialTheme.typography.bodyMedium)
                }
            }

            Spacer(Modifier.weight(1f))

            if (state.error != null) {
                Text(
                    "Error: ${state.error}",
                    color = MaterialTheme.colorScheme.error,
                    style = MaterialTheme.typography.bodySmall
                )
            }

            Button(
                onClick = { viewModel.export(chatId, chatName) },
                enabled = !state.isLoading,
                modifier = Modifier.fillMaxWidth().height(52.dp)
            ) {
                if (state.isLoading) {
                    CircularProgressIndicator(Modifier.size(20.dp), strokeWidth = 2.dp,
                        color = MaterialTheme.colorScheme.onPrimary)
                } else {
                    Icon(Icons.Default.Share, null, Modifier.size(18.dp))
                    Spacer(Modifier.width(8.dp))
                    Text("Export & Share")
                }
            }
        }
    }
}
