package com.bilanciomoney.bilancio

import android.app.Application
import com.clerk.api.Clerk
import com.clerk.api.ClerkConfigurationOptions

/**
 * Clerk is started once, for the whole process.
 *
 * The publishable key is public by design — it is in the web app's HTML and in
 * wrangler.jsonc, and it identifies the instance rather than granting anything.
 * The secret key never leaves the Worker.
 */
class BilancioApp : Application() {
    override fun onCreate() {
        super.onCreate()
        val debuggable = (applicationInfo.flags and android.content.pm.ApplicationInfo.FLAG_DEBUGGABLE) != 0
        /* Debug logging in debug builds only: Clerk otherwise swallows the
           reason a sign-in did not complete, and a silent return to the
           sign-in screen is not something a user can report usefully. */
        Push.start(this)
        Clerk.initialize(
            this,
            publishableKey = Bilancio.CLERK_PUBLISHABLE_KEY,
            options = ClerkConfigurationOptions(enableDebugMode = debuggable),
        )
    }
}
