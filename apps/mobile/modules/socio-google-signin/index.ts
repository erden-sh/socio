// socio-google-signin: the phone's own Google sign-in for Socio (README.md, CB-570). Autolinking
// finds it in apps/mobile/modules. iOS is Google's GoogleSignIn SDK, Android Credential Manager's
// "Sign in with Google"; neither opens a browser of the app's.
export { googleSignIn } from './src/google-sign-in';
export type { GoogleSignInResult } from './src/native';
