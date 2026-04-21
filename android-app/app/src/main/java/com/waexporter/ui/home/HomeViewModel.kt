package com.waexporter.ui.home

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.waexporter.data.db.entity.ChatEntity
import com.waexporter.data.repository.MessageRepository
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.flow.*
import javax.inject.Inject

data class HomeUiState(
    val chats: List<ChatEntity> = emptyList(),
    val totalDeletedCount: Int = 0,
    val isCapturing: Boolean = true,
)

@HiltViewModel
class HomeViewModel @Inject constructor(
    private val repository: MessageRepository
) : ViewModel() {

    val uiState: StateFlow<HomeUiState> = repository.getAllChats()
        .map { chats ->
            HomeUiState(
                chats = chats,
                totalDeletedCount = chats.sumOf { it.deletedMessageCount },
                isCapturing = true
            )
        }
        .stateIn(viewModelScope, SharingStarted.WhileSubscribed(5_000), HomeUiState())
}
