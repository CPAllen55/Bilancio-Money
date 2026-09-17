package com.bilanciomoney.bilancio

import android.app.Application
import com.clerk.api.Clerk

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
        Clerk.initialize(this, publishableKey = Bilancio.CLERK_PUBLISHABLE_KEY)
    }
}
