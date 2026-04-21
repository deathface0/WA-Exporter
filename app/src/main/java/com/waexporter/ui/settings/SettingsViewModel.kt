package com.waexporter.ui.settings

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.waexporter.data.repository.MessageRepository
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.flow.*
import kotlinx.coroutines.launch
import javax.inject.Inject

data class SettingsUiState(
    val thumbnailCacheSize: String = "Calculating…",
    val totalMessages: Int = 0,
    val totalDeleted: Int = 0,
)

@HiltViewModel
class SettingsViewModel @Inject constructor(
    private val repository: MessageRepository
) : ViewModel() {

    private val _state = MutableStateFlow(SettingsUiState())
    val state: StateFlow<SettingsUiState> = _state.asStateFlow()

    init {
        viewModelScope.launch {
            val sizeBytes = repository.thumbnailStorageSizeBytes()
            val deleted = repository.countDeleted()
            _state.update {
                it.copy(
                    thumbnailCacheSize = formatBytes(sizeBytes),
                    totalDeleted = deleted,
                )
            }
        }
    }

    fun clearThumbnails() {
        viewModelScope.launch {
            repository.clearAllThumbnails()
            _state.update { it.copy(thumbnailCacheSize = "0 B") }
        }
    }

    fun deleteAllHistory() {
        viewModelScope.launch {
            repository.deleteAllHistory()
            _state.update { 
                it.copy(
                    thumbnailCacheSize = "0 B",
                    totalMessages = 0,
                    totalDeleted = 0
                )
            }
        }
    }

    private fun formatBytes(bytes: Long): String = when {
        bytes < 1024      -> "$bytes B"
        bytes < 1024 * 1024 -> "${bytes / 1024} KB"
        else              -> "${bytes / (1024 * 1024)} MB"
    }
}
