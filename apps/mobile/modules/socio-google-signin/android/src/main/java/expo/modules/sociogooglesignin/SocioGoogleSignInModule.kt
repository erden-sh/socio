package expo.modules.sociogooglesignin

import android.os.CancellationSignal
import java.util.concurrent.Executor
import androidx.credentials.CredentialManager
import androidx.credentials.CredentialManagerCallback
import androidx.credentials.CustomCredential
import androidx.credentials.GetCredentialRequest
import androidx.credentials.GetCredentialResponse
import androidx.credentials.exceptions.GetCredentialCancellationException
import androidx.credentials.exceptions.GetCredentialException
import androidx.credentials.exceptions.GetCredentialProviderConfigurationException
import androidx.credentials.exceptions.GetCredentialUnsupportedException
import androidx.credentials.exceptions.NoCredentialException
import com.google.android.libraries.identity.googleid.GetSignInWithGoogleOption
import com.google.android.libraries.identity.googleid.GoogleIdTokenCredential
import com.google.android.libraries.identity.googleid.GoogleIdTokenParsingException
import expo.modules.kotlin.Promise
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

// Google's sign-in on Android (README.md): Credential Manager's "Sign in with Google" button flow
// (GetSignInWithGoogleOption) for one ID token whose audience is the server's client id and which
// carries the server's nonce. The person's Cancel is `cancel`; no Google account is `no-account`.
// A failure says its exception's class, never its message. Nothing here logs.
class SocioGoogleSignInModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("SocioGoogleSignIn")

    AsyncFunction("signIn") { _: String?, serverClientId: String, nonce: String, promise: Promise ->
      val activity = appContext.currentActivity
      if (activity == null) {
        promise.resolve(mapOf("type" to "unavailable", "reason" to "no-activity"))
        return@AsyncFunction
      }
      val option = GetSignInWithGoogleOption.Builder(serverClientId).setNonce(nonce).build()
      val request = GetCredentialRequest.Builder().addCredentialOption(option).build()
      CredentialManager.create(activity).getCredentialAsync(
        activity,
        request,
        CancellationSignal(),
        Executor { work -> activity.runOnUiThread(work) },
        object : CredentialManagerCallback<GetCredentialResponse, GetCredentialException> {
          override fun onResult(result: GetCredentialResponse) {
            val credential = result.credential
            if (credential !is CustomCredential ||
              credential.type != GoogleIdTokenCredential.TYPE_GOOGLE_ID_TOKEN_CREDENTIAL
            ) {
              promise.resolve(mapOf("type" to "failed", "reason" to "credential-type"))
              return
            }
            try {
              val token = GoogleIdTokenCredential.createFrom(credential.data).idToken
              promise.resolve(mapOf("type" to "success", "idToken" to token))
            } catch (_: GoogleIdTokenParsingException) {
              promise.resolve(mapOf("type" to "failed", "reason" to "parse"))
            }
          }

          override fun onError(e: GetCredentialException) {
            promise.resolve(
              when (e) {
                is GetCredentialCancellationException -> mapOf("type" to "cancel")
                is NoCredentialException -> mapOf("type" to "no-account")
                is GetCredentialProviderConfigurationException ->
                  mapOf("type" to "unavailable", "reason" to "provider")
                is GetCredentialUnsupportedException -> mapOf("type" to "unavailable", "reason" to "unsupported")
                else -> mapOf("type" to "failed", "reason" to e.javaClass.simpleName)
              },
            )
          }
        },
      )
    }
  }
}
