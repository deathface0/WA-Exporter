package com.waexporter.navigation

import androidx.compose.runtime.Composable
import androidx.navigation.NavType
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.rememberNavController
import androidx.navigation.navArgument
import com.waexporter.ui.chat.ChatDetailScreen
import com.waexporter.ui.export.ExportScreen
import com.waexporter.ui.home.HomeScreen
import com.waexporter.ui.search.SearchScreen
import com.waexporter.ui.settings.SettingsScreen

object Routes {
    const val HOME     = "home"
    const val CHAT     = "chat/{chatId}/{chatName}"
    const val SEARCH   = "search"
    const val EXPORT   = "export/{chatId}/{chatName}"
    const val SETTINGS = "settings"

    fun chat(chatId: Long, chatName: String) = "chat/$chatId/${chatName.encodeUrl()}"
    fun export(chatId: Long, chatName: String) = "export/$chatId/${chatName.encodeUrl()}"

    private fun String.encodeUrl() = java.net.URLEncoder.encode(this, "UTF-8")
}

@Composable
fun AppNavGraph() {
    val navController = rememberNavController()

    NavHost(navController = navController, startDestination = Routes.HOME) {

        composable(Routes.HOME) {
            HomeScreen(
                onChatClick    = { chat -> navController.navigate(Routes.chat(chat.id, chat.name)) },
                onSearchClick  = { navController.navigate(Routes.SEARCH) },
                onSettingsClick = { navController.navigate(Routes.SETTINGS) }
            )
        }

        composable(
            route = Routes.CHAT,
            arguments = listOf(
                navArgument("chatId")   { type = NavType.LongType },
                navArgument("chatName") { type = NavType.StringType }
            )
        ) { back ->
            val chatId   = back.arguments!!.getLong("chatId")
            val chatName = back.arguments!!.getString("chatName") ?: ""
            ChatDetailScreen(
                chatId   = chatId,
                chatName = chatName,
                onBack   = { navController.popBackStack() },
                onExport = { navController.navigate(Routes.export(chatId, chatName)) }
            )
        }

        composable(Routes.SEARCH) {
            SearchScreen(
                onChatClick = { chat -> navController.navigate(Routes.chat(chat.id, chat.name)) },
                onBack      = { navController.popBackStack() }
            )
        }

        composable(
            route = Routes.EXPORT,
            arguments = listOf(
                navArgument("chatId")   { type = NavType.LongType },
                navArgument("chatName") { type = NavType.StringType }
            )
        ) { back ->
            val chatId   = back.arguments!!.getLong("chatId")
            val chatName = back.arguments!!.getString("chatName") ?: ""
            ExportScreen(chatId = chatId, chatName = chatName, onBack = { navController.popBackStack() })
        }

        composable(Routes.SETTINGS) {
            SettingsScreen(onBack = { navController.popBackStack() })
        }
    }
}
