package expo.modules.sociodevice

import android.app.Activity
import android.content.ActivityNotFoundException
import android.content.Intent
import android.net.Uri
import android.webkit.MimeTypeMap
import androidx.activity.result.ActivityResultLauncher
import androidx.activity.result.ActivityResultRegistryOwner
import androidx.activity.result.contract.ActivityResultContracts
import expo.modules.kotlin.Promise
import java.io.File

// A file the Media file page downloaded, handed to the system (CB-558):
// - `preview` opens it in whichever app the person picks (ACTION_VIEW on a
//   content URI the app's FileProvider made, readable by that app alone and
//   only through the grant), or answers `no-app` when none takes its type;
// - `save` asks where to keep a copy with the system's own panel
//   (ACTION_CREATE_DOCUMENT, no storage permission) and writes the bytes there.
// Neither goes through a browser, and the bytes never leave the app before the
// person picks where.
//
// The save's launcher is registered on the activity's registry without a
// lifecycle owner, as AuthTab's is: registerActivityResultLauncher needs one
// before STARTED, which a module call never is. A process killed while the
// panel shows loses the result, and nothing was written.
internal object FileHandOff {
  private const val KEY = "socio-save-file"
  private var launcher: ActivityResultLauncher<Intent>? = null
  private var pending: Promise? = null
  private var source: File? = null

  /** The type other apps are asked about: the file's own, else its extension's, else anything. */
  private fun typeOf(mimeType: String, name: String): String {
    val given = mimeType.substringBefore(';').trim().lowercase()
    if (given.isNotEmpty() && given != "application/octet-stream") {
      return given
    }
    val extension = name.substringAfterLast('.', "").lowercase()
    return MimeTypeMap.getSingleton().getMimeTypeFromExtension(extension) ?: "*/*"
  }

  fun preview(activity: Activity?, contentUri: String?, mimeType: String, name: String, promise: Promise) {
    if (activity == null || contentUri.isNullOrEmpty()) {
      promise.resolve("unavailable")
      return
    }
    val intent =
      Intent(Intent.ACTION_VIEW).apply {
        setDataAndType(Uri.parse(contentUri), typeOf(mimeType, name))
        addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
      }
    try {
      activity.startActivity(intent)
      promise.resolve("shown")
    } catch (_: ActivityNotFoundException) {
      promise.resolve("no-app")
    } catch (_: SecurityException) {
      promise.resolve("no-app")
    }
  }

  fun save(activity: Activity?, path: String, mimeType: String, name: String, promise: Promise) {
    val owner = activity as? ActivityResultRegistryOwner
    val file = File(path)
    if (activity == null || owner == null || !file.isFile) {
      promise.resolve("unavailable")
      return
    }
    // One panel at a time: a second call ends the first as cancelled.
    pending?.resolve("cancelled")
    pending = promise
    source = file
    launcher?.unregister()
    val registered =
      owner.activityResultRegistry.register(KEY, ActivityResultContracts.StartActivityForResult()) { result ->
        val answer = pending
        val from = source
        pending = null
        source = null
        launcher?.unregister()
        launcher = null
        val target = result.data?.data
        if (result.resultCode != Activity.RESULT_OK || target == null || from == null) {
          answer?.resolve("cancelled")
          return@register
        }
        // The copy runs off the main thread: a file may be 100 MB.
        Thread {
          try {
            val output = activity.contentResolver.openOutputStream(target, "w")
            if (output == null) {
              answer?.resolve("failed")
            } else {
              output.use { stream -> from.inputStream().use { it.copyTo(stream) } }
              answer?.resolve("saved")
            }
          } catch (_: Exception) {
            answer?.resolve("failed")
          }
        }.start()
      }
    launcher = registered
    val intent =
      Intent(Intent.ACTION_CREATE_DOCUMENT).apply {
        addCategory(Intent.CATEGORY_OPENABLE)
        type = typeOf(mimeType, name)
        putExtra(Intent.EXTRA_TITLE, name)
      }
    try {
      registered.launch(intent)
    } catch (_: ActivityNotFoundException) {
      pending = null
      source = null
      registered.unregister()
      launcher = null
      promise.resolve("unavailable")
    }
  }
}
