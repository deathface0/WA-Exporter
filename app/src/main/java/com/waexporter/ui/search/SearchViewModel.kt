package com.waexporter.ui.search

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.waexporter.data.db.entity.MessageEntity
import com.waexporter.data.repository.MessageRepository
import com.waexporter.domain.usecase.SearchMessagesUseCase
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.FlowPreview
import kotlinx.coroutines.flow.*
import javax.inject.Inject

@OptIn(FlowPreview::class, ExperimentalCoroutinesApi::class)
@HiltViewModel
class SearchViewModel @Inject constructor(
    private val searchMessages: SearchMessagesUseCase,
    private val repository: MessageRepository,
) : ViewModel() {

    private val _query = MutableStateFlow("")
    val query: StateFlow<String> = _query.asStateFlow()

    // Starred messages always shown when query is empty
    val starredMessages: StateFlow<List<MessageEntity>> = repository.getStarredMessages()
        .stateIn(viewModelScope, SharingStarted.WhileSubscribed(5_000), emptyList())

    val results: StateFlow<List<MessageEntity>> = _query
        .debounce(300)
        .distinctUntilChanged()
        .flatMapLatest { q ->
            if (q.length < 2) flowOf(emptyList())
            else searchMessages(q)
        }
        .stateIn(viewModelScope, SharingStarted.WhileSubscribed(5_000), emptyList())

    fun onQueryChange(q: String) { _query.value = q }
}
