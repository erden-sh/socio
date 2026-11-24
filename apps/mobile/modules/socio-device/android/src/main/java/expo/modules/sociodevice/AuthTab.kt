package expo.modules.sociodevice

import android.app.Activity
import android.content.Intent
import android.net.Uri
import androidx.activity.result.ActivityResultLauncher
import androidx.activity.result.ActivityResultRegistryOwner
import androidx.activity.result.contract.ActivityResultContracts
import androidx.browser.auth.AuthTabIntent
import androidx.browser.customtabs.CustomTabsClient
import expo.modules.kotlin.Promise

// The system sign-in sheet with an https callback on Android.
// Chrome's Auth Tab (androidx.browser 1.9, Chrome 137 and later) checks the
// redirect host against the app's Digital Asset Links itself and hands the
// callback back as an activity result, so no other app can take it. Where the
// default browser has no Auth Tab (isAuthTabSupported false, as Google's docs
// say to go by), this answers `unavailable` and the caller falls back to
// expo-web-browser's Custom Tab, whose callback comes back as the variant's
// verified App Link.
//
// The launcher is registered on the activity's registry without a lifecycle
// owner: registerActivityResultLauncher needs one before STARTED, which a
// module call never is. A process killed while the tab shows loses this
// result; the callback is also the variant's App Link, which the sheet sign-in's
// pending flow in secure-store picks up after a restart.
//
// Not ephemeral: the browser's passkeys and SSO sessions are there.
internal object AuthTab {
  private const val KEY = "socio-auth-tab"
  private var launcher: ActivityResultLauncher<Intent>? = null
  private var pending: Promise? = null

  fun open(activity: Activity?, url: String, host: String, path: String, promise: Promise) {
    val owner = activity as? ActivityResultRegistryOwner
    if (activity == null || owner == null) {
      promise.resolve(mapOf("type" to "unavailable", "reason" to "no-activity"))
      return
    }
    val browser = CustomTabsClient.getPackageName(activity, null)
    if (browser == null) {
      promise.resolve(mapOf("type" to "unavailable", "reason" to "no-browser"))
      return
    }
    if (!CustomTabsClient.isAuthTabSupported(activity, browser)) {
      promise.resolve(mapOf("type" to "unavailable", "reason" to "no-auth-tab"))
      return
    }
    // One sheet at a time: a second call ends the first as cancelled.
    pending?.resolve(mapOf("type" to "cancel", "reason" to "replaced"))
    pending = promise
    launcher?.unregister()
    val registered =
      owner.activityResultRegistry.register(KEY, ActivityResultContracts.StartActivityForResult()) { result ->
        val answer = pending
        pending = null
        launcher?.unregister()
        launcher = null
        answer?.resolve(
          when (result.resultCode) {
            AuthTabIntent.RESULT_OK -> mapOf("type" to "success", "url" to result.data?.data?.toString())
            AuthTabIntent.RESULT_CANCELED -> mapOf("type" to "cancel")
            AuthTabIntent.RESULT_VERIFICATION_FAILED -> mapOf("type" to "verification-failed")
            AuthTabIntent.RESULT_VERIFICATION_TIMED_OUT -> mapOf("type" to "verification-timed-out")
            else -> mapOf("type" to "unknown", "code" to result.resultCode)
          },
        )
      }
    launcher = registered
    val intent = AuthTabIntent.Builder().setEphemeralBrowsingEnabled(false).build()
    intent.intent.setPackage(browser)
    intent.launch(registered, Uri.parse(url), host, path)
  }
}
