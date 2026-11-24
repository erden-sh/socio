import Foundation

// The per-push inbox (README.md): the
// extension writes one file per push, `inbox/<uuid>.json` in the app group's
// container, under a temporary name first and then renamed, so the app never
// reads half a file and two pushes never write the same one. A file holds the
// workspace id, the link and the tag, never a title or a body. The app lists
// them and deletes the ones it handled. No SQLite in the shared container:
// a lock held there when the app is suspended gets it killed (0xdead10cc).

public struct PushInboxFile: Equatable {
  /// The file's name without `.json`: a UUID.
  public let id: String
  /// The file's contents, parsed by the wrapper (`src/push.ts`).
  public let json: String
}

public final class PushInbox {
  static let folder = "inbox"
  static let suffix = ".json"

  /// `<container>/inbox`, or nil when the build has no app group (Personal Team) or the system gives no container.
  public let directory: URL?

  public init(appGroup: String?) {
    guard let appGroup, !appGroup.isEmpty,
      let container = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: appGroup)
    else {
      directory = nil
      return
    }
    directory = container.appendingPathComponent(Self.folder, isDirectory: true)
  }

  init(directory: URL?) {
    self.directory = directory
  }

  /// Every finished file, oldest first by its modification date. Temporary files are left out.
  public func list() throws -> [PushInboxFile] {
    guard let directory, FileManager.default.fileExists(atPath: directory.path) else {
      return []
    }
    let urls = try FileManager.default.contentsOfDirectory(
      at: directory, includingPropertiesForKeys: [.contentModificationDateKey], options: [.skipsHiddenFiles])
    let named = urls.compactMap { url -> (URL, String, Date)? in
      let name = url.lastPathComponent
      guard name.hasSuffix(Self.suffix) else {
        return nil
      }
      let id = String(name.dropLast(Self.suffix.count))
      guard UUID(uuidString: id) != nil else {
        return nil
      }
      let date = (try? url.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate) ?? .distantPast
      return (url, id, date)
    }
    return named.sorted { $0.2 < $1.2 }.compactMap { url, id, _ in
      guard let data = try? Data(contentsOf: url), let json = String(data: data, encoding: .utf8) else {
        return nil
      }
      return PushInboxFile(id: id, json: json)
    }
  }

  /// Deletes the files with these ids; one already gone is fine. Ids that aren't UUIDs are refused.
  public func delete(ids: [String]) throws {
    guard let directory else {
      return
    }
    for id in ids {
      guard UUID(uuidString: id) != nil else {
        throw PushInboxError.badId(id)
      }
      let url = directory.appendingPathComponent(id + Self.suffix)
      do {
        try FileManager.default.removeItem(at: url)
      } catch CocoaError.fileNoSuchFile {
        continue
      }
    }
  }

  /// Writes one file under a fresh UUID: a hidden temporary name first, then renamed. Returns the id.
  @discardableResult
  public func write(_ data: Data) throws -> String {
    guard let directory else {
      throw PushInboxError.noContainer
    }
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    let id = UUID().uuidString.lowercased()
    let temporary = directory.appendingPathComponent(".\(id).tmp")
    try data.write(to: temporary, options: [.completeFileProtectionUntilFirstUserAuthentication])
    try FileManager.default.moveItem(at: temporary, to: directory.appendingPathComponent(id + Self.suffix))
    return id
  }
}

public enum PushInboxError: Error, Equatable {
  case badId(String)
  case noContainer
}
