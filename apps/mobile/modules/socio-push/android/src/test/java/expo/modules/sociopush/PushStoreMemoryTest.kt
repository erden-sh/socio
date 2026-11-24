package expo.modules.sociopush

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config

// The service's memory in the real PushStore (state.json): seen ids and tap tokens. No keys, so no
// Keystore, which Robolectric lacks.
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], manifest = Config.NONE)
class PushStoreMemoryTest {
  private val store = PushStore.get(RuntimeEnvironment.getApplication())

  @Test
  fun seenIdsKeepTheLast64() {
    val prefix = java.util.UUID.randomUUID().toString()
    assertTrue(store.markSeen("$prefix-0"))
    assertFalse(store.markSeen("$prefix-0"))
    for (i in 1..64) assertTrue(store.markSeen("$prefix-$i"))
    assertTrue("the oldest fell out", store.markSeen("$prefix-0"))
    assertFalse(store.markSeen("$prefix-64"))
  }

  @Test
  fun tapsAreTakenOnceAndKeepTheLast64() {
    val first = store.putTap(PushTarget("ws-a", "/chats/1", "1"))
    val second = store.putTap(PushTarget("ws-a", "/", null))
    assertEquals(PushTarget("ws-a", "/", null), store.takeTap(second))
    assertNull(store.takeTap(second))
    assertNull(store.takeTap("made-up"))
    repeat(64) { store.putTap(PushTarget("ws-b", "/", null)) }
    assertNull("the oldest fell out", store.takeTap(first))
  }

  @Test
  fun registeredWorkspacesAreDistinct() {
    store.setRegistration("r1", PushRegistration("ws-x", "X"))
    store.setRegistration("r2", PushRegistration("ws-x", "X"))
    store.setRegistration("r3", PushRegistration("ws-y", "Y"))
    assertTrue(store.registeredWorkspaces().containsAll(setOf("ws-x", "ws-y")))
    store.deleteKeys("ws-x")
    assertFalse("ws-x" in store.registeredWorkspaces())
  }
}
