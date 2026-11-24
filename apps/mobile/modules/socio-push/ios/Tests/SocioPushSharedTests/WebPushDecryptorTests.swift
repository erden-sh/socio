import CryptoKit
import Foundation
import XCTest

@testable import SocioPushShared

// The decryptor against ../../../vectors.json (with a two-record body): RFC
// 8291 Appendix A step by step, web-push 3.6.7's output, and what it must
// refuse.
final class WebPushDecryptorTests: XCTestCase {
  private struct Vectors: Decodable {
    struct Rfc: Decodable {
      let plaintext, uaPublic, uaPrivate, authSecret, asPublic, salt, ecdhSecret, prkKey, keyInfo, ikm, prk,
        cek, nonce, message: String
    }
    struct WebPush: Decodable {
      let plaintext, uaPublic, uaPrivate, authSecret, body: String
    }
    struct TwoRecords: Decodable {
      let uaPublic, uaPrivate, authSecret, body: String
    }
    let rfc8291: Rfc
    let webPush367: WebPush
    let twoRecords: TwoRecords
  }

  private static let vectors: Vectors = {
    let url = URL(fileURLWithPath: #filePath)
      .deletingLastPathComponent()  // SocioPushSharedTests
      .deletingLastPathComponent()  // Tests
      .deletingLastPathComponent()  // ios
      .deletingLastPathComponent()  // socio-push
      .appendingPathComponent("vectors.json")
    return try! JSONDecoder().decode(Vectors.self, from: Data(contentsOf: url))
  }()

  private func b64(_ text: String) -> Data {
    guard let data = Base64URL.decode(text) else {
      XCTFail("not base64url: \(text)")
      return Data()
    }
    return data
  }

  private func keys(_ uaPrivate: String, _ authSecret: String, uaPublic: String? = nil) throws -> WebPushKeys {
    let keys = WebPushKeys(
      privateKey: try P256.KeyAgreement.PrivateKey(rawRepresentation: b64(uaPrivate)), authSecret: b64(authSecret))
    if let uaPublic {
      XCTAssertEqual(keys.publicKey, b64(uaPublic))
    }
    return keys
  }

  func testRfc8291AppendixA() throws {
    let a = Self.vectors.rfc8291
    let steps = try WebPushDecryptor.steps(b64(a.message), keys: keys(a.uaPrivate, a.authSecret, uaPublic: a.uaPublic))
    XCTAssertEqual(String(data: steps.plaintext, encoding: .utf8), a.plaintext)
    XCTAssertEqual(steps.salt, b64(a.salt))
    XCTAssertEqual(steps.recordSize, 4096)
    XCTAssertEqual(steps.senderPublicKey, b64(a.asPublic))
    XCTAssertEqual(steps.ecdhSecret, b64(a.ecdhSecret))
    XCTAssertEqual(steps.prkKey, b64(a.prkKey))
    XCTAssertEqual(steps.keyInfo, b64(a.keyInfo))
    XCTAssertEqual(steps.ikm, b64(a.ikm))
    XCTAssertEqual(steps.prk, b64(a.prk))
    XCTAssertEqual(steps.cek, b64(a.cek))
    XCTAssertEqual(steps.nonce, b64(a.nonce))
  }

  func testWebPush367() throws {
    let w = Self.vectors.webPush367
    let plaintext = try WebPushDecryptor.decrypt(b64(w.body), keys: keys(w.uaPrivate, w.authSecret, uaPublic: w.uaPublic))
    XCTAssertEqual(String(data: plaintext, encoding: .utf8), w.plaintext)
  }

  func testRefusesAFlippedByte() throws {
    let a = Self.vectors.rfc8291
    let k = try keys(a.uaPrivate, a.authSecret)
    var body = b64(a.message)
    body[body.count - 20] ^= 1
    XCTAssertThrowsError(try WebPushDecryptor.decrypt(body, keys: k)) {
      XCTAssertEqual($0 as? WebPushError, .unauthentic)
    }
    // In the sender's key, the header's key id: no longer a point, or another key.
    var header = b64(a.message)
    header[21 + 40] ^= 1
    XCTAssertThrowsError(try WebPushDecryptor.decrypt(header, keys: k))
  }

  func testRefusesWrongKeys() throws {
    let a = Self.vectors.rfc8291
    let wrongAuth = WebPushKeys(privateKey: try keys(a.uaPrivate, a.authSecret).privateKey, authSecret: Data(count: 16))
    XCTAssertThrowsError(try WebPushDecryptor.decrypt(b64(a.message), keys: wrongAuth)) {
      XCTAssertEqual($0 as? WebPushError, .unauthentic)
    }
    let other = WebPushKeys(privateKey: P256.KeyAgreement.PrivateKey(), authSecret: b64(a.authSecret))
    XCTAssertThrowsError(try WebPushDecryptor.decrypt(b64(a.message), keys: other)) {
      XCTAssertEqual($0 as? WebPushError, .unauthentic)
    }
  }

  func testRefusesTwoRecords() throws {
    let t = Self.vectors.twoRecords
    XCTAssertThrowsError(
      try WebPushDecryptor.decrypt(b64(t.body), keys: keys(t.uaPrivate, t.authSecret, uaPublic: t.uaPublic))
    ) {
      XCTAssertEqual($0 as? WebPushError, .moreThanOneRecord)
    }
  }

  func testRefusesMalformedHeaders() throws {
    let a = Self.vectors.rfc8291
    let k = try keys(a.uaPrivate, a.authSecret)
    let message = b64(a.message)
    XCTAssertThrowsError(try WebPushDecryptor.decrypt(message.prefix(100), keys: k)) {
      XCTAssertEqual($0 as? WebPushError, .tooShort)
    }
    var keyId = message
    keyId[20] = 33
    XCTAssertThrowsError(try WebPushDecryptor.decrypt(keyId, keys: k)) {
      XCTAssertEqual($0 as? WebPushError, .badKeyId(33))
    }
    var recordSize = message
    recordSize.replaceSubrange(16..<20, with: [0, 0, 0, 17])
    XCTAssertThrowsError(try WebPushDecryptor.decrypt(recordSize, keys: k)) {
      XCTAssertEqual($0 as? WebPushError, .badRecordSize(17))
    }
  }

  func testRefusesAMissingDelimiter() throws {
    // A record sealed by hand with the RFC's keys, its padding without the last-record delimiter.
    let a = Self.vectors.rfc8291
    let k = try keys(a.uaPrivate, a.authSecret)
    let steps = try WebPushDecryptor.steps(b64(a.message), keys: k)
    let sealed = try AES.GCM.seal(
      Data("no delimiter".utf8) + Data([1, 0]), using: SymmetricKey(data: steps.cek), nonce: AES.GCM.Nonce(data: steps.nonce))
    let body = b64(a.message).prefix(21 + 65) + sealed.ciphertext + sealed.tag
    XCTAssertThrowsError(try WebPushDecryptor.decrypt(Data(body), keys: k)) {
      XCTAssertEqual($0 as? WebPushError, .noDelimiter)
    }
  }

  func testBase64URL() {
    XCTAssertEqual(Base64URL.encode(Data([0xfb, 0xff, 0xfe])), "-__-")
    XCTAssertEqual(Base64URL.decode("-__-"), Data([0xfb, 0xff, 0xfe]))
    XCTAssertEqual(Base64URL.decode("AQ"), Data([1]))
    XCTAssertEqual(Base64URL.decode("AQ=="), Data([1]))
    XCTAssertNil(Base64URL.decode("A"))
    XCTAssertNil(Base64URL.decode("**"))
  }
}
