package expo.modules.sociopush

import java.math.BigInteger
import java.nio.ByteBuffer
import java.security.AlgorithmParameters
import java.security.KeyFactory
import java.security.KeyPairGenerator
import java.security.SecureRandom
import java.security.interfaces.ECPublicKey
import java.security.spec.ECGenParameterSpec
import java.security.spec.ECParameterSpec
import java.security.spec.ECPoint
import java.security.spec.ECPublicKeySpec
import java.util.Base64
import javax.crypto.Cipher
import javax.crypto.KeyAgreement
import javax.crypto.Mac
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec
import org.json.JSONObject

/** RFC 8291 aes128gcm encryption, as the server's web-push does it: the tests' sender. */
object TestPushes {
  private val p256: ECParameterSpec by lazy {
    AlgorithmParameters.getInstance("EC").run {
      init(ECGenParameterSpec("secp256r1"))
      getParameterSpec(ECParameterSpec::class.java)
    }
  }

  fun encrypt(plaintext: ByteArray, keys: PushKeys): ByteArray {
    val generator = KeyPairGenerator.getInstance("EC").apply { initialize(ECGenParameterSpec("secp256r1")) }
    val sender = generator.generateKeyPair()
    val w = (sender.public as ECPublicKey).w
    val asPublic = byteArrayOf(4) + fixed(w.affineX) + fixed(w.affineY)
    val ua = keys.publicKey
    val peer = KeyFactory.getInstance("EC").generatePublic(
      ECPublicKeySpec(ECPoint(BigInteger(1, ua.copyOfRange(1, 33)), BigInteger(1, ua.copyOfRange(33, 65))), p256),
    )
    val ecdh = KeyAgreement.getInstance("ECDH").run {
      init(sender.private)
      doPhase(peer, true)
      generateSecret()
    }
    val ikm = hmac(hmac(keys.auth, ecdh), "WebPush: info\u0000".toByteArray() + ua + asPublic + byteArrayOf(1)).copyOf(32)
    val salt = ByteArray(16).also(SecureRandom()::nextBytes)
    val prk = hmac(salt, ikm)
    val cek = hmac(prk, "Content-Encoding: aes128gcm\u0000".toByteArray() + byteArrayOf(1)).copyOf(16)
    val nonce = hmac(prk, "Content-Encoding: nonce\u0000".toByteArray() + byteArrayOf(1)).copyOf(12)
    val cipher = Cipher.getInstance("AES/GCM/NoPadding")
    cipher.init(Cipher.ENCRYPT_MODE, SecretKeySpec(cek, "AES"), GCMParameterSpec(128, nonce))
    val record = cipher.doFinal(plaintext + byteArrayOf(2))
    return salt + ByteBuffer.allocate(4).putInt(4096).array() + byteArrayOf(65) + asPublic + record
  }

  fun base64url(bytes: ByteArray): String = Base64.getUrlEncoder().withoutPadding().encodeToString(bytes)

  fun payload(
    title: String = "Bo in Launch",
    body: String = "@Ana can you look?",
    link: String = "/chats/room-1",
    tag: String? = "room-1",
    kind: String = "message",
    extra: Map<String, String> = emptyMap(),
  ): ByteArray {
    val json = JSONObject().put("kind", kind).put("title", title).put("body", body).put("link", link)
    if (tag != null) json.put("tag", tag)
    extra.forEach { (key, value) -> json.put(key, value) }
    return json.toString().toByteArray()
  }

  private fun hmac(key: ByteArray, data: ByteArray): ByteArray =
    Mac.getInstance("HmacSHA256").run {
      init(SecretKeySpec(key, "HmacSHA256"))
      doFinal(data)
    }

  private fun fixed(value: BigInteger): ByteArray {
    val bytes = value.toByteArray()
    return when {
      bytes.size == 32 -> bytes
      bytes.size > 32 -> bytes.copyOfRange(bytes.size - 32, bytes.size)
      else -> ByteArray(32 - bytes.size) + bytes
    }
  }
}

/** PushStore's part the service uses, in memory, with real keys and the real decryptor. */
class FakeSource : PushSource {
  val keys = mutableMapOf<String, PushKeys>()
  val registrations = mutableMapOf<String, PushRegistration>()
  val flags = mutableMapOf<String, WorkspaceFlags>()
  var show = true
  val seen = mutableListOf<String>()
  val taps = mutableMapOf<String, PushTarget>()
  val inbox = mutableListOf<PushTarget>()
  val decrypted = mutableListOf<String>()

  fun register(registrationId: String, workspaceId: String, name: String): PushKeys {
    val made = WebPushCrypto.generateKeys()
    keys[workspaceId] = made
    registrations[registrationId] = PushRegistration(workspaceId, name)
    return made
  }

  /** The relay's FCM data for this plaintext, encrypted to the registration's workspace. */
  fun push(registrationId: String, plaintext: ByteArray = TestPushes.payload()): Map<String, String> {
    val workspace = registrations.getValue(registrationId).workspaceId
    return mapOf("s" to registrationId, "p" to TestPushes.base64url(TestPushes.encrypt(plaintext, keys.getValue(workspace))))
  }

  override fun registration(registrationId: String) = registrations[registrationId]
  override fun registeredWorkspaces() = registrations.values.map { it.workspaceId }.toSet()
  override fun flags(workspaceId: String) = flags[workspaceId] ?: WorkspaceFlags(false, null)
  override fun showText() = show

  override fun decrypt(workspaceId: String, body: ByteArray): ByteArray {
    decrypted += workspaceId
    val found = keys[workspaceId] ?: throw PushDecryptException(PushMessages.NO_KEYS)
    return WebPushCrypto.decrypt(body, found)
  }

  override fun markSeen(id: String): Boolean {
    if (id in seen) return false
    seen += id
    while (seen.size > 64) seen.removeAt(0)
    return true
  }

  override fun putTap(target: PushTarget): String =
    java.util.UUID.randomUUID().toString().also { taps[it] = target }

  override fun takeTap(token: String) = taps.remove(token)

  override fun writeInbox(workspaceId: String, link: String, tag: String?, receivedAt: Long): String {
    inbox += PushTarget(workspaceId, link, tag)
    return java.util.UUID.randomUUID().toString()
  }
}
