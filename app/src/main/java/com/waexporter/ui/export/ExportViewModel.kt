package com.waexporter.ui.export

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.waexporter.domain.usecase.ExportChatUseCase
import com.waexporter.domain.usecase.ExportFormat
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.flow.*
import kotlinx.coroutines.launch
import javax.inject.Inject

data class ExportUiState(
    val isLoading: Boolean = false,
    val exportedText: String? = null,
    val error: String? = null,
    val selectedFormat: ExportFormat = ExportFormat.TXT,
)

@HiltViewModel
class ExportViewModel @Inject constructor(
    private val exportChatUseCase: ExportChatUseCase
) : ViewModel() {

    private val _state = MutableStateFlow(ExportUiState())
    val state: StateFlow<ExportUiState> = _state.asStateFlow()

    fun setFormat(format: ExportFormat) { _state.update { it.copy(selectedFormat = format) } }

    fun export(chatId: Long, chatName: String, startMs: Long? = null, endMs: Long? = null) {
        viewModelScope.launch {
            _state.update { it.copy(isLoading = true, exportedText = null, error = null) }
            runCatching {
                exportChatUseCase(chatId, chatName, _state.value.selectedFormat, startMs, endMs)
            }.onSuccess { text ->
                _state.update { it.copy(isLoading = false, exportedText = text) }
            }.onFailure { e ->
                _state.update { it.copy(isLoading = false, error = e.message) }
            }
        }
    }

    fun clearExport() { _state.update { it.copy(exportedText = null) } }
}
