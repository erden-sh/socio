import CryptoKit
import Foundation

// The Web Push decryptor: RFC 8291's
// aes128gcm, one record only, ported step by step from a TypeScript prototype
// (written from RFC 8291 3.3-3.4 and RFC 8188 2, not from Mastodon's code).
// Plain Swift with no Expo in it, so the app's module and the notification
// service extension compile the same file. Tests/ checks it against
// ../../vectors.json.

public enum WebPushError: Error, Equatable {
  /// Shorter than a header, one key, a tag and a delimiter.
  case tooShort
  /// The key id isn't an uncompressed P-256 key (65 bytes).
  case badKeyId(Int)
  /// The record size is under RFC 8188's minimum of 18.
  case badRecordSize(UInt32)
  /// The body holds more than one record. A push fits one; web-push splits only larger plaintexts.
  case moreThanOneRecord
  /// The sender's key isn't a point on P-256.
  case badSenderKey
  /// AES-GCM refused the record: wrong keys, or a changed byte.
  case unauthentic
  /// The record doesn't end with the last-record delimiter (2) and zeros.
  case noDelimiter
}

/// A subscription's keys: the private half never leaves native code.
public struct WebPushKeys {
  public let privateKey: P256.KeyAgreement.PrivateKey
  /// `auth`, 16 bytes.
  public let authSecret: Data

  public init(privateKey: P256.KeyAgreement.PrivateKey, authSecret: Data) {
    self.privateKey = privateKey
    self.authSecret = authSecret
  }

  /// `p256dh`: the public key, uncompressed (65 bytes).
  public var publicKey: Data { privateKey.publicKey.x963Representation }
}

/// Every intermediate value, so the tests can match RFC 8291 Appendix A step by step.
public struct WebPushSteps {
  public let salt: Data
  public let recordSize: UInt32
  public let senderPublicKey: Data
  public let ecdhSecret: Data
  public let prkKey: Data
  public let keyInfo: Data
  public let ikm: Data
  public let prk: Data
  public let cek: Data
  public let nonce: Data
  public let plaintext: Data
}

public enum WebPushDecryptor {
  static let saltLength = 16
  /// Salt, record size, key id length.
  static let headerFixed = 16 + 4 + 1
  static let keyLength = 65
  static let tagLength = 16

  /// The plaintext of an aes128gcm body.
  public static func decrypt(_ body: Data, keys: WebPushKeys) throws -> Data {
    try steps(body, keys: keys).plaintext
  }

  public static func steps(_ body: Data, keys: WebPushKeys) throws -> WebPushSteps {
    let bytes = [UInt8](body)
    guard bytes.count >= headerFixed + keyLength + tagLength + 1 else {
      throw WebPushError.tooShort
    }
    let salt = Data(bytes[0..<saltLength])
    let recordSize = bytes[16..<20].reduce(UInt32(0)) { ($0 << 8) | UInt32($1) }
    guard recordSize >= 18 else {
      throw WebPushError.badRecordSize(recordSize)
    }
    let idLength = Int(bytes[20])
    guard idLength == keyLength else {
      throw WebPushError.badKeyId(idLength)
    }
    let senderPublicKey = Data(bytes[headerFixed..<(headerFixed + keyLength)])
    let record = Data(bytes[(headerFixed + keyLength)...])
    // One record only: web-push sends one, and a push fits one (rs 4096).
    guard record.count <= Int(recordSize) else {
      throw WebPushError.moreThanOneRecord
    }

    let sender: P256.KeyAgreement.PublicKey
    do {
      sender = try P256.KeyAgreement.PublicKey(x963Representation: senderPublicKey)
    } catch {
      throw WebPushError.badSenderKey
    }
    let shared = try keys.privateKey.sharedSecretFromKeyAgreement(with: sender)
    let ecdhSecret = shared.withUnsafeBytes { Data($0) }

    // RFC 8291 3.3: the auth secret and both public keys go into the IKM.
    let prkKey = hmac(key: keys.authSecret, data: ecdhSecret)
    let keyInfo = Data("WebPush: info\0".utf8) + keys.publicKey + senderPublicKey
    let ikm = expand(prk: prkKey, info: keyInfo, length: 32)

    // RFC 8188 2.2-2.3.
    let prk = hmac(key: salt, data: ikm)
    let cek = expand(prk: prk, info: Data("Content-Encoding: aes128gcm\0".utf8), length: 16)
    let nonce = expand(prk: prk, info: Data("Content-Encoding: nonce\0".utf8), length: 12)

    let padded: Data
    do {
      let box = try AES.GCM.SealedBox(
        nonce: AES.GCM.Nonce(data: nonce),
        ciphertext: record.prefix(record.count - tagLength),
        tag: record.suffix(tagLength))
      padded = try AES.GCM.open(box, using: SymmetricKey(data: cek))
    } catch {
      throw WebPushError.unauthentic
    }

    // RFC 8188 2: data, then a delimiter (2 for the last record), then zeros.
    let plain = [UInt8](padded)
    var end = plain.count - 1
    while end >= 0 && plain[end] == 0 {
      end -= 1
    }
    guard end >= 0, plain[end] == 2 else {
      throw WebPushError.noDelimiter
    }
    return WebPushSteps(
      salt: salt, recordSize: recordSize, senderPublicKey: senderPublicKey, ecdhSecret: ecdhSecret,
      prkKey: prkKey, keyInfo: keyInfo, ikm: ikm, prk: prk, cek: cek, nonce: nonce,
      plaintext: Data(plain[0..<end]))
  }

  private static func hmac(key: Data, data: Data) -> Data {
    Data(HMAC<SHA256>.authenticationCode(for: data, using: SymmetricKey(data: key)))
  }

  /// HKDF-Expand with one output block (length 32 or less), as RFC 8291 and RFC 8188 use it.
  private static func expand(prk: Data, info: Data, length: Int) -> Data {
    hmac(key: prk, data: info + Data([1])).prefix(length)
  }
}

/// Base64url without padding, as Web Push writes `p256dh`, `auth` and the relay's `p`.
public enum Base64URL {
  public static func encode(_ data: Data) -> String {
    data.base64EncodedString()
      .replacingOccurrences(of: "+", with: "-")
      .replacingOccurrences(of: "/", with: "_")
      .replacingOccurrences(of: "=", with: "")
  }

  /// nil for anything that isn't base64url (padding is accepted).
  public static func decode(_ text: String) -> Data? {
    var base64 = text.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
    if base64.contains("=") {
      base64 = String(base64.prefix { $0 != "=" })
    }
    let remainder = base64.count % 4
    if remainder == 1 {
      return nil
    }
    if remainder > 0 {
      base64 += String(repeating: "=", count: 4 - remainder)
    }
    return Data(base64Encoded: base64)
  }
}
