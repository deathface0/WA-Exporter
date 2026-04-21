package com.waexporter.domain.usecase

import com.waexporter.data.db.entity.MessageEntity
import com.waexporter.data.repository.MessageRepository
import kotlinx.coroutines.flow.Flow
import javax.inject.Inject

/** Searches across all messages for a given text query. */
class SearchMessagesUseCase @Inject constructor(
    private val repository: MessageRepository
) {
    operator fun invoke(query: String): Flow<List<MessageEntity>> =
        repository.searchMessages(query)
}
