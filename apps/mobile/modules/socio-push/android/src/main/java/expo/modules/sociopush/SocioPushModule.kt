package expo.modules.sociopush

import android.util.Base64
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.exception.Exceptions
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

// socio-push on Android (../../README.md): the same calls as iOS's module,
// and the messaging service's three: the chat on screen, and a
// notification's tap, at launch and while running. JavaScript sees only each
// workspace's public key and auth secret; the private key stays in PushStore.
// The work is there and in PushNotifier; this file only binds it.
class SocioPushModule : Module() {
  private val store: PushStore
    get() = PushStore.get(appContext.reactContext ?: throw Exceptions.ReactContextLost())

  override fun definition() = ModuleDefinition {
    Name("SocioPush")

    // No groups on Android: the service runs in the app's process and reads
    // the app's own no-backup storage, so the items are always shared with it,
    // and the inbox is always there.
    AsyncFunction("storage") {
      mapOf("keychainGroup" to null, "shared" to true, "inbox" to true)
    }

    AsyncFunction("createKeys") { workspaceId: String ->
      publicKeys(guard { store.createKeys(workspaceId) })
    }

    AsyncFunction("getKeys") { workspaceId: String ->
      guard { store.keys(workspaceId) }?.let(::publicKeys)
    }

    AsyncFunction("deleteKeys") { workspaceId: String ->
      guard { store.deleteKeys(workspaceId) }
    }

    AsyncFunction("setRegistration") { registrationId: String, workspaceId: String, name: String ->
      guard { store.setRegistration(registrationId, PushRegistration(workspaceId, name)) }
    }

    AsyncFunction("deleteRegistration") { registrationId: String ->
      guard { store.deleteRegistration(registrationId) }
    }

    AsyncFunction("getState") { workspaceId: String ->
      val flags = guard { store.flags(workspaceId) }
      mapOf("locked" to flags.locked, "leaseLockAt" to flags.leaseLockAt, "showText" to store.showText())
    }

    AsyncFunction("setLocked") { workspaceId: String, locked: Boolean ->
      guard { store.setLocked(workspaceId, locked) }
    }

    AsyncFunction("setLeaseLockAt") { workspaceId: String, at: Double? ->
      guard { store.setLeaseLockAt(workspaceId, at) }
    }

    AsyncFunction("setShowText") { showText: Boolean ->
      guard { store.setShowText(showText) }
    }

    AsyncFunction("decrypt") { workspaceId: String, body: String ->
      val data =
        try {
          Base64.decode(body, Base64.URL_SAFE or Base64.NO_PADDING or Base64.NO_WRAP)
        } catch (error: IllegalArgumentException) {
          throw DecryptException("the body isn't base64url")
        }
      val plaintext =
        try {
          guard { store.decrypt(workspaceId, data) }
        } catch (error: PushDecryptException) {
          throw DecryptException(error.message ?: "it doesn't decrypt")
        }
      val decoder = Charsets.UTF_8.newDecoder()
      try {
        decoder.decode(java.nio.ByteBuffer.wrap(plaintext)).toString()
      } catch (error: java.nio.charset.CharacterCodingException) {
        throw DecryptException("the plaintext isn't UTF-8")
      }
    }

    AsyncFunction("listInbox") {
      guard { store.listInbox() }.map { mapOf("id" to it.id, "json" to it.json) }
    }

    AsyncFunction("deleteInbox") { ids: List<String> ->
      guard { store.deleteInbox(ids) }
    }

    // The chat on screen: a push for it isn't shown while the app is in front.
    Function("setScreen") { workspaceId: String?, path: String? ->
      PushNotifier.setScreen(workspaceId, path)
    }

    Events("onTap")

    // Whether JavaScript listens (TapRelay): until it does, a new intent's tap is held for takeLaunchTap.
    OnStartObserving("onTap") { TapRelay.shared.setListening(true) }
    OnStopObserving("onTap") { TapRelay.shared.setListening(false) }
    OnDestroy { TapRelay.shared.setListening(false) }

    // The tap that started the app, or one held before JavaScript listened, once: its token is taken
    // off the intent and out of the store.
    AsyncFunction("takeLaunchTap") {
      val token = appContext.currentActivity?.intent?.let(::tokenOf)
      TapRelay.shared.takeLaunch(token) { store.takeTap(it) }?.let(::tapMap)
    }

    // A tap while the app runs: the launcher activity is single-task, so it comes as a new intent.
    OnNewIntent { intent ->
      tokenOf(intent)?.let { token ->
        TapRelay.shared.onNewIntent(token) { store.takeTap(it) }?.let { sendEvent("onTap", tapMap(it)) }
      }
    }
  }

  private fun tokenOf(intent: android.content.Intent): String? {
    val token = intent.getStringExtra(PushNotifier.EXTRA_TAP) ?: return null
    intent.removeExtra(PushNotifier.EXTRA_TAP)
    return token
  }

  private fun tapMap(target: PushTarget): Map<String, Any?> =
    mapOf("workspaceId" to target.workspaceId, "link" to target.link, "tag" to target.tag)

  private fun publicKeys(keys: PushKeys): Map<String, String> {
    keys.privateKey.fill(0)
    return mapOf("p256dh" to base64url(keys.publicKey), "auth" to base64url(keys.auth))
  }

  private fun base64url(bytes: ByteArray) =
    Base64.encodeToString(bytes, Base64.URL_SAFE or Base64.NO_PADDING or Base64.NO_WRAP)

  private inline fun <T> guard(block: () -> T): T =
    try {
      block()
    } catch (error: PushStoreException) {
      throw PushStoreFailedException(error.message ?: "the push store failed")
    }
}

class DecryptException(reason: String) : CodedException("ERR_PUSH_DECRYPT", "Couldn't decrypt the push: $reason", null)

class PushStoreFailedException(reason: String) : CodedException("ERR_PUSH_STORE", reason, null)
