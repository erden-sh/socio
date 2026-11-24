import { Platform } from 'react-native';

import { deleteAppSnapshots } from '../../modules/socio-device';

// The app switcher's snapshots (CB-356): iOS keeps a picture of the app's last
// screen in its container as the app goes to the background, which a workspace
// that left must not stay in. Sign-out and every other wipe delete them through
// socio-device (its README); the next trip to the background takes a new one of
// whatever shows then. Android's recents thumbnail isn't a file of the app's, so
// nothing runs there. It never blocks a sign-out or a wipe: what happened goes
// to the log, and the call never rejects.

/** Deletes the app's app-switcher snapshots on iOS, after `why` (a sign-out, a lease wipe, ...). Never rejects. */
export async function forgetAppSnapshots(why: string): Promise<void> {
    if (Platform.OS !== 'ios') {
        return;
    }
    try {
        const removed = await deleteAppSnapshots();
        console.log(`[snapshots] ${why}: deleted ${removed} app-switcher snapshot file(s)`);
    } catch (error) {
        // A development client built before the call lands here too.
        console.warn(`[snapshots] ${why}: the app-switcher snapshots were not all deleted`, error);
    }
}
