import { Platform } from 'react-native';

import { addBackgroundGraceListener, holdBackgroundGrace } from '../../modules/socio-device';
import type { BackgroundGrace } from '../sync/background-grace';

// The outbox's background grace on this phone (src/sync/background-grace.ts):
// socio-device's background task on iOS, and none on Android, which doesn't
// suspend an app seconds after it leaves the screen (v1 holds nothing
// there unless tests show requests being cut off).
//
// A development client built before the call existed lacks it: the grace then
// holds nothing, said once, and the outbox works as without it.

let warned = false;
const warnOnce = (error: unknown) => {
    if (!warned) {
        warned = true;
        console.warn('[grace] the background grace is not available', error);
    }
};

// One native task, two holders: the outbox (a request in flight) and the page
// editor (typing the draft's debounce hasn't handed to the outbox yet). The
// task is held while either holds.
const holders = { outbox: false, editor: false };
let held = false;
function apply() {
    const next = holders.outbox || holders.editor;
    if (next === held) {
        return;
    }
    held = next;
    try {
        holdBackgroundGrace(next).catch(warnOnce);
    } catch (error) {
        warnOnce(error);
    }
}

/** The page editor holds the grace while its draft has typing not yet queued (iOS; nothing on Android). */
export function holdEditorGrace(hold: boolean): void {
    if (Platform.OS === 'ios') {
        holders.editor = hold;
        apply();
    }
}

export const backgroundGrace: BackgroundGrace | null =
    Platform.OS === 'ios'
        ? {
              hold(hold) {
                  holders.outbox = hold;
                  apply();
              },
              onExpiring(listener) {
                  try {
                      const subscription = addBackgroundGraceListener((secondsLeft) => {
                          console.log('[grace] running out', JSON.stringify({ secondsLeft }));
                          listener();
                      });
                      return () => subscription.remove();
                  } catch (error) {
                      warnOnce(error);
                      return () => {};
                  }
              },
          }
        : null;
