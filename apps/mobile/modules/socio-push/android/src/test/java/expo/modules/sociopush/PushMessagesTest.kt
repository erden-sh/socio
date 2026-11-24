package expo.modules.sociopush

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

// What a push shows (PushMessages), on the plain JVM with real keys and the real decryptor.
class PushMessagesTest {
  private val now = 1_800_000_000_000L
  private val source = FakeSource().apply { register("reg-a", "ws-a", "Acme") }

  private fun show(data: Map<String, String>): PushContent {
    val outcome = PushMessages.map(data, source, now)
    assertTrue("expected Show, got $outcome", outcome is PushOutcome.Show)
    return (outcome as PushOutcome.Show).content
  }

  private fun fallback(data: Map<String, String>): PushFallback {
    val outcome = PushMessages.map(data, source, now)
    assertTrue("expected the relay's text, got $outcome", outcome is PushOutcome.RelayGeneric)
    val generic = outcome as PushOutcome.RelayGeneric
    assertEquals(PushMessages.GENERIC_TITLE, generic.content.title)
    assertEquals(PushMessages.RELAY_BODY, generic.content.body)
    assertNull(generic.content.target)
    assertEquals(false, generic.content.inbox)
    return generic.reason
  }

  @Test
  fun decryptsAndShowsThePayload() {
    val content = show(source.push("reg-a"))
    assertEquals("Bo in Launch", content.title)
    assertEquals("@Ana can you look?", content.body)
    assertEquals(PushTarget("ws-a", "/chats/room-1", "room-1"), content.target)
    assertEquals("ws-a:room-1", content.group)
    assertEquals(PushMessages.MESSAGES_CHANNEL, content.channel)
    assertEquals("Acme", content.workspaceName)
    assertNull("one workspace: no name on the notification", content.subText)
    assertTrue(content.inbox)
  }

  @Test
  fun namesTheWorkspaceWhenTwoHavePush() {
    source.register("reg-b", "ws-b", "Beta")
    assertEquals("Acme", show(source.push("reg-a")).subText)
  }

  @Test
  fun noTagMeansNoGroup() {
    val content = show(source.push("reg-a", TestPushes.payload(link = "/", tag = null)))
    assertNull(content.group)
    assertEquals(PushTarget("ws-a", "/", null), content.target)
  }

  @Test
  fun reportsGoToTheirOwnChannel() {
    assertEquals(PushMessages.REPORTS_CHANNEL, show(source.push("reg-a", TestPushes.payload(kind = "report"))).channel)
  }

  @Test
  fun showTextOffDecryptsButShowsGenericText() {
    source.show = false
    val content = show(source.push("reg-a"))
    assertEquals(PushMessages.GENERIC_TITLE, content.title)
    assertEquals(PushMessages.GENERIC_BODY, content.body)
    assertEquals(PushTarget("ws-a", "/chats/room-1", "room-1"), content.target)
    assertTrue(content.inbox)
  }

  @Test
  fun aLockedCopyDecryptsNothing() {
    source.flags["ws-a"] = WorkspaceFlags(locked = true, leaseLockAt = null)
    val content = show(source.push("reg-a"))
    assertEquals(PushMessages.GENERIC_TITLE, content.title)
    assertEquals(PushMessages.GENERIC_BODY, content.body)
    assertEquals(PushTarget("ws-a", "/", null), content.target)
    assertEquals(false, content.inbox)
    assertTrue(source.decrypted.isEmpty())
  }

  @Test
  fun theLeaseDeadlineLocksByTheDeviceClock() {
    source.flags["ws-a"] = WorkspaceFlags(locked = false, leaseLockAt = (now + 1).toDouble())
    assertEquals("Bo in Launch", show(source.push("reg-a")).title)
    source.flags["ws-a"] = WorkspaceFlags(locked = false, leaseLockAt = now.toDouble())
    assertEquals(PushMessages.GENERIC_BODY, show(source.push("reg-a")).body)
    assertEquals(1, source.decrypted.size)
  }

  @Test
  fun fallsBackToTheRelaysText() {
    val good = source.push("reg-a")
    assertEquals(PushFallback.NO_CIPHERTEXT, fallback(mapOf("s" to "reg-a", "g" to "1")))
    assertEquals(PushFallback.UNKNOWN_REGISTRATION, fallback(good + ("s" to "reg-unknown")))
    assertEquals(PushFallback.UNKNOWN_REGISTRATION, fallback(good + ("s" to "../reg")))
    val flipped = good.getValue("p").let { it.dropLast(3) + (if (it[it.length - 3] == 'A') 'B' else 'A') + it.takeLast(2) }
    assertEquals(PushFallback.UNDECRYPTABLE, fallback(good + ("p" to flipped)))
    assertEquals(PushFallback.UNDECRYPTABLE, fallback(good + ("p" to "not base64url!")))
    source.keys.remove("ws-a")
    assertEquals(PushFallback.NO_KEYS, fallback(good))
  }

  @Test
  fun refusesWhatIsntThePayload() {
    assertEquals(PushFallback.NOT_A_PAYLOAD, fallback(source.push("reg-a", "not json".toByteArray())))
    assertEquals(PushFallback.NOT_A_PAYLOAD, fallback(source.push("reg-a", TestPushes.payload(link = "https://evil.test/x"))))
    assertEquals(PushFallback.NOT_A_PAYLOAD, fallback(source.push("reg-a", """{"kind":"message","title":1,"body":"b","link":"/"}""".toByteArray())))
  }

  @Test
  fun ignoresIconAndImage() {
    val content = show(
      source.push("reg-a", TestPushes.payload(extra = mapOf("icon" to "https://evil.test/i.png", "image" to "https://evil.test/p.png"))),
    )
    assertEquals("Bo in Launch", content.title)
    // PushContent has no field that could carry either: nothing downstream can fetch them.
    assertTrue(PushContent::class.java.declaredFields.none { it.name.contains("icon", true) || it.name.contains("image", true) })
  }

  @Test
  fun dedupeIdsComeFromTheCiphertextsSalt() {
    val one = source.push("reg-a")
    assertEquals(PushMessages.dedupeId(one, "fcm-1"), PushMessages.dedupeId(one, "fcm-2"))
    assertTrue(PushMessages.dedupeId(one, null) != PushMessages.dedupeId(source.push("reg-a"), null))
    assertEquals("m:fcm-1", PushMessages.dedupeId(mapOf("s" to "reg-a", "g" to "1"), "fcm-1"))
    assertNull(PushMessages.dedupeId(mapOf("s" to "reg-a", "g" to "1"), null))
  }

  @Test
  fun decodesBase64Url() {
    val bytes = ByteArray(256) { it.toByte() }
    for (length in 1..20) {
      val slice = bytes.copyOf(length)
      assertArrayEquals(slice, PushMessages.decodeBase64Url(TestPushes.base64url(slice)))
    }
    assertNull(PushMessages.decodeBase64Url("abcde"))
    assertNull(PushMessages.decodeBase64Url("ab+/"))
  }
}
