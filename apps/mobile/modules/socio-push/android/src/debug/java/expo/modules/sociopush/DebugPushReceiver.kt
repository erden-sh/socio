package expo.modules.sociopush

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.util.Base64
import org.json.JSONObject

/**
 * Debug builds only (src/debug): the emulator's way into the messaging service without FCM
 * (../../../../../README.md, Debug hook; e2e/debug-push.mjs drives it).
 *
 * - SEED (`workspace`, `registration`, `name`): new keys for the workspace and its registration, as
 *   PS will make them; the result data is `{p256dh, auth}`, for the sender to encrypt to.
 * - PUSH (`s`, and `p` or `g`): the relay's FCM data, handed to PushNotifier as the service hands it.
 */
class DebugPushReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) {
    val store = PushStore.get(context)
    when (intent.action) {
      "expo.modules.sociopush.debug.SEED" -> {
        val workspace = intent.getStringExtra("workspace") ?: return fail("no workspace")
        val registration = intent.getStringExtra("registration") ?: return fail("no registration")
        val keys = store.createKeys(workspace)
        keys.privateKey.fill(0)
        store.setRegistration(registration, PushRegistration(workspace, intent.getStringExtra("name").orEmpty()))
        resultCode = 1
        resultData = JSONObject()
          .put("p256dh", base64url(keys.publicKey))
          .put("auth", base64url(keys.auth))
          .toString()
      }
      "expo.modules.sociopush.debug.PUSH" -> {
        val data = listOf("s", "p", "g").mapNotNull { key -> intent.getStringExtra(key)?.let { key to it } }.toMap()
        PushNotifier.receive(context, data, null)
        resultCode = 1
        resultData = "handed to the service"
      }
    }
  }

  private fun fail(reason: String) {
    resultCode = 0
    resultData = reason
  }

  private fun base64url(bytes: ByteArray) =
    Base64.encodeToString(bytes, Base64.URL_SAFE or Base64.NO_PADDING or Base64.NO_WRAP)
}
