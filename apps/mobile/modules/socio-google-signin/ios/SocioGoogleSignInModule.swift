import ExpoModulesCore
import GoogleSignIn
import UIKit

// Google's sign-in on iOS (README.md): GIDSignIn configured with the build's iOS client id and the
// server's client id for one ID token that carries the server's nonce. Google's SDK keeps the
// signed-in user in the keychain to restore it later; the app never restores one, so it signs out of
// the SDK as soon as it has the token, and nothing of the account stays. Nothing here logs.
public final class SocioGoogleSignInModule: Module {
  public func definition() -> ModuleDefinition {
    Name("SocioGoogleSignIn")

    AsyncFunction("signIn") { (clientId: String?, serverClientId: String, nonce: String, promise: Promise) in
      guard let clientId, !clientId.isEmpty else {
        promise.resolve(["type": "unavailable", "reason": "no-client-id"])
        return
      }
      guard let presenting = self.appContext?.utilities?.currentViewController() else {
        promise.resolve(["type": "unavailable", "reason": "no-view-controller"])
        return
      }
      let signIn = GIDSignIn.sharedInstance
      signIn.configuration = GIDConfiguration(clientID: clientId, serverClientID: serverClientId)
      signIn.signIn(withPresenting: presenting, hint: nil, additionalScopes: nil, nonce: nonce) { result, error in
        let token = result?.user.idToken?.tokenString
        signIn.signOut()
        if let error = error as NSError? {
          if error.domain == kGIDSignInErrorDomain && error.code == GIDSignInError.canceled.rawValue {
            promise.resolve(["type": "cancel"])
          } else {
            promise.resolve(["type": "failed", "reason": "\(error.domain == kGIDSignInErrorDomain ? "gid" : "other")-\(error.code)"])
          }
          return
        }
        guard let token else {
          promise.resolve(["type": "failed", "reason": "no-token"])
          return
        }
        promise.resolve(["type": "success", "idToken": token])
      }
    }.runOnQueue(.main)
  }
}

// Hands a URL opened in the app to Google's SDK, for a sign-in that comes back through the build's
// reversed client id scheme (plugins/google-sign-in.ts registers it).
public final class SocioGoogleSignInAppDelegate: ExpoAppDelegateSubscriber {
  public func application(_ app: UIApplication, open url: URL, options: [UIApplication.OpenURLOptionsKey: Any] = [:]) -> Bool {
    return GIDSignIn.sharedInstance.handle(url)
  }
}
