package expo.modules.sociopush

import org.json.JSONException
import org.json.JSONObject

// What the messaging service shows for a push (../../README.md, Messaging service). The same rules
// as iOS's extension (PushContentMapper), in plain Kotlin with no Android class, so the JVM test
// runs it; PushNotifier posts the result.
//
// The relay sends FCM data `{s, p}`: `s` is the relay registration id, `p` the aes128gcm ciphertext
// (base64url) of the server's payload, `{kind, title, body, link, tag?, icon?, image?}`. A push too
// large for FCM comes as `{s, g: "1"}`, the relay's generic alert.
//
// - No `p`, an unknown registration, no keys, a failed decryption or a payload that isn't one: the
//   relay's generic text ("Socio", "Open the app"), and a tap only opens the app.
// - The workspace locked (Ended, or the lease) or the device clock past its `leaseLockAt`: nothing is
//   decrypted, and our generic text shows; a tap opens the workspace.
// - "Show message text in notifications" off: decrypted for the tap and the inbox file, and our
//   generic text shows.
// - Otherwise the payload's title and body.
//
// `icon` and `image` are never read: fetching them would tell the workspace when and where the phone
// got the push. Nothing here touches the badge.

/** What the service reads and keeps (PushStore's), so the tests can hand in a fake. */
interface PushSource {
  fun registration(registrationId: String): PushRegistration?
  fun registeredWorkspaces(): Set<String>
  fun flags(workspaceId: String): WorkspaceFlags
  fun showText(): Boolean
  /** The plaintext, or PushDecryptException (no keys, or it doesn't decrypt). */
  fun decrypt(workspaceId: String, body: ByteArray): ByteArray
  fun markSeen(id: String): Boolean
  fun putTap(target: PushTarget): String
  fun takeTap(token: String): PushTarget?
  fun writeInbox(workspaceId: String, link: String, tag: String?, receivedAt: Long): String
}

/** Where a push points: the payload's link and tag, and the workspace whose keys decrypted it. */
data class PushTarget(val workspaceId: String, val link: String, val tag: String?)

/** The notification's text and where it points, for PushNotifier to post. */
data class PushContent(
  val title: String,
  val body: String,
  /** The workspace's name when more than one workspace has push on this phone, else null. */
  val subText: String?,
  /** The workspace's name, for the public version ("New message in <name>"); empty when unknown. */
  val workspaceName: String,
  /** `<workspace id>:<tag>`: one conversation's notifications group together, two workspaces' never mix. */
  val group: String?,
  val channel: String,
  /** What a tap opens; null opens the app as it is. */
  val target: PushTarget?,
  /** Whether the push gets an inbox file (decrypted pushes only). */
  val inbox: Boolean,
)

sealed class PushOutcome {
  /** Show the relay's generic text. The reason is for the log, never shown. */
  data class RelayGeneric(val reason: PushFallback, val content: PushContent) : PushOutcome()

  data class Show(val content: PushContent) : PushOutcome()
}

enum class PushFallback { NO_CIPHERTEXT, UNKNOWN_REGISTRATION, NO_KEYS, UNDECRYPTABLE, NOT_A_PAYLOAD }

object PushMessages {
  const val GENERIC_TITLE = "Socio"
  const val GENERIC_BODY = "New message"
  /** The relay's generic alert (apps/push-relay's GENERIC_ALERT), as iOS shows it. */
  const val RELAY_BODY = "Open the app"

  /** Mentions and room activity: high importance, so they make a sound and peek. */
  const val MESSAGES_CHANNEL = "socio.messages"
  /** Socios' reports: default importance. */
  const val REPORTS_CHANNEL = "socio.reports"

  private val ID = Regex("^[A-Za-z0-9_-]{1,128}$")
  private val BASE64URL = Regex("^[A-Za-z0-9_-]+$")

  /** Whether FCM data is a Socio push (the relay's `{s, p}` or `{s, g}`), not one for expo-notifications. */
  fun isOurs(data: Map<String, String>): Boolean = data["s"] != null && (data["p"] != null || data["g"] != null)

  /**
   * The id that drops a retry: the ciphertext's first 16 bytes are its random salt, new for each push
   * the server encrypts, so a resend of the same body has the same id. The relay's generic alert has
   * no ciphertext, so it goes by FCM's message id, when there is one.
   */
  fun dedupeId(data: Map<String, String>, messageId: String?): String? {
    val registration = data["s"] ?: return null
    val ciphertext = data["p"]
    return when {
      ciphertext != null && ciphertext.length >= 22 -> "p:$registration:${ciphertext.take(22)}"
      messageId != null -> "m:$messageId"
      else -> null
    }
  }

  fun map(data: Map<String, String>, source: PushSource, nowMs: Long): PushOutcome {
    val registrationId = data["s"]?.takeIf { ID.matches(it) }
      ?: return relayGeneric(PushFallback.UNKNOWN_REGISTRATION, null, null)
    val registration = source.registration(registrationId)
      ?: return relayGeneric(PushFallback.UNKNOWN_REGISTRATION, null, null)
    val name = registration.name
    val subText = if (source.registeredWorkspaces().size > 1 && name.isNotEmpty()) name else null
    val ciphertext = data["p"]?.takeIf { it.isNotEmpty() }
      ?: return relayGeneric(PushFallback.NO_CIPHERTEXT, name, subText)

    // A locked copy, by its flag or by the lease's deadline on the device clock: nothing is decrypted.
    val flags = source.flags(registration.workspaceId)
    if (flags.locked || (flags.leaseLockAt != null && nowMs >= flags.leaseLockAt)) {
      return PushOutcome.Show(
        PushContent(
          title = GENERIC_TITLE,
          body = GENERIC_BODY,
          subText = subText,
          workspaceName = name,
          group = null,
          channel = MESSAGES_CHANNEL,
          target = PushTarget(registration.workspaceId, "/", null),
          inbox = false,
        ),
      )
    }

    val body = decodeBase64Url(ciphertext) ?: return relayGeneric(PushFallback.UNDECRYPTABLE, name, subText)
    val plaintext =
      try {
        source.decrypt(registration.workspaceId, body)
      } catch (error: PushDecryptException) {
        val reason =
          if (error.message == NO_KEYS) PushFallback.NO_KEYS else PushFallback.UNDECRYPTABLE
        return relayGeneric(reason, name, subText)
      }
    val payload = parsePayload(plaintext) ?: return relayGeneric(PushFallback.NOT_A_PAYLOAD, name, subText)

    val target = PushTarget(registration.workspaceId, payload.link, payload.tag)
    val showText = source.showText()
    return PushOutcome.Show(
      PushContent(
        title = if (showText) payload.title else GENERIC_TITLE,
        body = if (showText) payload.body else GENERIC_BODY,
        subText = subText,
        workspaceName = name,
        group = payload.tag?.let { "${registration.workspaceId}:$it" },
        // Every push is a message today; reports get their own kind later.
        channel = if (payload.kind == "report") REPORTS_CHANNEL else MESSAGES_CHANNEL,
        target = target,
        inbox = true,
      ),
    )
  }

  /** PushStore.decrypt's message when the workspace has no keys. */
  const val NO_KEYS = "the workspace has no push keys"

  private fun relayGeneric(reason: PushFallback, name: String?, subText: String?) =
    PushOutcome.RelayGeneric(
      reason,
      PushContent(
        title = GENERIC_TITLE,
        body = RELAY_BODY,
        subText = subText,
        workspaceName = name.orEmpty(),
        group = null,
        channel = MESSAGES_CHANNEL,
        target = null,
        inbox = false,
      ),
    )

  /** The server's payload (src/server/notifications/push.ts), the fields shown. `icon` and `image` aren't read at all. */
  private class Payload(val kind: String, val title: String, val body: String, val link: String, val tag: String?)

  private fun parsePayload(plaintext: ByteArray): Payload? {
    val text =
      try {
        Charsets.UTF_8.newDecoder().decode(java.nio.ByteBuffer.wrap(plaintext)).toString()
      } catch (error: java.nio.charset.CharacterCodingException) {
        return null
      }
    return try {
      val json = JSONObject(text)
      val kind = json.get("kind") as? String ?: return null
      val title = json.get("title") as? String ?: return null
      val body = json.get("body") as? String ?: return null
      val link = json.get("link") as? String ?: return null
      if (!link.startsWith("/")) return null
      val tag = if (json.has("tag") && !json.isNull("tag")) json.get("tag") as? String ?: return null else null
      Payload(kind, title, body, link, tag?.takeIf { it.isNotEmpty() })
    } catch (error: JSONException) {
      null
    }
  }

  /** base64url without padding (RFC 4648 5), with no Android class; null when it isn't. */
  fun decodeBase64Url(value: String): ByteArray? {
    if (!BASE64URL.matches(value) || value.length % 4 == 1) return null
    val out = java.io.ByteArrayOutputStream(value.length * 3 / 4)
    var buffer = 0
    var bits = 0
    for (char in value) {
      val digit = when (char) {
        in 'A'..'Z' -> char - 'A'
        in 'a'..'z' -> char - 'a' + 26
        in '0'..'9' -> char - '0' + 52
        '-' -> 62
        else -> 63
      }
      buffer = (buffer shl 6) or digit
      bits += 6
      if (bits >= 8) {
        bits -= 8
        out.write((buffer shr bits) and 0xff)
      }
    }
    return out.toByteArray()
  }
}
