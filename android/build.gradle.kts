buildscript {
    /* AGP 9.4 brings Kotlin 2.2, and the Clerk SDK is compiled with 2.4 -- a
       2.2 compiler cannot read 2.4 metadata. Built-in Kotlin uses the newest
       Kotlin Gradle plugin on the build classpath, so it is named here rather
       than applied as a plugin (which AGP 9 refuses alongside its new DSL). */
    dependencies {
        classpath("org.jetbrains.kotlin:kotlin-gradle-plugin:2.4.20")
    }
}
// Top-level build file where you can add configuration options common to all sub-projects/modules.
plugins {
    alias(libs.plugins.android.application) apply false
    alias(libs.plugins.kotlin.compose) apply false
}