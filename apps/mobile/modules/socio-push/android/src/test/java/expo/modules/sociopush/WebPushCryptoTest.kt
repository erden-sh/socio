package expo.modules.sociopush

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Test
import java.util.Base64

// The decryptor against ../vectors.json, which iOS's XCTest reads too: RFC
// 8291 Appendix A, a web-push 3.6.7 body and web-push's two records.
class WebPushCryptoTest {
  private val vectors: JSONObject by lazy {
    JSONObject(java.io.File(System.getProperty("socioPush.vectors")!!).readText())
  }

  private fun bytes(value: String): ByteArray = Base64.getUrlDecoder().decode(value)

  private fun keys(vector: JSONObject) = PushKeys(
    publicKey = bytes(vector.getString("uaPublic")),
    privateKey = bytes(vector.getString("uaPrivate")),
    auth = bytes(vector.getString("authSecret")),
  )

  private val rfc get() = vectors.getJSONObject("rfc8291")
  private val webPush get() = vectors.getJSONObject("webPush367")

  @Test
  fun decryptsRfc8291AppendixA() {
    val plain = WebPushCrypto.decrypt(bytes(rfc.getString("message")), keys(rfc))
    assertEquals(rfc.getString("plaintext"), String(plain, Charsets.UTF_8))
  }

  @Test
  fun decryptsWebPush367() {
    val plain = WebPushCrypto.decrypt(bytes(webPush.getString("body")), keys(webPush))
    assertEquals(webPush.getString("plaintext"), String(plain, Charsets.UTF_8))
  }

  @Test
  fun refusesAFlippedByteAnywhereInTheRecord() {
    val body = bytes(rfc.getString("message"))
    // Header (salt, the sender's key) and record alike: every flip fails.
    for (index in listOf(0, 15, 30, 90, body.size / 2 + 40, body.size - 1)) {
      val flipped = body.copyOf().also { it[index] = (it[index].toInt() xor 1).toByte() }
      assertThrows(PushDecryptException::class.java) { WebPushCrypto.decrypt(flipped, keys(rfc)) }
    }
  }

  @Test
  fun refusesWebPushsTwoRecords() {
    val vector = vectors.getJSONObject("twoRecords")
    val error = assertThrows(PushDecryptException::class.java) {
      WebPushCrypto.decrypt(bytes(vector.getString("body")), keys(vector))
    }
    assertEquals("more than one record", error.message)
  }

  @Test
  fun refusesARecordSizeBelowTheRecord() {
    // The same body with its record size cut below the record's length: a
    // second record would follow, which a push never carries.
    val body = bytes(rfc.getString("message")).copyOf()
    body[16] = 0; body[17] = 0; body[18] = 0; body[19] = 32
    val error = assertThrows(PushDecryptException::class.java) { WebPushCrypto.decrypt(body, keys(rfc)) }
    assertEquals("more than one record", error.message)
  }

  @Test
  fun refusesTheWrongKeysOrAuth() {
    val body = bytes(rfc.getString("message"))
    val good = keys(rfc)
    val wrongAuth = PushKeys(good.publicKey, good.privateKey, ByteArray(16))
    assertThrows(PushDecryptException::class.java) { WebPushCrypto.decrypt(body, wrongAuth) }
    val other = WebPushCrypto.generateKeys()
    assertThrows(PushDecryptException::class.java) { WebPushCrypto.decrypt(body, other) }
  }

  @Test
  fun refusesASenderKeyOffTheCurve() {
    val body = bytes(rfc.getString("message")).copyOf()
    body[21 + 64] = (body[21 + 64].toInt() xor 1).toByte() // the key's last byte: y no longer fits x
    val error = assertThrows(PushDecryptException::class.java) { WebPushCrypto.decrypt(body, keys(rfc)) }
    assertEquals("the sender's key isn't on P-256", error.message)
  }

  @Test
  fun refusesTooShort() {
    assertThrows(PushDecryptException::class.java) { WebPushCrypto.decrypt(ByteArray(100), keys(rfc)) }
  }

  @Test
  fun generatesKeysOfTheRightShape() {
    val keys = WebPushCrypto.generateKeys()
    assertEquals(65, keys.publicKey.size)
    assertEquals(4, keys.publicKey[0].toInt())
    assertEquals(32, keys.privateKey.size)
    assertEquals(16, keys.auth.size)
  }
}
