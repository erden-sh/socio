package expo.modules.sociopush

import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File

// The inbox is listed oldest first (src/push.ts), whatever order the folder gives.
class PushInboxTest {
  @get:Rule val folder = TemporaryFolder()

  private fun plant(dir: File, id: String, modified: Long) {
    File(dir, "$id.json").apply {
      writeText("""{"n":"$id"}""")
      setLastModified(modified)
    }
  }

  @Test
  fun listsOldestFirstThenByName() {
    val dir = folder.newFolder("inbox")
    val newest = "ffffffff-0000-4000-8000-000000000000"
    val oldest = "99999999-0000-4000-8000-000000000000"
    val tieB = "bbbbbbbb-0000-4000-8000-000000000000"
    val tieA = "aaaaaaaa-0000-4000-8000-000000000000"
    plant(dir, newest, 1_700_000_300_000)
    plant(dir, tieB, 1_700_000_200_000)
    plant(dir, oldest, 1_700_000_100_000)
    plant(dir, tieA, 1_700_000_200_000)

    val listed = PushInbox.list(dir)
    assertEquals(listOf(oldest, tieA, tieB, newest), listed.map { it.id })
    assertEquals("""{"n":"$oldest"}""", listed.first().json)
  }

  @Test
  fun skipsFilesThatAreNotInboxEntries() {
    val dir = folder.newFolder("inbox")
    val id = "12345678-0000-4000-8000-000000000000"
    plant(dir, id, 1_700_000_000_000)
    File(dir, ".$id.json.tmp").writeText("{}")
    File(dir, "NOT-A-UUID.json").writeText("{}")
    File(dir, "$id.txt").writeText("{}")

    assertEquals(listOf(id), PushInbox.list(dir).map { it.id })
  }

  @Test
  fun aMissingFolderIsEmpty() {
    assertEquals(emptyList<InboxFile>(), PushInbox.list(File(folder.root, "absent")))
  }
}
