package expo.modules.sociopush

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

// SocioPushModule's taps without the module: a new intent's tap before JavaScript listens is held
// for takeLaunchTap, not taken and dropped.
class TapRelayTest {
  private val targets = mutableMapOf<String, PushTarget>()
  private val take: (String) -> PushTarget? = { targets.remove(it) }
  private val a = PushTarget("ws-a", "/chats/1", "1")
  private val b = PushTarget("ws-b", "/", null)

  @Test
  fun aTapBeforeTheListenerIsHeldForTakeLaunch() {
    val relay = TapRelay()
    targets["t1"] = a
    assertNull(relay.onNewIntent("t1", take))
    assertEquals("not taken while nobody listens", a, targets["t1"])
    assertEquals(a, relay.takeLaunch(null, take))
    assertNull("taken once", relay.takeLaunch(null, take))
  }

  @Test
  fun aTapWhileListeningIsSentAtOnce() {
    val relay = TapRelay()
    relay.setListening(true)
    targets["t1"] = a
    assertEquals(a, relay.onNewIntent("t1", take))
    assertNull(relay.takeLaunch("t1", take))
    relay.setListening(false)
    targets["t2"] = b
    assertNull(relay.onNewIntent("t2", take))
    assertEquals(b, relay.takeLaunch(null, take))
  }

  @Test
  fun theNewestTapWinsAndTheIntentsIsTakenToo() {
    val relay = TapRelay()
    targets["launch"] = a
    targets["later"] = b
    assertNull(relay.onNewIntent("later", take))
    assertEquals(b, relay.takeLaunch("launch", take))
    assertNull("the launch's token is gone too", targets["launch"])
    targets["launch2"] = a
    assertEquals(a, relay.takeLaunch("launch2", take))
  }

  @Test
  fun aHeldTokenTheStoreNoLongerHasGivesTheIntentsTap() {
    val relay = TapRelay()
    relay.onNewIntent("made-up", take)
    targets["launch"] = a
    assertEquals(a, relay.takeLaunch("launch", take))
  }
}
