package expo.modules.sociopush

import java.math.BigInteger
import java.security.AlgorithmParameters
import java.security.KeyFactory
import java.security.KeyPairGenerator
import java.security.SecureRandom
import java.security.interfaces.ECPrivateKey
import java.security.interfaces.ECPublicKey
import java.security.spec.ECFieldFp
import java.security.spec.ECGenParameterSpec
import java.security.spec.ECParameterSpec
import java.security.spec.ECPoint
import java.security.spec.ECPrivateKeySpec
import java.security.spec.ECPublicKeySpec
import java.nio.ByteBuffer
import javax.crypto.Cipher
import javax.crypto.KeyAgreement
import javax.crypto.Mac
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec

/** One workspace's push keys, raw: never leaves native code except `publicKey` and `auth`. */
class PushKeys(
  /** The P-256 public key, uncompressed (65 bytes): the subscription's `p256dh`. */
  val publicKey: ByteArray,
  /** The private scalar (32 bytes). */
  val privateKey: ByteArray,
  /** The 16-byte auth secret: the subscription's `auth`. */
  val auth: ByteArray,
)

class PushDecryptException(message: String) : Exception(message)

// RFC 8291 aes128gcm, one record only, ported step by step from a
// TypeScript prototype (RFC 8291 3.3-3.4, RFC 8188 2) with plain java.security and
// javax.crypto, so it runs the same on the phone and in the JVM unit test.
// No Android class here.
object WebPushCrypto {
  private const val SALT = 16
  private const val HEADER_FIXED = SALT + 4 + 1 // salt, record size, keyid length
  private const val KEY = 65
  private const val TAG = 16

  private val p256: ECParameterSpec by lazy {
    val parameters = AlgorithmParameters.getInstance("EC")
    parameters.init(ECGenParameterSpec("secp256r1"))
    parameters.getParameterSpec(ECParameterSpec::class.java)
  }

  /** A new P-256 pair and auth secret, made in software: Keystore EC keys can't do ECDH before API 31. */
  fun generateKeys(random: SecureRandom = SecureRandom()): PushKeys {
    val generator = KeyPairGenerator.getInstance("EC")
    generator.initialize(ECGenParameterSpec("secp256r1"), random)
    val pair = generator.generateKeyPair()
    val public = (pair.public as ECPublicKey).w
    val auth = ByteArray(16).also(random::nextBytes)
    return PushKeys(
      publicKey = byteArrayOf(4) + fixed(public.affineX) + fixed(public.affineY),
      privateKey = fixed((pair.private as ECPrivateKey).s),
      auth = auth,
    )
  }

  /** The plaintext of one aes128gcm body, or PushDecryptException. */
  fun decrypt(body: ByteArray, keys: PushKeys): ByteArray {
    if (body.size < HEADER_FIXED + KEY + TAG + 1) {
      throw PushDecryptException("too short")
    }
    val salt = body.copyOfRange(0, SALT)
    val recordSize = ByteBuffer.wrap(body, SALT, 4).int.toLong() and 0xffffffffL
    val idLength = body[SALT + 4].toInt() and 0xff
    if (idLength != KEY) {
      throw PushDecryptException("keyid is $idLength bytes, not an uncompressed P-256 key")
    }
    val asPublic = body.copyOfRange(HEADER_FIXED, HEADER_FIXED + KEY)
    val record = body.copyOfRange(HEADER_FIXED + KEY, body.size)
    // One record only: web-push sends one, and a push fits one (rs 4096).
    if (record.size > recordSize) {
      throw PushDecryptException("more than one record")
    }

    val ecdhSecret = agree(keys.privateKey, asPublic)

    // RFC 8291 3.3: the auth secret and both public keys go into the IKM.
    val prkKey = hmac(keys.auth, ecdhSecret)
    val keyInfo = "WebPush: info\u0000".toByteArray(Charsets.US_ASCII) + keys.publicKey + asPublic
    val ikm = expand(prkKey, keyInfo, 32)

    // RFC 8188 2.2-2.3.
    val prk = hmac(salt, ikm)
    val cek = expand(prk, "Content-Encoding: aes128gcm\u0000".toByteArray(Charsets.US_ASCII), 16)
    val nonce = expand(prk, "Content-Encoding: nonce\u0000".toByteArray(Charsets.US_ASCII), 12)

    val padded =
      try {
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.DECRYPT_MODE, SecretKeySpec(cek, "AES"), GCMParameterSpec(TAG * 8, nonce))
        cipher.doFinal(record)
      } catch (error: java.security.GeneralSecurityException) {
        throw PushDecryptException("the record doesn't authenticate")
      }

    // RFC 8188 2: data, then a delimiter (2 for the last record), then zeros.
    var end = padded.size - 1
    while (end >= 0 && padded[end].toInt() == 0) {
      end -= 1
    }
    if (end < 0 || padded[end].toInt() != 2) {
      throw PushDecryptException("no last-record delimiter")
    }
    return padded.copyOfRange(0, end)
  }

  private fun agree(privateScalar: ByteArray, peer: ByteArray): ByteArray {
    val factory = KeyFactory.getInstance("EC")
    val private = factory.generatePrivate(ECPrivateKeySpec(BigInteger(1, privateScalar), p256))
    val public = factory.generatePublic(ECPublicKeySpec(point(peer), p256))
    val agreement = KeyAgreement.getInstance("ECDH")
    agreement.init(private)
    agreement.doPhase(public, true)
    return agreement.generateSecret()
  }

  // The sender's key, checked on the curve here rather than trusting each
  // provider to: a point off it would leak bits of the private key.
  private fun point(uncompressed: ByteArray): ECPoint {
    if (uncompressed.size != KEY || uncompressed[0].toInt() != 4) {
      throw PushDecryptException("the sender's key isn't an uncompressed P-256 point")
    }
    val x = BigInteger(1, uncompressed.copyOfRange(1, 33))
    val y = BigInteger(1, uncompressed.copyOfRange(33, KEY))
    val field = (p256.curve.field as ECFieldFp).p
    val onCurve =
      x < field && y < field &&
        y.modPow(BigInteger.valueOf(2), field) ==
        x.modPow(BigInteger.valueOf(3), field).add(p256.curve.a.multiply(x)).add(p256.curve.b).mod(field)
    if (!onCurve) {
      throw PushDecryptException("the sender's key isn't on P-256")
    }
    return ECPoint(x, y)
  }

  private fun hmac(key: ByteArray, data: ByteArray): ByteArray {
    val mac = Mac.getInstance("HmacSHA256")
    mac.init(SecretKeySpec(key, "HmacSHA256"))
    return mac.doFinal(data)
  }

  /** HKDF-Expand with one output block (L <= 32), as RFC 8291 and RFC 8188 use it. */
  private fun expand(prk: ByteArray, info: ByteArray, length: Int): ByteArray =
    hmac(prk, info + byteArrayOf(1)).copyOf(length)

  /** A coordinate or scalar as exactly 32 big-endian bytes. */
  private fun fixed(value: BigInteger): ByteArray {
    val bytes = value.toByteArray()
    return when {
      bytes.size == 32 -> bytes
      bytes.size > 32 -> bytes.copyOfRange(bytes.size - 32, bytes.size)
      else -> ByteArray(32 - bytes.size) + bytes
    }
  }
}
