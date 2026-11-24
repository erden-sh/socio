import { StatusBar } from 'expo-status-bar';
import * as SystemUI from 'expo-system-ui';
import { useEffect } from 'react';

import { useScheme } from './scheme';
import { colorsOf } from './theme';

// The system's parts of the window follow the scheme, with the screens:
// the status bar's icons, and the root
// view's background behind every screen (expo-system-ui), which shows during
// transitions and the keyboard's animation. The splash follows the scheme by
// itself (app.config.ts), and the config sets the light root background the app
// starts with.

export function SystemBars() {
    const scheme = useScheme();
    const background = colorsOf(scheme).screen;
    useEffect(() => {
        SystemUI.setBackgroundColorAsync(background).catch((error: unknown) =>
            console.warn('[theme] setting the root background failed', error),
        );
    }, [background]);
    return <StatusBar style={scheme === 'dark' ? 'light' : 'dark'} />;
}
