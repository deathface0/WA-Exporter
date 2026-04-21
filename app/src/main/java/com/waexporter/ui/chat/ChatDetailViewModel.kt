package com.waexporter.ui.chat

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.waexporter.data.db.entity.MessageEntity
import com.waexporter.data.repository.MessageRepository
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.flow.*
import kotlinx.coroutines.launch
import javax.inject.Inject

data class ChatDetailUiState(
    val messages: List<MessageEntity> = emptyList(),
    val showDeletedOnly: Boolean = false,
)

@HiltViewModel
class ChatDetailViewModel @Inject constructor(
    private val repository: MessageRepository
) : ViewModel() {

    private val _showDeletedOnly = MutableStateFlow(false)
    val showDeletedOnly: StateFlow<Boolean> = _showDeletedOnly.asStateFlow()

    private var _chatId: Long = -1L

    private val _allMessages = MutableStateFlow<List<MessageEntity>>(emptyList())

    val uiState: StateFlow<ChatDetailUiState> = combine(_allMessages, _showDeletedOnly) { msgs, deletedOnly ->
        ChatDetailUiState(
            messages = if (deletedOnly) msgs.filter { it.isDeleted } else msgs,
            showDeletedOnly = deletedOnly
        )
    }.stateIn(viewModelScope, SharingStarted.WhileSubscribed(5_000), ChatDetailUiState())

    fun init(chatId: Long) {
        if (_chatId == chatId) return
        _chatId = chatId
        viewModelScope.launch {
            repository.getMessagesForChat(chatId).collect { _allMessages.value = it }
        }
    }

    fun toggleDeletedFilter() { _showDeletedOnly.value = !_showDeletedOnly.value }

    fun toggleStar(messageId: Long, currently: Boolean) {
        viewModelScope.launch { repository.setStarred(messageId, !currently) }
    }
}
