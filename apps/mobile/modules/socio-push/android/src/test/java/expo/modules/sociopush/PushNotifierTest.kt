package expo.modules.sociopush

import android.app.Activity
import android.app.Application
import android.app.Notification
import android.app.NotificationManager
import android.content.ComponentName
import android.content.Intent
import android.content.IntentFilter
import androidx.core.app.NotificationCompat
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleRegistry
import androidx.lifecycle.ProcessLifecycleOwner
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config

// PushNotifier under Robolectric, after T3 Code's AgentNotificationsTest (vendor/t3code/SYNC.md):
// the same setup (a launcher activity, the process lifecycle driven by hand), its retry and
// foreground cases, and Socio's: decryption, the flags, the lease, grouping, the tap token and the
// ignored icon and image. SDK 24 has no channels; 34 is the newest Robolectric runs on JDK 17.
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [24, 34], manifest = Config.NONE)
class PushNotifierTest {
  private lateinit var context: Application
  private lateinit var manager: NotificationManager
  private lateinit var lifecycle: LifecycleRegistry
  private lateinit var source: FakeSource
  private val now = 1_800_000_000_000L

  @Before
  fun setUp() {
    context = RuntimeEnvironment.getApplication()
    manager = context.getSystemService(NotificationManager::class.java)
    shadowOf(manager).setNotificationsEnabled(true)
    shadowOf(context).grantPermissions(android.Manifest.permission.POST_NOTIFICATIONS)
    lifecycle = ProcessLifecycleOwner.get().lifecycle as LifecycleRegistry
    lifecycle.currentState = Lifecycle.State.CREATED
    val launcher = ComponentName(context, Activity::class.java)
    shadowOf(context.packageManager).addActivityIfNotPresent(launcher)
    shadowOf(context.packageManager).addIntentFilterForActivity(
      launcher,
      IntentFilter(Intent.ACTION_MAIN).apply { addCategory(Intent.CATEGORY_LAUNCHER) },
    )
    manager.cancelAll()
    PushNotifier.setScreen(null, null)
    source = FakeSource().apply { register("reg-a", "ws-a", "Acme") }
  }

  private fun receive(data: Map<String, String>, messageId: String? = null) =
    PushNotifier.receive(context, data, messageId, source, now)

  private fun messages() = manager.activeNotifications.filter { it.tag == PushNotifier.TAG }

  private fun only(): Notification = messages().single().notification

  private fun title(notification: Notification) = notification.extras.getCharSequence(Notification.EXTRA_TITLE)?.toString()

  private fun text(notification: Notification) = notification.extras.getCharSequence(Notification.EXTRA_TEXT)?.toString()

  @Test
  fun showsADecryptedMessage() {
    receive(source.push("reg-a"))
    val shown = only()
    assertEquals("Bo in Launch", title(shown))
    assertEquals("@Ana can you look?", text(shown))
    assertEquals(NotificationCompat.VISIBILITY_PRIVATE, shown.visibility)
    assertEquals("New message in Acme", text(shown.publicVersion))
    assertEquals(PushMessages.GENERIC_TITLE, title(shown.publicVersion))
    assertEquals(0, shown.number)
    assertEquals(listOf(PushTarget("ws-a", "/chats/room-1", "room-1")), source.inbox)
    if (android.os.Build.VERSION.SDK_INT >= 26) {
      assertEquals(PushMessages.MESSAGES_CHANNEL, shown.channelId)
      assertEquals(NotificationManager.IMPORTANCE_HIGH, manager.getNotificationChannel(PushMessages.MESSAGES_CHANNEL).importance)
      assertEquals(NotificationManager.IMPORTANCE_DEFAULT, manager.getNotificationChannel(PushMessages.REPORTS_CHANNEL).importance)
    }
  }

  @Test
  fun channelsExistBeforeAnyPush() {
    PushNotifier.createChannels(context)
    if (android.os.Build.VERSION.SDK_INT >= 26) {
      assertEquals(
        setOf(PushMessages.MESSAGES_CHANNEL, PushMessages.REPORTS_CHANNEL),
        manager.notificationChannels.map { it.id }.toSet(),
      )
    }
    assertTrue(manager.activeNotifications.isEmpty())
  }

  @Test
  fun aRetryIsDroppedButTheHistoryKeepsOnly64() {
    val first = source.push("reg-a")
    receive(first, "fcm-1")
    receive(first, "fcm-1-retry")
    assertEquals(1, messages().size)
    assertEquals(1, source.inbox.size)
    repeat(64) { receive(source.push("reg-a")) }
    manager.cancelAll()
    receive(first)
    assertEquals("the first fell out of the last 64, so it shows again", 1, messages().size)
  }

  @Test
  fun eachMessageGetsItsOwnIdGroupedPerTag() {
    receive(source.push("reg-a", TestPushes.payload(body = "one")))
    receive(source.push("reg-a", TestPushes.payload(body = "two")))
    receive(source.push("reg-a", TestPushes.payload(body = "elsewhere", tag = "room-2", link = "/chats/room-2")))
    val shown = messages()
    assertEquals(setOf("one", "two", "elsewhere"), shown.map { text(it.notification) }.toSet())
    assertEquals(3, shown.map { it.id }.toSet().size)
    assertEquals(
      mapOf("one" to "ws-a:room-1", "two" to "ws-a:room-1", "elsewhere" to "ws-a:room-2"),
      shown.associate { text(it.notification) to it.notification.group },
    )
    val summaries = manager.activeNotifications.filter { it.tag == PushNotifier.SUMMARY_TAG }
    assertEquals(setOf("ws-a:room-1", "ws-a:room-2"), summaries.map { it.notification.group }.toSet())
    assertTrue(summaries.all { it.notification.flags and Notification.FLAG_GROUP_SUMMARY != 0 })
  }

  @Test
  fun theChatOnScreenIsntShownWhileTheAppIsInFront() {
    PushNotifier.setScreen("ws-a", "/chats/room-1")
    lifecycle.currentState = Lifecycle.State.RESUMED
    val onScreen = source.push("reg-a")
    receive(onScreen)
    receive(source.push("reg-a", TestPushes.payload(body = "other room", tag = "room-2", link = "/chats/room-2")))
    assertEquals(listOf("other room"), messages().map { text(it.notification) })
    assertEquals("both are in the inbox", 2, source.inbox.size)
    // A retry of the suppressed push after the app goes back stays hidden (T3 Code's case).
    lifecycle.currentState = Lifecycle.State.CREATED
    receive(onScreen)
    assertEquals(1, messages().size)
    // In the background the same chat shows.
    receive(source.push("reg-a"))
    assertEquals(2, messages().size)
  }

  @Test
  fun anotherWorkspacesSamePathIsShown() {
    source.register("reg-b", "ws-b", "Beta")
    PushNotifier.setScreen("ws-a", "/chats/room-1")
    lifecycle.currentState = Lifecycle.State.RESUMED
    receive(source.push("reg-b"))
    assertEquals("Beta", only().extras.getCharSequence(Notification.EXTRA_SUB_TEXT)?.toString())
  }

  @Test
  fun lockedOrPastTheLeaseShowsGenericTextAndWritesNoInbox() {
    source.flags["ws-a"] = WorkspaceFlags(locked = false, leaseLockAt = (now - 1).toDouble())
    receive(source.push("reg-a"))
    assertEquals(PushMessages.GENERIC_TITLE, title(only()))
    assertEquals(PushMessages.GENERIC_BODY, text(only()))
    assertTrue(source.inbox.isEmpty())
    assertTrue(source.decrypted.isEmpty())
    assertEquals(PushTarget("ws-a", "/", null), source.taps.values.single())
  }

  @Test
  fun showTextOffHidesTheText() {
    source.show = false
    receive(source.push("reg-a"))
    assertEquals(PushMessages.GENERIC_TITLE, title(only()))
    assertEquals(PushMessages.GENERIC_BODY, text(only()))
    assertEquals(1, source.inbox.size)
  }

  @Test
  fun theRelaysGenericAlertOpensTheAppOnly() {
    receive(mapOf("s" to "reg-a", "g" to "1"), "fcm-g")
    assertEquals(PushMessages.RELAY_BODY, text(only()))
    val tap = shadowOf(only().contentIntent).savedIntent
    assertNull(tap.getStringExtra(PushNotifier.EXTRA_TAP))
    assertTrue(source.inbox.isEmpty())
  }

  @Test
  fun aTapCarriesOnlyATokenToAnExplicitIntent() {
    receive(source.push("reg-a"))
    val tap = shadowOf(only().contentIntent).savedIntent
    assertEquals(ComponentName(context, Activity::class.java), tap.component)
    assertNull("never a VIEW URL", tap.data)
    assertNotEquals(Intent.ACTION_VIEW, tap.action)
    val token = tap.getStringExtra(PushNotifier.EXTRA_TAP)!!
    assertEquals(setOf(PushNotifier.EXTRA_TAP), tap.extras!!.keySet())
    assertEquals(PushTarget("ws-a", "/chats/room-1", "room-1"), source.takeTap(token))
    assertNull("once", source.takeTap(token))
  }

  @Test
  fun notificationsOffConsumeNothing() {
    shadowOf(manager).setNotificationsEnabled(false)
    val push = source.push("reg-a")
    receive(push)
    assertTrue(source.seen.isEmpty())
    shadowOf(manager).setNotificationsEnabled(true)
    receive(push)
    assertEquals(1, messages().size)
  }

  @Test
  fun leavesOtherMessagesToExpo() {
    receive(mapOf("title" to "not ours"))
    assertTrue(manager.activeNotifications.isEmpty())
    assertTrue(source.seen.isEmpty())
  }
}
