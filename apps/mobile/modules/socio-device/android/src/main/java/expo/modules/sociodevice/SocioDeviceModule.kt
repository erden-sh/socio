package expo.modules.sociodevice

import android.os.Build
import android.os.Process
import android.os.SystemClock
import android.os.UserManager
import android.webkit.CookieManager
import android.webkit.WebStorage
import android.webkit.WebView
import expo.modules.kotlin.Promise
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.functions.Queues
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import expo.modules.kotlin.types.Enumerable
import java.io.File

// Socio's device calls on Android. README.md describes each one on both
// platforms, including what the iOS-only calls mean here.
class SocioDeviceModule : Module() {
  // The process's start on the wall clock, read once so every call agrees.
  // Android 13 and later record when the system asked for the process, before
  // zygote forked it: the nearest match to iOS's process creation. Earlier
  // versions only record when the forked process bound to the app, which
  // leaves the fork out. Elapsed realtime counts deep sleep, so the offset
  // holds however long the phone slept since.
  private val processStart: Double by lazy {
    val start =
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
        Process.getStartRequestedElapsedRealtime()
      } else {
        Process.getStartElapsedRealtime()
      }
    val sinceStart = SystemClock.elapsedRealtime() - start
    (System.currentTimeMillis() - sinceStart).toDouble()
  }

  override fun definition() = ModuleDefinition {
    Name("SocioDevice")

    // Declared for parity with iOS; Android never sends them (README.md).
    Events("onProtectedDataChange", "onBackgroundGraceExpiring")

    // The manifest's backup rules decide what Android backs up, not a file
    // attribute: these check the path, as iOS does, and change nothing.
    AsyncFunction("excludeFromBackup") { path: String ->
      requireItem(path)
    }

    AsyncFunction("isExcludedFromBackup") { path: String ->
      requireItem(path)
      null as Boolean?
    }

    // File-based encryption covers the app's files; there are no per-file classes.
    AsyncFunction("setFileProtection") { path: String, _: FileProtection ->
      requireItem(path)
    }

    AsyncFunction("getFileProtection") { path: String ->
      requireItem(path)
      null as String?
    }

    // The app isn't direct-boot aware, so it never runs before the user's
    // credential-encrypted storage is unlocked: true whenever it can ask.
    AsyncFunction("isProtectedDataAvailable") {
      appContext.reactContext?.getSystemService(UserManager::class.java)?.isUserUnlocked ?: true
    }

    // iOS's background grace for the outbox. Android doesn't suspend an app
    // seconds after it leaves the screen, so v1 holds nothing here (README.md).
    AsyncFunction("holdBackgroundGrace") { _: Boolean ->
    }

    // iOS's app-switcher snapshots (CB-356). Android's recents thumbnail isn't
    // a file of the app's, so nothing is deleted: 0 files went (README.md).
    AsyncFunction("deleteAppSnapshots") {
      0
    }

    Function("processStartTime") {
      processStart
    }

    // The installed package's versionName and versionCode, so Settings shows what is installed.
    Function("appBuild") {
      val context = appContext.reactContext ?: return@Function mapOf("version" to "", "build" to "")
      @Suppress("DEPRECATION")
      val info = context.packageManager.getPackageInfo(context.packageName, 0)
      val code =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
          info.longVersionCode
        } else {
          @Suppress("DEPRECATION")
          info.versionCode.toLong()
        }
      mapOf("version" to (info.versionName ?: ""), "build" to code.toString())
    }

    // iOS's prewarming has no Android counterpart.
    Function("wasPrewarmed") {
      false
    }

    // Logs "Fully drawn <activity>: +<time since launch>" (ActivityTaskManager),
    // once per launch, for the cold-start cross-check.
    AsyncFunction("reportFullyDrawn") {
      val activity = appContext.currentActivity ?: return@AsyncFunction false
      activity.reportFullyDrawn()
      true
    }.runOnQueue(Queues.MAIN)

    // The system sign-in sheet: Chrome's Auth Tab with an https
    // callback, `unavailable` where the default browser has none (AuthTab.kt).
    AsyncFunction("openAuthTab") { url: String, host: String, path: String, promise: Promise ->
      AuthTab.open(appContext.currentActivity, url, host, path, promise)
    }.runOnQueue(Queues.MAIN)

    // Sign-out: nothing a WebView kept stays. The page editor runs
    // incognito with DOM storage off, so this is the second lock: every
    // cookie, the Web Storage and IndexedDB data (WebStorage), and the HTTP
    // cache and form data, through a throwaway WebView.
    AsyncFunction("clearWebViewData") { promise: Promise ->
      val context = appContext.reactContext
      if (context == null) {
        promise.resolve(false)
        return@AsyncFunction
      }
      WebStorage.getInstance().deleteAllData()
      val webView = WebView(context)
      webView.clearCache(true)
      webView.clearFormData()
      webView.clearHistory()
      webView.destroy()
      val cookies = CookieManager.getInstance()
      cookies.removeAllCookies {
        cookies.flush()
        promise.resolve(true)
      }
    }.runOnQueue(Queues.MAIN)
  }

  private fun requireItem(path: String) {
    if (!File(path).exists()) {
      throw ItemNotFoundException(path)
    }
  }
}

// iOS's data protection classes, accepted so a call that passes on Android passes on iOS too.
enum class FileProtection(val value: String) : Enumerable {
  COMPLETE("complete"),
  COMPLETE_UNLESS_OPEN("completeUnlessOpen"),
  COMPLETE_UNTIL_FIRST_USER_AUTHENTICATION("completeUntilFirstUserAuthentication"),
  NONE("none"),
}

class ItemNotFoundException(path: String) : CodedException("No file or directory at $path")
