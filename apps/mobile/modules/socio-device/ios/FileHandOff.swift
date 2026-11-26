import ExpoModulesCore
import QuickLook
import UIKit

/// A file the Media file page downloaded, handed to the system (CB-558):
/// `preview` shows it in Quick Look (PDFs, text, pictures, office files and
/// whatever else iOS previews), over the app, and `save` asks where to keep a
/// copy with the system's own panel (Files). Neither goes through a browser,
/// and the bytes never leave the app before the person picks where.
///
/// One at a time: a second call ends the first. Everything here runs on the
/// main thread (the module's calls are queued there).
@MainActor
final class FileHandOff: NSObject, QLPreviewControllerDataSource, QLPreviewControllerDelegate,
  UIDocumentPickerDelegate
{
  static let shared = FileHandOff()

  private var previewURL: URL?
  private var previewPromise: Promise?
  private var savePromise: Promise?

  /// Quick Look over `presenter`: `shown` once the person closes it, `no-app` for a type iOS can't preview.
  func preview(_ url: URL, from presenter: UIViewController?, promise: Promise) {
    guard let presenter else {
      promise.resolve("unavailable")
      return
    }
    guard QLPreviewController.canPreview(url as NSURL) else {
      promise.resolve("no-app")
      return
    }
    previewPromise?.resolve("shown")
    previewPromise = promise
    previewURL = url
    let controller = QLPreviewController()
    controller.dataSource = self
    controller.delegate = self
    presenter.present(controller, animated: true)
  }

  /// The system's export panel with a copy of the file: `saved`, or `cancelled`.
  func save(_ url: URL, from presenter: UIViewController?, promise: Promise) {
    guard let presenter else {
      promise.resolve("unavailable")
      return
    }
    savePromise?.resolve("cancelled")
    savePromise = promise
    let picker = UIDocumentPickerViewController(forExporting: [url], asCopy: true)
    picker.delegate = self
    presenter.present(picker, animated: true)
  }

  func numberOfPreviewItems(in controller: QLPreviewController) -> Int {
    previewURL == nil ? 0 : 1
  }

  func previewController(_ controller: QLPreviewController, previewItemAt index: Int) -> QLPreviewItem {
    (previewURL ?? URL(fileURLWithPath: "/")) as NSURL
  }

  func previewControllerDidDismiss(_ controller: QLPreviewController) {
    previewPromise?.resolve("shown")
    previewPromise = nil
    previewURL = nil
  }

  func documentPicker(_ controller: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]) {
    savePromise?.resolve("saved")
    savePromise = nil
  }

  func documentPickerWasCancelled(_ controller: UIDocumentPickerViewController) {
    savePromise?.resolve("cancelled")
    savePromise = nil
  }
}
