import Darwin
import ExpoModulesCore
import UIKit
import WebKit

// Socio's device calls on iOS. README.md describes each one on both platforms.
public final class SocioDeviceModule: Module {
  private static let protectedDataEvent = "onProtectedDataChange"
  private static let backgroundGraceEvent = "onBackgroundGraceExpiring"

  // Read as the module is created, early in the launch.
  private let prewarmed = ProcessInfo.processInfo.environment["ActivePrewarm"] == "1"

  // Only the listening hooks, on the JavaScript thread, and deinit touch these.
  private var protectedDataObservers: [NSObjectProtocol] = []

  // Made as the module is created; its state is only touched on the main thread.
  private var backgroundGrace: BackgroundGrace?

  public func definition() -> ModuleDefinition {
    Name("SocioDevice")

    Events(Self.protectedDataEvent, Self.backgroundGraceEvent)

    // No HTTP answer is kept on disk (CB-356). URLSession's default
    // configuration takes URLCache.shared, Library/Caches/<bundle id>/Cache.db,
    // which keeps answers even to a request that asks for no-store (the iOS
    // simulator, iOS 27). The module is created as the app starts, before
    // JavaScript runs and before expo/fetch makes its session on the first
    // request, so that session gets this cache, which keeps nothing. What an
    // earlier version left is cleared first.
    //
    // Both closures hold the module weakly, so neither keeps it alive.
    OnCreate { [weak self] in
      URLCache.shared.removeAllCachedResponses()
      URLCache.shared = URLCache(memoryCapacity: 0, diskCapacity: 0, directory: nil)

      self?.backgroundGrace = BackgroundGrace { secondsLeft in
        self?.sendEvent(Self.backgroundGraceEvent, ["secondsLeft": secondsLeft])
      }
    }

    // A reload makes a new module: a task this one held must not outlive it,
    // or iOS ends the app when the time runs out.
    OnDestroy {
      if let grace = backgroundGrace {
        DispatchQueue.main.async {
          MainActor.assumeIsolated { grace.stop() }
        }
      }
    }

    AsyncFunction("holdBackgroundGrace") { (hold: Bool) in
      MainActor.assumeIsolated { self.backgroundGrace?.hold(hold) }
    }
    .runOnQueue(.main)

    AsyncFunction("excludeFromBackup") { (path: String) in
      var url = try existingItem(path)
      var values = URLResourceValues()
      values.isExcludedFromBackup = true
      try url.setResourceValues(values)
    }

    AsyncFunction("isExcludedFromBackup") { (path: String) -> Bool in
      let url = try existingItem(path)
      return try url.resourceValues(forKeys: [.isExcludedFromBackupKey]).isExcludedFromBackup ?? false
    }

    AsyncFunction("setFileProtection") { (path: String, level: FileProtection) in
      let url = try existingItem(path)
      try FileManager.default.setAttributes([.protectionKey: level.type], ofItemAtPath: url.path)
    }

    AsyncFunction("getFileProtection") { (path: String) -> String? in
      let url = try existingItem(path)
      let attributes = try FileManager.default.attributesOfItem(atPath: url.path)
      guard let type = attributes[.protectionKey] as? FileProtectionType else {
        return nil
      }
      return FileProtection(type: type)?.rawValue
    }

    AsyncFunction("isProtectedDataAvailable") { () -> Bool in
      MainActor.assumeIsolated { UIApplication.shared.isProtectedDataAvailable }
    }
    .runOnQueue(.main)

    Function("processStartTime") { () -> Double in
      try processStartTime()
    }

    // Whether iOS prewarmed this process: created it and ran it up to
    // UIApplicationMain before the launch, so its start time is earlier.
    let wasPrewarmed = prewarmed
    Function("wasPrewarmed") { () -> Bool in
      wasPrewarmed
    }

    // Android's Auth Tab. iOS's sheet is expo-web-browser's ASWebAuthenticationSession with
    // its https callback (src/platform/auth-sheet.ts), so this only answers.
    AsyncFunction("openAuthTab") { (_: String, _: String, _: String) -> [String: String] in
      ["type": "unavailable", "reason": "ios"]
    }

    // The installed binary's version and build (Info.plist), so Settings shows what is installed,
    // whatever config a development client loaded.
    Function("appBuild") { () -> [String: String] in
      let info = Bundle.main.infoDictionary ?? [:]
      return [
        "version": info["CFBundleShortVersionString"] as? String ?? "",
        "build": info["CFBundleVersion"] as? String ?? "",
      ]
    }

    // Android's cold-start cross-check. iOS has no counterpart.
    AsyncFunction("reportFullyDrawn") { () -> Bool in
      false
    }

    // Sign-out: nothing a WebView kept stays. The page editor runs
    // incognito (a non-persistent data store), so this is the second lock:
    // every kind of website data in the default store (cookies, storage,
    // caches), since the beginning of time.
    AsyncFunction("clearWebViewData") { (promise: Promise) in
      let store = WKWebsiteDataStore.default()
      store.removeData(
        ofTypes: WKWebsiteDataStore.allWebsiteDataTypes(),
        modifiedSince: Date(timeIntervalSince1970: 0)
      ) {
        promise.resolve(true)
      }
    }
    .runOnQueue(.main)

    // Sign-out and every other wipe (CB-356): the app switcher's snapshots of
    // the app go, so none shows a workspace that left. iOS writes them as the
    // app goes to the background, into the app's own container:
    // Library/SplashBoard/Snapshots (iOS 13 and later, the launch screen's
    // cached images beside them, which iOS draws again as needed) and, before
    // that, Library/Caches/Snapshots. Everything under both goes; the folders
    // stay. Returns how many files were removed; throws once every item was
    // tried, naming the ones that failed.
    AsyncFunction("deleteAppSnapshots") { () -> Int in
      try deleteAppSnapshots()
    }
  }

  // Expo calls these two synchronously on the JavaScript thread, from the first
  // addListener and the last remove. OnStartObserving would run later, on the
  // queue all modules share for async functions, and a check that JavaScript makes
  // just after subscribing runs on main: an unlock between the two would be
  // lost. Here the observers exist before that check is even queued.
  public override func didStartListening(event: String) {
    if event == Self.protectedDataEvent {
      startObservingProtectedData()
    }
  }

  public override func didStopListening(event: String) {
    if event == Self.protectedDataEvent {
      stopObservingProtectedData()
    }
  }

  // Nothing else can reach the module by now, so this can't race the hooks.
  deinit {
    stopObservingProtectedData()
  }

  private func startObservingProtectedData() {
    stopObservingProtectedData()
    let center = NotificationCenter.default
    let changes: [(Notification.Name, Bool)] = [
      (UIApplication.protectedDataDidBecomeAvailableNotification, true),
      (UIApplication.protectedDataWillBecomeUnavailableNotification, false),
    ]
    protectedDataObservers = changes.map { name, available in
      center.addObserver(forName: name, object: nil, queue: .main) { [weak self] _ in
        self?.sendEvent(Self.protectedDataEvent, ["available": available])
      }
    }
  }

  private func stopObservingProtectedData() {
    for observer in protectedDataObservers {
      NotificationCenter.default.removeObserver(observer)
    }
    protectedDataObservers = []
  }
}

/// The outbox's background grace: based on
/// T3 Code's T3BackgroundGraceSubscriber (apps/mobile/modules/t3-native-controls,
/// https://github.com/pingdotgg/t3code, commit 240446e2d9, MIT, Copyright (c)
/// 2026 T3 Tools Inc.; the license is in THIRD_PARTY_NOTICES at the repository
/// root), which begins a background task whenever the app resigns active and
/// ends it when the app is active again. Rewritten for Socio:
///
/// - It holds the task only while JavaScript says a request is in flight
///   (`hold(true)`: some outbox lane is sending), begun as the app resigns
///   active, or at once if it already isn't active, and ended as soon as the
///   lanes are idle (`hold(false)`) or the app is active again.
/// - It listens for UIApplication's notifications, not an app delegate
///   subscriber, so it works the same whether the app runs on scenes or not.
/// - Before the time runs out it tells JavaScript (`onExpiring`), once, so the
///   outbox marks those rows unknown and stops their requests, then lets go.
///   iOS's expiry handler is the backstop: it tells too, if that didn't happen,
///   and ends the task at once. After either, no new task begins until the app
///   is active again, so a request started late is cut off and checked on resume.
///
/// It is Sendable only so iOS's expiry handler, a `@Sendable` closure, may hold
/// it: everything but `init` and `deinit` runs on the main thread (`@MainActor`,
/// and observers and a timer on the main queue), so nothing races.
final class BackgroundGrace: @unchecked Sendable {
  /// How long before the end of background time JavaScript is told: time to
  /// write the rows' state and abort the requests.
  static let warnBefore: TimeInterval = 5

  private let onExpiring: (Double) -> Void
  private var observers: [NSObjectProtocol] = []
  private var wanted = false
  private var task = UIBackgroundTaskIdentifier.invalid
  private var timer: Timer?
  /// Told (or ran out) since the app was last active: no new task until it is again.
  private var spent = false

  init(onExpiring: @escaping (Double) -> Void) {
    self.onExpiring = onExpiring
    let center = NotificationCenter.default
    observers = [
      center.addObserver(forName: UIApplication.willResignActiveNotification, object: nil, queue: .main) {
        [weak self] _ in
        MainActor.assumeIsolated { self?.resignedActive() }
      },
      center.addObserver(forName: UIApplication.didBecomeActiveNotification, object: nil, queue: .main) {
        [weak self] _ in
        MainActor.assumeIsolated { self?.becameActive() }
      },
    ]
  }

  deinit {
    for observer in observers {
      NotificationCenter.default.removeObserver(observer)
    }
  }

  /// Whether a request is in flight. True begins the task if the app isn't active.
  @MainActor
  func hold(_ hold: Bool) {
    wanted = hold
    if !hold {
      end()
    } else if UIApplication.shared.applicationState != .active {
      begin()
    }
  }

  /// Lets go for good (the module is going away).
  @MainActor
  func stop() {
    wanted = false
    end()
  }

  @MainActor
  private func resignedActive() {
    if wanted {
      begin()
    }
  }

  @MainActor
  private func becameActive() {
    spent = false
    end()
  }

  @MainActor
  private func begin() {
    guard task == .invalid, !spent else {
      return
    }
    let application = UIApplication.shared
    task = application.beginBackgroundTask(withName: "Socio outbox grace") { [weak self] in
      // iOS calls it on the main thread.
      MainActor.assumeIsolated { self?.ranOut() }
    }
    guard task != .invalid else {
      return
    }
    timer = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in
      MainActor.assumeIsolated { self?.check() }
    }
  }

  /// Once a second while the task is held: in the background, tells JavaScript when little time is left.
  @MainActor
  private func check() {
    let application = UIApplication.shared
    guard application.applicationState == .background else {
      return
    }
    let remaining = application.backgroundTimeRemaining
    if remaining <= Self.warnBefore {
      tell(remaining)
    }
  }

  @MainActor
  private func ranOut() {
    tell(UIApplication.shared.backgroundTimeRemaining)
    end()
  }

  @MainActor
  private func tell(_ remaining: TimeInterval) {
    guard !spent else {
      return
    }
    spent = true
    onExpiring(remaining.isFinite ? max(0, remaining) : 0)
  }

  @MainActor
  private func end() {
    timer?.invalidate()
    timer = nil
    guard task != .invalid else {
      return
    }
    UIApplication.shared.endBackgroundTask(task)
    task = .invalid
  }
}

/// The file URL of an existing item, so every call fails the same way on a missing path.
private func existingItem(_ path: String) throws -> URL {
  guard FileManager.default.fileExists(atPath: path) else {
    throw ItemNotFoundException(path)
  }
  return URL(fileURLWithPath: path)
}

/// The app switcher's snapshots of the app (CB-356): everything under
/// Library/SplashBoard/Snapshots and Library/Caches/Snapshots, the folders
/// themselves kept. Returns how many files went; every item is tried, then a
/// failure throws, naming what was left.
private func deleteAppSnapshots() throws -> Int {
  let manager = FileManager.default
  let library = manager.urls(for: .libraryDirectory, in: .userDomainMask)[0]
  let folders = [
    library.appendingPathComponent("SplashBoard/Snapshots", isDirectory: true),
    library.appendingPathComponent("Caches/Snapshots", isDirectory: true),
  ]
  var removed = 0
  var failed: [String] = []
  for folder in folders where manager.fileExists(atPath: folder.path) {
    let items: [URL]
    do {
      items = try manager.contentsOfDirectory(at: folder, includingPropertiesForKeys: nil)
    } catch {
      failed.append(folder.lastPathComponent)
      continue
    }
    for item in items {
      let files = countFiles(item)
      do {
        try manager.removeItem(at: item)
        removed += files
      } catch {
        failed.append(item.lastPathComponent)
      }
    }
  }
  if !failed.isEmpty {
    throw SnapshotsLeftException(failed.joined(separator: ", "))
  }
  return removed
}

/// The files at `url`: 1 for a file, the files under it for a folder.
private func countFiles(_ url: URL) -> Int {
  var isFolder: ObjCBool = false
  guard FileManager.default.fileExists(atPath: url.path, isDirectory: &isFolder) else {
    return 0
  }
  guard isFolder.boolValue else {
    return 1
  }
  let walk = FileManager.default.enumerator(at: url, includingPropertiesForKeys: [.isRegularFileKey])
  var count = 0
  while let next = walk?.nextObject() as? URL {
    if (try? next.resourceValues(forKeys: [.isRegularFileKey]).isRegularFile) == true {
      count += 1
    }
  }
  return count
}

/// When this process started, in milliseconds since the epoch: the kernel's
/// record of it (kinfo_proc's p_starttime), so it includes the time before
/// main() and before React Native loaded. After a prewarm it is the prewarm's
/// start, before the launch.
private func processStartTime() throws -> Double {
  var info = kinfo_proc()
  var size = MemoryLayout<kinfo_proc>.stride
  var mib: [Int32] = [CTL_KERN, KERN_PROC, KERN_PROC_PID, getpid()]
  guard sysctl(&mib, u_int(mib.count), &info, &size, nil, 0) == 0, size > 0 else {
    throw ProcessStartTimeException()
  }
  let start = info.kp_proc.p_un.__p_starttime
  return Double(start.tv_sec) * 1000 + Double(start.tv_usec) / 1000
}

/// NSFileProtection's classes, named as in JavaScript.
enum FileProtection: String, Enumerable {
  case complete
  case completeUnlessOpen
  case completeUntilFirstUserAuthentication
  case none

  var type: FileProtectionType {
    switch self {
    case .complete: return .complete
    case .completeUnlessOpen: return .completeUnlessOpen
    case .completeUntilFirstUserAuthentication: return .completeUntilFirstUserAuthentication
    case .none: return .none
    }
  }

  init?(type: FileProtectionType) {
    switch type {
    case .complete: self = .complete
    case .completeUnlessOpen: self = .completeUnlessOpen
    case .completeUntilFirstUserAuthentication: self = .completeUntilFirstUserAuthentication
    case .none: self = .none
    default: return nil
    }
  }
}

final class ItemNotFoundException: GenericException<String>, @unchecked Sendable {
  override var reason: String {
    "No file or directory at \(param)"
  }
}

final class ProcessStartTimeException: Exception, @unchecked Sendable {
  override var reason: String {
    "sysctl couldn't read this process's start time"
  }
}

final class SnapshotsLeftException: GenericException<String>, @unchecked Sendable {
  override var reason: String {
    "Some app-switcher snapshots couldn't be deleted: \(param)"
  }
}
