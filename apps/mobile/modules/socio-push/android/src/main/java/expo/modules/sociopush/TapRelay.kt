package expo.modules.sociopush

// Where a tap's token goes once the activity has it (SocioPushModule). While JavaScript listens to
// `onTap`, a tap on a new intent is taken and sent at once. Until it does (start-up, a JS reload), the
// token is held, not taken: `takeLaunchTap` hands it over at start or at the next return to 'active'
// (followLaunchTaps), and the store still gives each token out once. The newest tap wins, as a person
// tapping twice means the second. Process-wide, so a module made again after a reload finds the tap.
// No Android class, so it runs on the plain JVM test.
class TapRelay {
  private var listening = false
  private var held: String? = null

  @Synchronized
  fun setListening(on: Boolean) {
    listening = on
  }

  /** A tap on a new intent: the target to send now, or null when nobody listens (then it's held). */
  @Synchronized
  fun onNewIntent(token: String, take: (String) -> PushTarget?): PushTarget? {
    if (!listening) {
      held = token
      return null
    }
    return take(token)
  }

  /** `takeLaunchTap`: the held tap, else the one on the activity's intent; both are taken. */
  @Synchronized
  fun takeLaunch(intentToken: String?, take: (String) -> PushTarget?): PushTarget? {
    val fromIntent = intentToken?.let(take)
    val fromHeld = held?.let(take)
    held = null
    return fromHeld ?: fromIntent
  }

  companion object {
    val shared = TapRelay()
  }
}
