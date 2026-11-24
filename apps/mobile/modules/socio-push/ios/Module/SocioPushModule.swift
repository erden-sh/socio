import ExpoModulesCore
import Foundation

// socio-push on iOS (../../README.md): the Web Push keys, the flags the
// notification service extension reads, and the extension's inbox files. The
// work is in ../Shared, which the extension compiles too; this file only
// binds it for JavaScript.
public final class SocioPushModule: Module {
  public func definition() -> ModuleDefinition {
    Name("SocioPush")

    AsyncFunction("storage") { () -> [String: Any] in
      let groups = try PushGroups.resolve()
      return [
        "keychainGroup": groups.keychain ?? NSNull(),
        "shared": groups.shared,
        "inbox": PushInbox(appGroup: groups.app).directory != nil,
      ]
    }

    AsyncFunction("createKeys") { (workspaceId: String) -> [String: String] in
      let keys = try PushGroups.keychain().createKeys(workspaceId: workspaceId)
      return Self.publicKeys(keys)
    }

    AsyncFunction("getKeys") { (workspaceId: String) -> [String: String]? in
      try PushGroups.keychain().keys(workspaceId: workspaceId).map(Self.publicKeys)
    }

    AsyncFunction("deleteKeys") { (workspaceId: String) in
      try PushGroups.keychain().deleteKeys(workspaceId: workspaceId)
    }

    AsyncFunction("setRegistration") { (registrationId: String, workspaceId: String, name: String) in
      try PushGroups.keychain().setRegistration(
        registrationId, PushRegistration(workspaceId: workspaceId, name: name))
    }

    AsyncFunction("deleteRegistration") { (registrationId: String) in
      try PushGroups.keychain().deleteRegistration(registrationId)
    }

    AsyncFunction("getState") { (workspaceId: String) -> [String: Any] in
      let keychain = try PushGroups.keychain()
      let state = try keychain.state(workspaceId: workspaceId)
      return [
        "locked": state.locked,
        "leaseLockAt": state.leaseLockAt ?? NSNull(),
        "showText": try keychain.deviceSettings().showText,
      ]
    }

    AsyncFunction("setLocked") { (workspaceId: String, locked: Bool) in
      try PushGroups.keychain().updateState(workspaceId: workspaceId) { $0.locked = locked }
    }

    AsyncFunction("setLeaseLockAt") { (workspaceId: String, at: Double?) in
      try PushGroups.keychain().updateState(workspaceId: workspaceId) { $0.leaseLockAt = at }
    }

    AsyncFunction("setShowText") { (showText: Bool) in
      try PushGroups.keychain().setShowText(showText)
    }

    AsyncFunction("decrypt") { (workspaceId: String, body: String) -> String in
      guard let data = Base64URL.decode(body) else {
        throw DecryptException("the body isn't base64url")
      }
      guard let keys = try PushGroups.keychain().keys(workspaceId: workspaceId) else {
        throw DecryptException("the workspace has no push keys")
      }
      let plaintext: Data
      do {
        plaintext = try WebPushDecryptor.decrypt(data, keys: keys)
      } catch {
        throw DecryptException("\(error)")
      }
      guard let text = String(data: plaintext, encoding: .utf8) else {
        throw DecryptException("the plaintext isn't UTF-8")
      }
      return text
    }

    AsyncFunction("listInbox") { () -> [[String: String]] in
      try PushInbox(appGroup: PushGroups.resolve().app).list().map { ["id": $0.id, "json": $0.json] }
    }

    AsyncFunction("deleteInbox") { (ids: [String]) in
      try PushInbox(appGroup: PushGroups.resolve().app).delete(ids: ids)
    }
  }

  private static func publicKeys(_ keys: WebPushKeys) -> [String: String] {
    ["p256dh": Base64URL.encode(keys.publicKey), "auth": Base64URL.encode(keys.authSecret)]
  }
}

/// The groups this build shares with its extension, from the Info.plist keys plugins/push.ts writes
/// (Personal Team builds have neither, so the keys stay in the app's own group and there is no inbox).
enum PushGroups {
  struct Resolved {
    /// The keychain group the push items go to; nil is the keychain's default, the app's own.
    let keychain: String?
    /// Whether that is the group shared with the extension.
    let shared: Bool
    /// The app group whose container holds the inbox.
    let app: String?
  }

  static let keychainSuffixKey = "SocioPushKeychainGroupSuffix"
  static let appGroupKey = "SocioPushAppGroup"

  private static let lock = NSLock()
  private static var resolved: Resolved?

  /// Read once per launch: the app's own group comes from a probe item (PushKeychain.defaultAccessGroup).
  static func resolve() throws -> Resolved {
    lock.lock()
    defer { lock.unlock() }
    if let resolved {
      return resolved
    }
    let info = Bundle.main.infoDictionary ?? [:]
    let app = (info[appGroupKey] as? String).flatMap { $0.isEmpty ? nil : $0 }
    var next = Resolved(keychain: nil, shared: false, app: app)
    if let suffix = info[keychainSuffixKey] as? String, !suffix.isEmpty {
      next = Resolved(keychain: try PushKeychain.defaultAccessGroup() + suffix, shared: true, app: app)
    }
    resolved = next
    return next
  }

  static func keychain() throws -> PushKeychain {
    PushKeychain(accessGroup: try resolve().keychain)
  }
}

final class DecryptException: GenericException<String>, @unchecked Sendable {
  override var reason: String {
    "Couldn't decrypt the push: \(param)"
  }
}
