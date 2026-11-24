// Push subscriptions: registering each workspace with the
// relay and its server, keeping them alive, the flags the extension reads, and
// the badge. Under Node: expo-notifications, socio-push and the relay client are
// handed in by src/platform/push.ts (tests/dependency-graph.test.ts).
export { type BadgeScopes, badgeCount, followBadge } from './badge';
export {
    type RegisterOutcome,
    type RelayClient,
    type RelayRegistration,
    type RelayWriteOutcome,
    createRelayClient,
} from './relay-client';
export { type RevocationRelays, retryPushRevocation, retryPushRevocations } from './revocation';
export {
    CHANNELS_PATH,
    createPushManager,
    PUSH_CHECK_MS,
    PUSH_REFRESH_MS,
    type PushApp,
    type PushKeyPair,
    type PushManager,
    type PushManagerDeps,
    type PushNative,
    type PushNotifications,
    type PushPermission,
    type PushRefresh,
    type PushScope,
    type PushStatus,
    SUBSCRIPTIONS_PATH,
} from './subscription';
export {
    ASK_COPY,
    ASK_TEXT,
    askDecision,
    type AskDecision,
    type AskTrigger,
    createNotificationAsk,
    effectivePermission,
    type NotificationAsk,
    type NotificationAskDeps,
    type NotificationAskState,
    type NotificationAvailability,
    type PhonePermission,
    NOT_NOW_MS,
    notificationsDenied,
    type SettingsNotificationRow,
    settingsRow,
} from './permission-ask';
export {
    APPROVAL_TOPIC,
    applyInboxPulls,
    createInboxDrain,
    type InboxDeps,
    type InboxDrain,
    type InboxFile,
    INBOX_MAX_AGE_MS,
    type InboxPulls,
    inboxPulls,
    type PullScope,
} from './inbox';
export {
    chatOnScreen,
    createPushTaps,
    followLaunchTaps,
    isOnScreen,
    type LaunchTapDeps,
    type NotificationRequestLike,
    notificationTarget,
    parsePushTarget,
    type PushTapDeps,
    type PushTaps,
    type PushTarget,
    switchedText,
    type TapAppState,
    UNKNOWN_WORKSPACE_TEXT,
    USER_INFO_KEY,
} from './taps';
export {
    createShowTextSetting,
    HAND_OVER_RETRIES_MS,
    ShowTextHandOverError,
    type ShowTextSetting,
    type ShowTextStore,
} from './show-text';
