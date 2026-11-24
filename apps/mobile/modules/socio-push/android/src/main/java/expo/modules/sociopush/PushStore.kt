package expo.modules.sociopush

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import org.json.JSONException
import org.json.JSONObject
import java.io.File
import java.security.GeneralSecurityException
import java.security.KeyStore
import java.util.UUID
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/** A workspace's flags: its copy is locked, and when its lease locks it (ms since the epoch). */
data class WorkspaceFlags(val locked: Boolean, val leaseLockAt: Double?)

/** What a relay registration (a push's `s`) points at. */
data class PushRegistration(val workspaceId: String, val name: String)

/** One inbox file: its id (a UUID) and its text, unparsed. */
data class InboxFile(val id: String, val json: String)

class PushStoreException(message: String) : Exception(message)

/**
 * The push keys, flags, registrations and inbox on Android (../../README.md).
 * Everything is in no-backup storage (Context.getNoBackupFilesDir), which
 * neither cloud backup nor device transfer copies, and each workspace's raw
 * keys are sealed by an AES key in the Android Keystore, which never leaves it.
 * One instance per process serves the module and the messaging service
 * (PushNotifier); every call runs under its lock.
 */
class PushStore private constructor(context: Context) : PushSource {
  private val root = File(context.noBackupFilesDir, "socio-push")
  private val keysDir = File(root, "keys")
  private val inboxDir = File(root, "inbox")
  private val stateFile = File(root, "state.json")
  private val lock = Any()

  companion object {
    private const val WRAP_ALIAS = "socio.push.wrap"
    private const val KEYSTORE = "AndroidKeyStore"
    private const val FORMAT: Byte = 1
    private const val IV = 12
    private const val SEALED = 1 + 65 + 32 + 16
    // The wrapper's id rule (src/push.ts): ids name files here.
    private val ID = Regex("^[A-Za-z0-9_-]{1,128}$")
    // The service's memory of pushes it handled, to drop retries, and of the
    // notifications' tap targets (PushNotifier).
    private const val SEEN_MAX = 64
    private const val TAPS_MAX = 64

    @Volatile private var shared: PushStore? = null

    fun get(context: Context): PushStore =
      shared ?: synchronized(this) { shared ?: PushStore(context.applicationContext).also { shared = it } }

    fun checkId(kind: String, id: String): String {
      if (!ID.matches(id)) throw PushStoreException("Not a $kind id")
      return id
    }
  }

  // --- Keys --------------------------------------------------------------

  /** A new pair and auth secret for the workspace, replacing any it had. */
  fun createKeys(workspaceId: String): PushKeys = synchronized(lock) {
    val keys = WebPushCrypto.generateKeys()
    writeKeys(checkId("workspace", workspaceId), keys)
    keys
  }

  /** The workspace's keys, or null when it has none or they no longer unwrap (the Keystore key gone). */
  fun keys(workspaceId: String): PushKeys? = synchronized(lock) {
    val file = keyFile(workspaceId)
    if (!file.exists()) return null
    val blob = file.readBytes()
    if (blob.size < IV + SEALED) return null
    val wrap = wrapKey(create = false) ?: return null
    val plain =
      try {
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.DECRYPT_MODE, wrap, GCMParameterSpec(128, blob, 0, IV))
        cipher.updateAAD(workspaceId.toByteArray(Charsets.US_ASCII))
        cipher.doFinal(blob, IV, blob.size - IV)
      } catch (error: GeneralSecurityException) {
        return null
      }
    try {
      if (plain.size != SEALED || plain[0] != FORMAT) return null
      PushKeys(
        publicKey = plain.copyOfRange(1, 66),
        privateKey = plain.copyOfRange(66, 98),
        auth = plain.copyOfRange(98, SEALED),
      )
    } finally {
      plain.fill(0)
    }
  }

  /** Deletes the workspace's keys, its flags and lease deadline, and every registration that points at it. */
  fun deleteKeys(workspaceId: String) = synchronized(lock) {
    val file = keyFile(workspaceId)
    if (file.exists() && !file.delete()) throw PushStoreException("Couldn't delete the workspace's keys")
    val state = readState()
    state.optJSONObject("workspaces")?.remove(workspaceId)
    val registrations = state.optJSONObject("registrations")
    if (registrations != null) {
      val gone = registrations.keys().asSequence().filter {
        registrations.optJSONObject(it)?.optString("workspaceId") == workspaceId
      }.toList()
      gone.forEach { registrations.remove(it) }
    }
    writeState(state)
  }

  /** The plaintext of a push for the workspace, or PushDecryptException (no keys, or it doesn't decrypt). */
  override fun decrypt(workspaceId: String, body: ByteArray): ByteArray {
    val keys = keys(workspaceId) ?: throw PushDecryptException(PushMessages.NO_KEYS)
    return try {
      WebPushCrypto.decrypt(body, keys)
    } finally {
      keys.privateKey.fill(0)
    }
  }

  private fun keyFile(workspaceId: String) = File(keysDir, "${checkId("workspace", workspaceId)}.key")

  private fun writeKeys(workspaceId: String, keys: PushKeys) {
    val plain = byteArrayOf(FORMAT) + keys.publicKey + keys.privateKey + keys.auth
    try {
      val cipher = Cipher.getInstance("AES/GCM/NoPadding")
      cipher.init(Cipher.ENCRYPT_MODE, wrapKey(create = true))
      cipher.updateAAD(workspaceId.toByteArray(Charsets.US_ASCII))
      val sealed = cipher.doFinal(plain)
      val iv = cipher.iv
      if (iv.size != IV) throw PushStoreException("Unexpected IV length")
      writeAtomically(keyFile(workspaceId), iv + sealed)
    } finally {
      plain.fill(0)
    }
  }

  // The wrapping key: AES-256-GCM in the Keystore (hardware-backed where the
  // phone has it), usable while the phone is locked so a push can decrypt,
  // never exportable. Without it, every sealed key is unreadable.
  private fun wrapKey(create: Boolean): SecretKey? {
    val store = KeyStore.getInstance(KEYSTORE).apply { load(null) }
    (store.getKey(WRAP_ALIAS, null) as? SecretKey)?.let { return it }
    if (!create) return null
    val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, KEYSTORE)
    generator.init(
      KeyGenParameterSpec.Builder(WRAP_ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
        .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
        .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
        .setKeySize(256)
        .build(),
    )
    return generator.generateKey()
  }

  // --- Registrations -----------------------------------------------------

  fun setRegistration(registrationId: String, registration: PushRegistration) = synchronized(lock) {
    checkId("registration", registrationId)
    checkId("workspace", registration.workspaceId)
    val state = readState()
    child(state, "registrations").put(
      registrationId,
      JSONObject().put("workspaceId", registration.workspaceId).put("name", registration.name),
    )
    writeState(state)
  }

  override fun registration(registrationId: String): PushRegistration? = synchronized(lock) {
    val entry = readState().optJSONObject("registrations")?.optJSONObject(checkId("registration", registrationId))
      ?: return null
    val workspaceId = entry.optString("workspaceId")
    if (!ID.matches(workspaceId)) null else PushRegistration(workspaceId, entry.optString("name"))
  }

  /** The workspaces that have a registration: more than one puts the workspace's name on each notification. */
  override fun registeredWorkspaces(): Set<String> = synchronized(lock) {
    val registrations = readState().optJSONObject("registrations") ?: return emptySet()
    registrations.keys().asSequence()
      .mapNotNull { registrations.optJSONObject(it)?.optString("workspaceId") }
      .filter { ID.matches(it) }
      .toSet()
  }

  fun deleteRegistration(registrationId: String) = synchronized(lock) {
    val state = readState()
    state.optJSONObject("registrations")?.remove(checkId("registration", registrationId))
    writeState(state)
  }

  // --- Flags -------------------------------------------------------------

  override fun flags(workspaceId: String): WorkspaceFlags = synchronized(lock) {
    val entry = readState().optJSONObject("workspaces")?.optJSONObject(checkId("workspace", workspaceId))
    WorkspaceFlags(
      locked = entry?.optBoolean("locked", false) ?: false,
      leaseLockAt = if (entry == null || entry.isNull("leaseLockAt")) null else entry.optDouble("leaseLockAt"),
    )
  }

  fun setLocked(workspaceId: String, locked: Boolean) = updateFlags(workspaceId) { it.put("locked", locked) }

  fun setLeaseLockAt(workspaceId: String, at: Double?) =
    updateFlags(workspaceId) { it.put("leaseLockAt", at ?: JSONObject.NULL) }

  /** The device's show-text setting, on until set. */
  override fun showText(): Boolean = synchronized(lock) { readState().optBoolean("showText", true) }

  fun setShowText(show: Boolean) = synchronized(lock) { writeState(readState().put("showText", show)) }

  private fun updateFlags(workspaceId: String, change: (JSONObject) -> Unit) = synchronized(lock) {
    checkId("workspace", workspaceId)
    val state = readState()
    val workspaces = child(state, "workspaces")
    val entry = workspaces.optJSONObject(workspaceId) ?: JSONObject().also { workspaces.put(workspaceId, it) }
    change(entry)
    writeState(state)
  }

  private fun child(state: JSONObject, name: String): JSONObject =
    state.optJSONObject(name) ?: JSONObject().also { state.put(name, it) }

  // A state file that doesn't read starts over empty: it holds flags and an
  // index the app writes again, never a key.
  private fun readState(): JSONObject =
    try {
      if (stateFile.exists()) JSONObject(stateFile.readText()) else JSONObject().put("v", 1)
    } catch (error: JSONException) {
      JSONObject().put("v", 1)
    }

  private fun writeState(state: JSONObject) = writeAtomically(stateFile, state.toString().toByteArray())

  // --- The service's memory ---------------------------------------------

  /**
   * Records a push's id (PushMessages.dedupeId) among the last 64, oldest
   * dropped first. False when it was already there: a retry, to drop.
   */
  override fun markSeen(id: String): Boolean = synchronized(lock) {
    val state = readState()
    val seen = state.optJSONArray("seen") ?: org.json.JSONArray()
    val ids = (0 until seen.length()).map { seen.optString(it) }
    if (id in ids) return false
    state.put("seen", org.json.JSONArray(ids.takeLast(SEEN_MAX - 1) + id))
    writeState(state)
    true
  }

  /**
   * Keeps a notification's tap target under a new random token, the only
   * thing its intent carries, so another app can't send the launcher a
   * target of its own. The last 64 are kept.
   */
  override fun putTap(target: PushTarget): String = synchronized(lock) {
    val token = UUID.randomUUID().toString()
    val state = readState()
    val taps = state.optJSONArray("taps") ?: org.json.JSONArray()
    val kept = (0 until taps.length()).mapNotNull { taps.optJSONObject(it) }.takeLast(TAPS_MAX - 1)
    val entry = JSONObject()
      .put("token", token)
      .put("workspaceId", checkId("workspace", target.workspaceId))
      .put("link", target.link)
      .put("tag", target.tag ?: JSONObject.NULL)
    state.put("taps", org.json.JSONArray(kept + entry))
    writeState(state)
    token
  }

  /** The target kept under this token, removed: a tap is handled once. Null for a token it doesn't know. */
  override fun takeTap(token: String): PushTarget? = synchronized(lock) {
    val state = readState()
    val taps = state.optJSONArray("taps") ?: return null
    val entries = (0 until taps.length()).mapNotNull { taps.optJSONObject(it) }
    val entry = entries.firstOrNull { it.optString("token") == token } ?: return null
    state.put("taps", org.json.JSONArray(entries.filter { it !== entry }))
    writeState(state)
    val workspaceId = entry.optString("workspaceId")
    val link = entry.optString("link")
    if (!ID.matches(workspaceId) || !link.startsWith("/")) return null
    PushTarget(workspaceId, link, if (entry.isNull("tag")) null else entry.optString("tag"))
  }

  // --- Inbox -------------------------------------------------------------

  /** Writes one inbox file under a fresh id (temporary name, then rename): where a push points, never what it said. */
  override fun writeInbox(workspaceId: String, link: String, tag: String?, receivedAt: Long): String {
    val entry = JSONObject()
      .put("workspaceId", checkId("workspace", workspaceId))
      .put("link", link)
      .put("tag", tag ?: JSONObject.NULL)
      .put("receivedAt", receivedAt)
    val id = UUID.randomUUID().toString()
    writeAtomically(File(inboxDir, "$id.json"), entry.toString().toByteArray())
    return id
  }

  /** Every inbox file, unparsed and oldest first: the wrapper parses them and deletes the unreadable ones. */
  fun listInbox(): List<InboxFile> = PushInbox.list(inboxDir)

  /** Deletes the inbox files with these ids; one already gone is fine. */
  fun deleteInbox(ids: List<String>) {
    for (id in ids) {
      if (!PushInbox.isId(id)) throw PushStoreException("Not an inbox file's id")
      val file = File(inboxDir, "$id.json")
      if (file.exists() && !file.delete()) throw PushStoreException("Couldn't delete an inbox file")
    }
  }

  private fun writeAtomically(target: File, bytes: ByteArray) {
    val parent = target.parentFile ?: throw PushStoreException("No folder for ${target.name}")
    parent.mkdirs()
    val temp = File(parent, ".${target.name}.${UUID.randomUUID()}.tmp")
    try {
      temp.outputStream().use { out ->
        out.write(bytes)
        out.fd.sync()
      }
      if (!temp.renameTo(target)) throw PushStoreException("Couldn't write ${target.name}")
    } finally {
      temp.delete()
    }
  }
}
