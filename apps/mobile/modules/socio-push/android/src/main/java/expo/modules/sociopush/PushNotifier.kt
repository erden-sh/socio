package expo.modules.sociopush

import android.Manifest
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.ProcessLifecycleOwner

/**
 * Posts Socio's pushes natively, so delivery doesn't need a running JavaScript bridge (../../README.md,
 * Messaging service). After T3 Code's AgentNotifications (vendor/t3code/SYNC.md, Ported): the seen-id
 * history that drops retries, the screen check through ProcessLifecycleOwner, the channels and the
 * launcher's content intent. What it shows is PushMessages'.
 */
object PushNotifier {
  private const val LOG = "SocioPush"
  /** The notify() tag of every Socio notification, so no other library's id collides with ours. */
  const val TAG = "socio.push"
  const val SUMMARY_TAG = "socio.push.summary"
  /** The launcher intent's extra: a token PushStore maps to the tap's target. */
  const val EXTRA_TAP = "expo.modules.sociopush.TAP"

  /** The chat on screen, as JavaScript reports it (`setScreen`); pushes for it aren't shown while the app is in front. */
  @Volatile private var screen: Pair<String, String>? = null

  fun setScreen(workspaceId: String?, path: String?) {
    screen = if (workspaceId != null && path != null) workspaceId to path else null
  }

  /** Mentions and room activity (high), socios' reports (default). Made at app start (SocioPushPackage), before any prompt. */
  fun createChannels(context: Context) {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
    context.getSystemService(NotificationManager::class.java).createNotificationChannels(
      listOf(
        NotificationChannel(
          PushMessages.MESSAGES_CHANNEL,
          "Mentions and room activity",
          NotificationManager.IMPORTANCE_HIGH,
        ),
        NotificationChannel(PushMessages.REPORTS_CHANNEL, "Reports from socios", NotificationManager.IMPORTANCE_DEFAULT),
      ),
    )
  }

  /**
   * One FCM data message the relay sent (`{s, p}` or `{s, g}`). Under the class's lock, so a retry
   * racing its original is dropped. A push that comes while notifications are off isn't consumed: a
   * retry after the person allows them still shows (T3 Code's rule).
   */
  @Synchronized
  fun receive(
    context: Context,
    data: Map<String, String>,
    messageId: String?,
    source: PushSource = PushStore.get(context),
    nowMs: Long = System.currentTimeMillis(),
  ) {
    if (!PushMessages.isOurs(data) || !canPost(context)) return
    val id = PushMessages.dedupeId(data, messageId)
    if (id != null && !source.markSeen(id)) return

    val outcome = PushMessages.map(data, source, nowMs)
    val content =
      when (outcome) {
        is PushOutcome.RelayGeneric -> {
          Log.i(LOG, "the relay's text shows: ${outcome.reason}")
          outcome.content
        }
        is PushOutcome.Show -> outcome.content
      }
    val target = content.target
    if (content.inbox && target != null) {
      try {
        source.writeInbox(target.workspaceId, target.link, target.tag, nowMs)
      } catch (error: Exception) {
        Log.e(LOG, "inbox file not written: ${error.javaClass.simpleName}")
      }
    }
    if (target != null && onScreen(target)) return
    post(context, source, content, (id ?: java.util.UUID.randomUUID().toString()).hashCode())
  }

  private fun onScreen(target: PushTarget): Boolean {
    val shown = screen ?: return false
    return shown.first == target.workspaceId &&
      shown.second == target.link &&
      ProcessLifecycleOwner.get().lifecycle.currentState.isAtLeast(Lifecycle.State.RESUMED)
  }

  private fun canPost(context: Context): Boolean {
    if (!NotificationManagerCompat.from(context).areNotificationsEnabled()) return false
    return Build.VERSION.SDK_INT < 33 ||
      ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) ==
      PackageManager.PERMISSION_GRANTED
  }

  private fun post(context: Context, source: PushSource, content: PushContent, id: Int) {
    createChannels(context)
    val tap = content.target?.let { source.putTap(it) }
    val publicText =
      if (content.workspaceName.isNotEmpty()) "New message in ${content.workspaceName}" else PushMessages.GENERIC_BODY
    val public = base(context, content.channel)
      .setContentTitle(PushMessages.GENERIC_TITLE)
      .setContentText(publicText)
      .build()
    val builder = base(context, content.channel)
      .setContentTitle(content.title)
      .setContentText(content.body)
      .setStyle(NotificationCompat.BigTextStyle().bigText(content.body))
      .setSubText(content.subText)
      .setVisibility(NotificationCompat.VISIBILITY_PRIVATE)
      .setPublicVersion(public)
      .setAutoCancel(true)
      .setContentIntent(contentIntent(context, tap, id))
    // Each message under its own id, grouped per conversation: a second mention never replaces the first.
    content.group?.let { builder.setGroup(it).setGroupAlertBehavior(NotificationCompat.GROUP_ALERT_CHILDREN) }
    val manager = NotificationManagerCompat.from(context)
    try {
      manager.notify(TAG, id, builder.build())
      content.group?.let { group ->
        val summary = base(context, content.channel)
          .setContentTitle(content.workspaceName.ifEmpty { PushMessages.GENERIC_TITLE })
          .setContentText(PushMessages.GENERIC_BODY)
          .setSubText(content.subText)
          .setVisibility(NotificationCompat.VISIBILITY_PRIVATE)
          .setPublicVersion(public)
          .setGroup(group)
          .setGroupSummary(true)
          .setGroupAlertBehavior(NotificationCompat.GROUP_ALERT_CHILDREN)
          .setAutoCancel(true)
          .setContentIntent(contentIntent(context, null, group.hashCode()))
          .build()
        manager.notify(SUMMARY_TAG, group.hashCode(), summary)
      }
    } catch (error: SecurityException) {
      Log.w(LOG, "notifications aren't allowed")
    }
  }

  // The badge (the notification count) is never set here: the app sets it from its own counts.
  private fun base(context: Context, channel: String): NotificationCompat.Builder {
    val icon = context.resources.getIdentifier("notification_icon", "drawable", context.packageName)
    val color = context.resources.getIdentifier("notification_icon_color", "color", context.packageName)
    return NotificationCompat.Builder(context, channel)
      .setSmallIcon(if (icon != 0) icon else android.R.drawable.ic_dialog_info)
      .apply { if (color != 0) setColor(ContextCompat.getColor(context, color)) }
      .setPriority(
        if (channel == PushMessages.MESSAGES_CHANNEL) NotificationCompat.PRIORITY_HIGH else NotificationCompat.PRIORITY_DEFAULT,
      )
      .setCategory(NotificationCompat.CATEGORY_MESSAGE)
  }

  /**
   * The launcher activity, explicitly, never a VIEW URL: only this token goes with it, and the module
   * hands JavaScript the target PushStore kept under it (`takeLaunchTap`, `onTap`). A token another app
   * makes up names nothing.
   */
  private fun contentIntent(context: Context, tap: String?, id: Int): PendingIntent? {
    val intent = context.packageManager.getLaunchIntentForPackage(context.packageName) ?: return null
    intent.addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP)
    if (tap != null) intent.putExtra(EXTRA_TAP, tap)
    return PendingIntent.getActivity(
      context,
      id,
      intent,
      PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
    )
  }
}
