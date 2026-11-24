import {
    AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY,
    deleteItemAsync,
    getItemAsync,
    type SecureStoreOptions,
    setItemAsync,
} from 'expo-secure-store';

import type { KeyStore } from '../data/keys';

// The store's KeyStore on expo-secure-store (src/data/keys.ts):
// the iOS keychain in the app's own group, Android's Keystore-wrapped
// preferences. Every item is AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY: readable in
// the background once the phone has been unlocked after a restart, and never
// in a backup or on another phone.
//
// A read that fails throws a KeyStoreReadError, never null: before the first
// unlock iOS refuses the read (errSecInteractionNotAllowed), and a null there
// would read as "files without their key" and delete them. Launch waits for
// protected data on that error and reads again (launch.ts). null comes only
// from expo-secure-store itself, for a name with no value; on Android that
// includes a value its Keystore key can no longer open (after a reinstall),
// which is a key that is gone.

const OPTIONS: SecureStoreOptions = { keychainAccessible: AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY };

/** Secure storage couldn't be read: it says nothing about whether the name has a value. */
export class KeyStoreReadError extends Error {
    override readonly name = 'KeyStoreReadError';

    constructor(cause: unknown) {
        super('Secure storage could not be read.');
        this.cause = cause;
    }
}

/** The error, or one in its chain of causes, is a KeyStoreReadError. */
export function isKeyStoreReadError(error: unknown): boolean {
    for (let at: unknown = error, depth = 0; at instanceof Error && depth < 8; at = at.cause, depth += 1) {
        if (at instanceof KeyStoreReadError) {
            return true;
        }
    }
    return false;
}

/** The slice of expo-secure-store the binding uses. */
export interface ExpoSecureStore {
    getItemAsync: typeof getItemAsync;
    setItemAsync: typeof setItemAsync;
    deleteItemAsync: typeof deleteItemAsync;
}

const EXPO_SECURE_STORE: ExpoSecureStore = { getItemAsync, setItemAsync, deleteItemAsync };

export function createSecureKeyStore(secureStore: ExpoSecureStore = EXPO_SECURE_STORE): KeyStore {
    return {
        get: async (name) => {
            try {
                return await secureStore.getItemAsync(name, OPTIONS);
            } catch (error) {
                throw new KeyStoreReadError(error);
            }
        },
        set: (name, value) => secureStore.setItemAsync(name, value, OPTIONS),
        delete: (name) => secureStore.deleteItemAsync(name, OPTIONS),
    };
}
