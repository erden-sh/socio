import CryptoKit
import Foundation
import Security

// The push keys and what the notification service extension needs beside them
// (README.md): keychain items in the group
// the app shares with the extension, AfterFirstUnlockThisDeviceOnly, written
// with an explicit access group. Plain Swift with no Expo in it, so the
// extension compiles the same file and reads the keys the same way.
//
// Every item is a generic password of service `socio.push`, its account one of:
//
// - `key.<workspace>`: the P-256 private key (raw, 32 bytes) and the auth
//   secret (16 bytes), as JSON with base64url values;
// - `workspace.<workspace>`: `{ locked, leaseLockAt }`;
// - `registration.<relay registration id>`: `{ workspaceId, name }`, the index
//   the extension looks a push's registration up in;
// - `device`: `{ showText }`.
//
// Nothing else goes in the shared group.

public enum PushKeychainError: Error, Equatable {
  /// SecItem* failed with this status (errSecInteractionNotAllowed before the first unlock).
  case status(OSStatus)
  /// An item's value isn't what this file writes.
  case unreadable(String)
}

/// A workspace's flags for the extension.
public struct PushWorkspaceState: Codable, Equatable {
  /// The workspace's copy is locked (Ended or past the lease): notifications show generic text.
  public var locked: Bool
  /// When the lease locks the copy (last contact plus 30 days), in ms since the epoch; past it, generic text.
  public var leaseLockAt: Double?

  public init(locked: Bool = false, leaseLockAt: Double? = nil) {
    self.locked = locked
    self.leaseLockAt = leaseLockAt
  }
}

/// One registration with the relay, by the workspace it belongs to.
public struct PushRegistration: Codable, Equatable {
  public var workspaceId: String
  /// The workspace's name, for the subtitle when more than one workspace is signed in.
  public var name: String

  public init(workspaceId: String, name: String) {
    self.workspaceId = workspaceId
    self.name = name
  }
}

public struct PushDeviceSettings: Codable, Equatable {
  /// "Show message text in notifications", on by default.
  public var showText: Bool

  public init(showText: Bool = true) {
    self.showText = showText
  }
}

private struct StoredKey: Codable {
  /// The private key's raw representation (32 bytes), base64url.
  let d: String
  /// The auth secret (16 bytes), base64url.
  let auth: String
}

public final class PushKeychain {
  public static let service = "socio.push"

  /// The keychain group every item is written to and read from; nil leaves it to the
  /// keychain's default, the app's own group (Personal Team builds, which have no shared one).
  public let accessGroup: String?

  // SecItem calls are thread safe, but a read, change and write of one item isn't.
  private let lock = NSLock()

  public init(accessGroup: String?) {
    self.accessGroup = accessGroup
  }

  // MARK: Keys

  /// Makes a new key pair and auth secret for the workspace, replacing any it had.
  public func createKeys(workspaceId: String) throws -> WebPushKeys {
    var authSecret = Data(count: 16)
    let status = authSecret.withUnsafeMutableBytes { SecRandomCopyBytes(kSecRandomDefault, 16, $0.baseAddress!) }
    guard status == errSecSuccess else {
      throw PushKeychainError.status(status)
    }
    let keys = WebPushKeys(privateKey: P256.KeyAgreement.PrivateKey(), authSecret: authSecret)
    let stored = StoredKey(d: Base64URL.encode(keys.privateKey.rawRepresentation), auth: Base64URL.encode(authSecret))
    try locked { try write(account: Self.keyAccount(workspaceId), value: stored) }
    return keys
  }

  /// The workspace's keys, or nil when it has none.
  public func keys(workspaceId: String) throws -> WebPushKeys? {
    guard let stored: StoredKey = try locked({ try read(account: Self.keyAccount(workspaceId)) }) else {
      return nil
    }
    guard
      let raw = Base64URL.decode(stored.d),
      let authSecret = Base64URL.decode(stored.auth), authSecret.count == 16,
      let privateKey = try? P256.KeyAgreement.PrivateKey(rawRepresentation: raw)
    else {
      throw PushKeychainError.unreadable(Self.keyAccount(workspaceId))
    }
    return WebPushKeys(privateKey: privateKey, authSecret: authSecret)
  }

  /// Deletes the workspace's keys, its flags and every registration that points at it.
  public func deleteKeys(workspaceId: String) throws {
    try locked {
      try delete(account: Self.keyAccount(workspaceId))
      try delete(account: Self.workspaceAccount(workspaceId))
      for (account, registration) in try allRegistrations() where registration.workspaceId == workspaceId {
        try delete(account: account)
      }
    }
  }

  // MARK: Registrations

  public func setRegistration(_ registrationId: String, _ registration: PushRegistration) throws {
    try locked { try write(account: Self.registrationAccount(registrationId), value: registration) }
  }

  public func registration(_ registrationId: String) throws -> PushRegistration? {
    try locked { try read(account: Self.registrationAccount(registrationId)) }
  }

  public func deleteRegistration(_ registrationId: String) throws {
    try locked { try delete(account: Self.registrationAccount(registrationId)) }
  }

  /// Every registration, by relay registration id.
  public func registrations() throws -> [String: PushRegistration] {
    try locked {
      var byId: [String: PushRegistration] = [:]
      for (account, registration) in try allRegistrations() {
        byId[String(account.dropFirst(Self.registrationPrefix.count))] = registration
      }
      return byId
    }
  }

  // MARK: Flags

  public func state(workspaceId: String) throws -> PushWorkspaceState {
    try locked { try read(account: Self.workspaceAccount(workspaceId)) ?? PushWorkspaceState() }
  }

  public func updateState(workspaceId: String, _ change: (inout PushWorkspaceState) -> Void) throws {
    try locked {
      let account = Self.workspaceAccount(workspaceId)
      var state: PushWorkspaceState = try read(account: account) ?? PushWorkspaceState()
      change(&state)
      try write(account: account, value: state)
    }
  }

  public func deviceSettings() throws -> PushDeviceSettings {
    try locked { try read(account: Self.deviceAccount) ?? PushDeviceSettings() }
  }

  public func setShowText(_ showText: Bool) throws {
    try locked { try write(account: Self.deviceAccount, value: PushDeviceSettings(showText: showText)) }
  }

  // MARK: Items

  static let keyPrefix = "key."
  static let workspacePrefix = "workspace."
  static let registrationPrefix = "registration."
  static let deviceAccount = "device"

  static func keyAccount(_ workspaceId: String) -> String { keyPrefix + workspaceId }
  static func workspaceAccount(_ workspaceId: String) -> String { workspacePrefix + workspaceId }
  static func registrationAccount(_ registrationId: String) -> String { registrationPrefix + registrationId }

  private func locked<T>(_ work: () throws -> T) rethrows -> T {
    lock.lock()
    defer { lock.unlock() }
    return try work()
  }

  private func baseQuery(account: String?) -> [String: Any] {
    var query: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: Self.service,
    ]
    if let account {
      query[kSecAttrAccount as String] = account
    }
    if let accessGroup {
      query[kSecAttrAccessGroup as String] = accessGroup
    }
    return query
  }

  private func read<T: Decodable>(account: String) throws -> T? {
    var query = baseQuery(account: account)
    query[kSecReturnData as String] = true
    query[kSecMatchLimit as String] = kSecMatchLimitOne
    var result: CFTypeRef?
    let status = SecItemCopyMatching(query as CFDictionary, &result)
    if status == errSecItemNotFound {
      return nil
    }
    guard status == errSecSuccess, let data = result as? Data else {
      throw PushKeychainError.status(status)
    }
    guard let value = try? JSONDecoder().decode(T.self, from: data) else {
      throw PushKeychainError.unreadable(account)
    }
    return value
  }

  private func write<T: Encodable>(account: String, value: T) throws {
    let data = try JSONEncoder().encode(value)
    let query = baseQuery(account: account)
    let attributes: [String: Any] = [
      kSecValueData as String: data,
      kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
    ]
    var status = SecItemUpdate(query as CFDictionary, attributes as CFDictionary)
    if status == errSecItemNotFound {
      status = SecItemAdd(query.merging(attributes) { _, new in new } as CFDictionary, nil)
    }
    guard status == errSecSuccess else {
      throw PushKeychainError.status(status)
    }
  }

  private func delete(account: String) throws {
    let status = SecItemDelete(baseQuery(account: account) as CFDictionary)
    guard status == errSecSuccess || status == errSecItemNotFound else {
      throw PushKeychainError.status(status)
    }
  }

  /// Every `registration.` item, by account. One that doesn't read is skipped: it names no workspace.
  private func allRegistrations() throws -> [(String, PushRegistration)] {
    var query = baseQuery(account: nil)
    query[kSecReturnAttributes as String] = true
    query[kSecReturnData as String] = true
    query[kSecMatchLimit as String] = kSecMatchLimitAll
    var result: CFTypeRef?
    let status = SecItemCopyMatching(query as CFDictionary, &result)
    if status == errSecItemNotFound {
      return []
    }
    guard status == errSecSuccess, let items = result as? [[String: Any]] else {
      throw PushKeychainError.status(status)
    }
    return items.compactMap { item in
      guard
        let account = item[kSecAttrAccount as String] as? String,
        account.hasPrefix(Self.registrationPrefix),
        let data = item[kSecValueData as String] as? Data,
        let registration = try? JSONDecoder().decode(PushRegistration.self, from: data)
      else {
        return nil
      }
      return (account, registration)
    }
  }

  // MARK: Groups

  /// The app's own keychain group, as the keychain fills it in for an item written with none: the
  /// first of the entitlement's `keychain-access-groups` (or the application identifier when there
  /// are none). A probe item is written, read back and deleted.
  public static func defaultAccessGroup() throws -> String {
    let query: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: "socio.push.probe",
      kSecAttrAccount as String: "probe",
    ]
    var add = query
    add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
    add[kSecReturnAttributes as String] = true
    var result: CFTypeRef?
    var status = SecItemAdd(add as CFDictionary, &result)
    if status == errSecDuplicateItem {
      var read = query
      read[kSecReturnAttributes as String] = true
      read[kSecMatchLimit as String] = kSecMatchLimitOne
      status = SecItemCopyMatching(read as CFDictionary, &result)
    }
    SecItemDelete(query as CFDictionary)
    guard status == errSecSuccess,
      let attributes = result as? [String: Any],
      let group = attributes[kSecAttrAccessGroup as String] as? String
    else {
      throw PushKeychainError.status(status)
    }
    return group
  }
}
