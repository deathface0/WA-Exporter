package com.waexporter

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.Surface
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.fragment.app.FragmentActivity
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.waexporter.navigation.AppNavGraph
import com.waexporter.ui.lock.AppLockScreen
import com.waexporter.ui.onboarding.OnboardingPreferences
import com.waexporter.ui.onboarding.OnboardingScreen
import com.waexporter.ui.theme.WaExporterTheme
import dagger.hilt.android.AndroidEntryPoint
import kotlinx.coroutines.launch
import javax.inject.Inject

@AndroidEntryPoint
class MainActivity : FragmentActivity() {

    @Inject
    lateinit var onboardingPreferences: OnboardingPreferences

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        setContent {
            WaExporterTheme {
                Surface(modifier = Modifier.fillMaxSize()) {
                    AppGate(onboardingPreferences = onboardingPreferences)
                }
            }
        }
    }
}

/**
 * Manages the three entry gates in order:
 *  1. Biometric lock (if not already authenticated this session)
 *  2. Onboarding (if not yet completed)
 *  3. Main app nav graph
 */
@Composable
private fun AppGate(onboardingPreferences: OnboardingPreferences) {
    val scope = rememberCoroutineScope()

    val onboardingDone by onboardingPreferences.isOnboardingDone
        .collectAsStateWithLifecycle(initialValue = null)

    // Session-scoped unlock state (resets when app process dies)
    var sessionUnlocked by remember { mutableStateOf(false) }

    when {
        // Still loading DataStore — show nothing (avoids flash)
        onboardingDone == null -> {}

        // Onboarding not done yet → show onboarding first (skip lock)
        onboardingDone == false -> {
            OnboardingScreen(
                onFinish = {
                    scope.launch { onboardingPreferences.markOnboardingDone() }
                    sessionUnlocked = true
                }
            )
        }

        // Onboarding done but not unlocked this session → show lock
        !sessionUnlocked -> {
            AppLockScreen(onUnlocked = { sessionUnlocked = true })
        }

        // All gates passed → main app
        else -> {
            AppNavGraph()
        }
    }
}
