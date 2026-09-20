package com.bilanciomoney.bilancio

import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.Context
import com.google.firebase.FirebaseApp
import com.google.firebase.FirebaseOptions
import com.google.firebase.messaging.FirebaseMessaging
import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import kotlinx.coroutines.tasks.await

/**
 * Budget alerts on Android, through Firebase Cloud Messaging.
 *
 * ── Configured in code, not by a plugin ─────────────────────────────────────
 *
 * The usual setup is a google-services.json dropped in and a Gradle plugin to
 * read it. The four values it holds are not secrets -- they ship inside every
 * copy of the app -- so they are written here instead, which keeps a build
 * plugin out of the way and makes it obvious what the app is connecting to.
 *
 * Unset, `configured` is false: no token is asked for, nothing is registered,
 * and the alerts screen says so rather than half-working.
 *
 * ── What the server does with the token ─────────────────────────────────────
 *
 * Stores it against the account, with platform "android" so it is sent through
 * Firebase rather than Apple (src/fcm.ts). The alert itself is drawn by
 * Android from the notification block the server sends; nothing here has to be
 * running for one to arrive.
 */
object Push {
    /* From Firebase console -> Project settings -> your Android app. */
    private const val PROJECT_ID = "bilancio-b6fc4e72"
    private const val APPLICATION_ID = "1:261306312668:android:c8f0299a1fe1d9dcd75119"
    private const val API_KEY = "AIzaSyCMaSdZ8t2gxHwKrrHEhM-pG-T1p3EfgMw"
    private const val SENDER_ID = "261306312668"

    /** The channel the server names; without one, Android 8 and later are silent. */
    const val CHANNEL_ID = "budget_alerts"

    val configured: Boolean get() = PROJECT_ID.isNotBlank() && APPLICATION_ID.isNotBlank()

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)

    /** Called once per process, before anything asks for a token. */
    fun start(context: Context) {
        if (!configured) return
        if (FirebaseApp.getApps(context).isEmpty()) {
            FirebaseApp.initializeApp(
                context,
                FirebaseOptions.Builder()
                    .setProjectId(PROJECT_ID)
                    .setApplicationId(APPLICATION_ID)
                    .setApiKey(API_KEY)
                    .setGcmSenderId(SENDER_ID)
                    .build(),
            )
        }
        val manager = context.getSystemService(NotificationManager::class.java)
        manager?.createNotificationChannel(
            NotificationChannel(CHANNEL_ID, "Budget alerts", NotificationManager.IMPORTANCE_DEFAULT).apply {
                description = "When a category is nearly spent, or over its budget."
            },
        )
    }

    /**
     * Hands this phone's token to the server. Safe to call on every launch:
     * the server upserts, and Firebase hands out new tokens whenever it likes.
     */
    fun register(context: Context) {
        if (!configured) return
        scope.launch {
            runCatching {
                start(context)
                val token = FirebaseMessaging.getInstance().token.await()
                Bilancio.registerDevice(token)
            }.onFailure { android.util.Log.w("Bilancio", "push register failed: ${it.message}") }
        }
    }

    /** On sign-out: this phone stops being this account's. */
    fun unregister() {
        if (!configured) return
        scope.launch {
            runCatching {
                val token = FirebaseMessaging.getInstance().token.await()
                Bilancio.forgetDevice(token)
            }
        }
    }
}

/** Firebase's own callbacks: a new token, and anything sent while running. */
class BilancioMessagingService : FirebaseMessagingService() {
    override fun onNewToken(token: String) {
        /* Only useful while somebody is signed in; if not, the next launch
           registers it. The server refuses an unauthenticated call anyway. */
        CoroutineScope(SupervisorJob() + Dispatchers.IO).launch {
            runCatching { Bilancio.registerDevice(token) }
        }
    }

    override fun onMessageReceived(message: RemoteMessage) {
        /* Nothing to do: the server sends a notification block, which Android
           draws itself whether or not the app is running. This is here so a
           data-only message in future has somewhere to land. */
    }
}
