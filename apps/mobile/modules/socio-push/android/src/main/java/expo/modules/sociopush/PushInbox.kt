package expo.modules.sociopush

import java.io.File

/**
 * Reads the inbox folder. No Android class, so the JVM test runs it as is.
 * Oldest first, as src/push.ts promises and iOS's PushInbox.list() gives:
 * by modification time, then by name when two share it. File.listFiles()
 * has no order of its own, and the names are random UUIDs.
 */
internal object PushInbox {
  private val UUID_NAME = Regex("^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")

  fun isId(id: String): Boolean = UUID_NAME.matches(id)

  fun list(dir: File): List<InboxFile> {
    val files = dir.listFiles() ?: return emptyList()
    return files
      .filter { it.name.endsWith(".json") && isId(it.name.removeSuffix(".json")) }
      .map { it to it.lastModified() }
      .sortedWith(compareBy<Pair<File, Long>> { it.second }.thenBy { it.first.name })
      .mapNotNull { (file, _) ->
        try {
          InboxFile(file.name.removeSuffix(".json"), file.readText())
        } catch (error: java.io.IOException) {
          null
        }
      }
  }
}
