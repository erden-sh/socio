import Foundation
import XCTest

@testable import SocioPushShared

// The inbox's files in a temporary folder: written under a temporary name and
// renamed, listed oldest first, deleted by id.
final class PushInboxTests: XCTestCase {
  func testWritesListsAndDeletes() throws {
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: directory) }
    let inbox = PushInbox(directory: directory)
    XCTAssertEqual(try inbox.list(), [])

    let first = try inbox.write(Data(#"{"n":1}"#.utf8))
    let second = try inbox.write(Data(#"{"n":2}"#.utf8))
    try FileManager.default.setAttributes(
      [.modificationDate: Date(timeIntervalSinceNow: -60)], ofItemAtPath: directory.appendingPathComponent(first + ".json").path)
    // A temporary file and a stray name are never listed.
    try Data("{}".utf8).write(to: directory.appendingPathComponent(".\(UUID().uuidString).tmp"))
    try Data("{}".utf8).write(to: directory.appendingPathComponent("other.json"))

    XCTAssertEqual(try inbox.list(), [
      PushInboxFile(id: first, json: #"{"n":1}"#), PushInboxFile(id: second, json: #"{"n":2}"#),
    ])
    try inbox.delete(ids: [first, UUID().uuidString])
    XCTAssertEqual(try inbox.list().map(\.id), [second])
    XCTAssertThrowsError(try inbox.delete(ids: ["../other"]))
  }

  func testNoContainer() throws {
    let inbox = PushInbox(appGroup: nil)
    XCTAssertEqual(try inbox.list(), [])
    try inbox.delete(ids: [UUID().uuidString])
    XCTAssertThrowsError(try inbox.write(Data()))
  }
}
