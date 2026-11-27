// Requests, credentials and sign-in. Its tests
// run it under Node, so nothing here imports React Native or Expo, through
// another file either (tests/dependency-graph.test.ts): it is handed the app's
// one fetch, from src/platform/fetch.ts, never the global.
export {
    type AddressCheck,
    type AddressProblem,
    addressRules,
    checkAddress,
    checkUrl,
    type HostParts,
    hostParts,
    LOCAL_HTTP_HOSTS,
    type WorkspaceAddress,
} from './address';
export {
    type Answered,
    type AuthedFetch,
    type AuthedFetchOptions,
    type AuthedRequestInit,
    createAuthedFetch,
    type RawUpload,
    UPLOAD_PATH,
} from './authed-fetch';
export { parseCookieDate } from './cookie-date';
export {
    type CookieJar,
    type CookieJarOptions,
    type JarStore,
    memoryJarStore,
    openCookieJar,
    type Outgoing,
} from './cookie-jar';
export { AbortedError, NetworkError, OutsideOriginError, RedirectRefusedError } from './errors';
export { type FetchFunction, type RequestHeaders, setCookieHeaders } from './fetch-function';
export { createPublicFetch, type PublicFetch, type PublicFetchOptions, type PublicRequestInit } from './public-fetch';
export {
    PROBE_PATH,
    type ProbeOptions,
    type ProbeProblem,
    type ProbeResult,
    probeWorkspace,
    type WorkspaceInfo,
} from './probe';
export { CANT_CHECK, CANT_REACH, NOT_AVAILABLE, NOT_SOCIO, probeCopy } from './probe-copy';
export { readJson, readText } from './read-body';
export { readSse, type ReadSseOptions, SilentStreamError, SSE_SILENCE_MS, type SseFrame } from './read-sse';
export { failureOf, serverAway } from './reconnect';
export {
    classifyRunAnswer,
    classifyRunError,
    CYCLE_RATE_WAIT_MS,
    type NoInferenceText,
    noInferenceText,
    retryAfterMs,
    type RunAnswer,
    type RunContext,
    type RunFailure,
    type UnsentReason,
} from './run-answer';
export {
    connectPath,
    createRunClient,
    RUN_TOOLS,
    type RunBodyInput,
    type RunClient,
    type RunClientOptions,
    type RunError,
    type RunOutcome,
    runPath,
    type StopOutcome,
    stopPath,
    type StreamOptions,
} from './run-client';
export { classifyUnauthorized, type SessionEnd, sessionCookieName, sessionEndOf, wipesCopy } from './session';
export { type Cookie, readSetCookie, splitSetCookie } from './set-cookie';
export {
    AUTH_SESSION_PATH,
    CODE_REDEEM_PATH,
    DEVICE_REDEEM_PATH,
    LOGOUT_PATH,
    PAIR_REDEEM_PATH,
    type RedeemPairingOptions,
    redeemPairing,
    type RedeemSheetOptions,
    redeemSheetCode,
    type RedeemSignInCodeOptions,
    redeemSignInCode,
    type RedeemSocialOptions,
    redeemSocialToken,
    SESSION_PATH,
    SOCIAL_REDEEM_PATH,
    SIGN_IN_PATH,
    SIGN_OUT_TIMEOUT_MS,
    type SignInOptions,
    type SignInProblem,
    type SignInProblemKind,
    type SignInResult,
    signInWithPassword,
    signOutJar,
    type StagedSignIn,
    type StagingJar,
    type StagingOptions,
} from './sign-in';
export {
    CODE_TRIES_USED,
    EMAIL_NOT_VERIFIED,
    GENERIC,
    INVALID_EMAIL,
    NOT_SIGNED_IN,
    otherPersonCopy,
    type OtherPersonCopy,
    PASSWORD_OFF,
    SERVER_ERROR,
    SHEET_APPROVER_GONE,
    SHEET_CODE_DEAD,
    SHEET_DENIED,
    SHEET_METHOD_OFF,
    SHEET_WRONG_APP,
    type SignInAction,
    type SignInCopy,
    signInCopy,
    UNFINISHED,
    UNREACHABLE,
    waitText,
    WRONG_CREDENTIALS,
} from './sign-in-copy';
export { type ClientInfo, userAgent } from './user-agent';
