package com.bilanciomoney.bilancio.ui.theme

import android.content.Context
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow

/**
 * Whether the app follows the phone, or is pinned to light or dark -- the
 * iPhone's Appearance setting, stored the same way: "follow the system" is a
 * choice of its own, so it is kept rather than inferred from never choosing.
 */
enum class Appearance(val label: String) {
    System("System"), Light("Light"), Dark("Dark");

    companion object {
        private const val PREFS = "bilancio"
        private const val KEY = "appearance"
        private val state = MutableStateFlow(System)
        val current: StateFlow<Appearance> = state

        /** Read once when the app starts, before the first frame. */
        fun load(context: Context) {
            val saved = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString(KEY, null)
            state.value = entries.firstOrNull { it.name == saved } ?: System
        }

        fun set(context: Context, value: Appearance) {
            context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putString(KEY, value.name).apply()
            state.value = value
        }
    }
}
