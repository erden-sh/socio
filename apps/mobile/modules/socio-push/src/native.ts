import { requireNativeModule } from 'expo';

/** Where this build keeps the push items (README.md, Groups). */
export interface PushStorage {
    /** The keychain group the push items go to; null is the keychain's default, the app's own. */
    keychainGroup: string | null;
    /** Whether that group is the one shared with the notification service extension. */
    shared: boolean;
    /** Whether the build has the app group's container, which holds the inbox files. */
    inbox: boolean;
}

/** A subscription's public keys, base64url: all JavaScript ever gets of them. */
export interface PushKeys {
    /** The P-256 public key, uncompressed (65 bytes). */
    p256dh: string;
    /** The auth secret (16 bytes). */
    auth: string;
}

export interface PushState {
    locked: boolean;
    leaseLockAt: number | null;
    showText: boolean;
}

/** One inbox file as the native side read it: its id (a UUID) and its text, unparsed. */
export interface NativeInboxFile {
    id: string;
    json: string;
}

/** A notification's tap target as the Android module hands it: unchecked until `push.ts` parses it. */
export interface NativeTap {
    workspaceId: string;
    link: string;
    tag: string | null;
}

/**
 * What the native module exports as `SocioPush`, in Swift and in Kotlin.
 * README.md says what each call does; the wrapper (`push.ts`) checks the
 * arguments before they get here.
 */
export interface SocioPushNative {
    storage(): Promise<PushStorage>;
    createKeys(workspaceId: string): Promise<PushKeys>;
    getKeys(workspaceId: string): Promise<PushKeys | null>;
    deleteKeys(workspaceId: string): Promise<void>;
    setRegistration(registrationId: string, workspaceId: string, name: string): Promise<void>;
    deleteRegistration(registrationId: string): Promise<void>;
    getState(workspaceId: string): Promise<PushState>;
    setLocked(workspaceId: string, locked: boolean): Promise<void>;
    setLeaseLockAt(workspaceId: string, at: number | null): Promise<void>;
    setShowText(showText: boolean): Promise<void>;
    decrypt(workspaceId: string, body: string): Promise<string>;
    listInbox(): Promise<NativeInboxFile[]>;
    deleteInbox(ids: string[]): Promise<void>;
    // Android only: the messaging service's screen check and the notifications' taps. iOS's
    // come from expo-notifications (src/push/taps.ts), so its module has none of these.
    setScreen?(workspaceId: string | null, path: string | null): void;
    takeLaunchTap?(): Promise<NativeTap | null>;
    addListener?(event: 'onTap', listener: (tap: NativeTap) => void): { remove(): void };
}

let loaded: SocioPushNative | undefined;

/**
 * The native module, loaded on first use rather than at import, so a build
 * without it (a development client built before it) fails
 * at the call that needs it, with Expo's "Cannot find native module", and not
 * at launch.
 */
export function native(): SocioPushNative {
    loaded ??= requireNativeModule<SocioPushNative>('SocioPush');
    return loaded;
}
