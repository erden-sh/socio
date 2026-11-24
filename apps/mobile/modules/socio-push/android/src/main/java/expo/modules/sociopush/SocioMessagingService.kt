package expo.modules.sociopush

import com.google.firebase.messaging.RemoteMessage
import expo.modules.notifications.service.ExpoFirebaseMessagingService

/**
 * Takes the place of expo-notifications' service (this module's manifest removes Expo's), so
 * `onNewToken` still reaches expo-notifications while Socio's pushes are decrypted and posted here,
 * with no JavaScript running. Anything that isn't the relay's goes to Expo's handling.
 */
class SocioMessagingService : ExpoFirebaseMessagingService() {
  override fun onMessageReceived(remoteMessage: RemoteMessage) {
    if (PushMessages.isOurs(remoteMessage.data)) {
      PushNotifier.receive(this, remoteMessage.data, remoteMessage.messageId)
    } else {
      super.onMessageReceived(remoteMessage)
    }
  }
}
