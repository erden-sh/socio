package expo.modules.sociopush

import android.app.Application
import android.content.Context
import expo.modules.core.interfaces.ApplicationLifecycleListener
import expo.modules.core.interfaces.Package

// Autolinking finds this by its name and its import of Package. The channels are made as the app
// starts, before any permission prompt, so Settings lists them and the first push has them.
class SocioPushPackage : Package {
  override fun createApplicationLifecycleListeners(context: Context): List<ApplicationLifecycleListener> =
    listOf(
      object : ApplicationLifecycleListener {
        override fun onCreate(application: Application) {
          PushNotifier.createChannels(application)
        }
      },
    )
}
