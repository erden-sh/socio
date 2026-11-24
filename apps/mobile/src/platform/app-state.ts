import { AppState } from 'react-native';

import type { AppStateSource } from '../sync/triggers';

// The app's state for sync: React Native's
// AppState, bound here and nowhere else in src/ (tests/platform-bindings.test.ts),
// so src/sync, which runs under Node, takes it as a parameter and its tests
// hand in a fake. 'inactive' counts as the foreground there (src/sync/triggers.ts),
// and so does a state AppState doesn't know yet at launch ('unknown'), as T3 Code
// reads it.
export const appState: AppStateSource = {
    current: () => AppState.currentState ?? 'unknown',
    subscribe(listener) {
        const subscription = AppState.addEventListener('change', listener);
        return () => {
            subscription.remove();
        };
    },
};
