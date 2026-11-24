import { View } from 'react-native';

import type { ColorToken } from '../theme/theme';

import { AppSymbol } from './app-symbol';
import { Button } from './button';
import { cx } from './cx';
import type { SymbolName } from './symbols';
import { Text, type TextTone } from './text';
import { useAnnouncement } from './use-announcement';

// A line about the screen's state, in the web's three looks: info is the web's
// notice above a chat (views/ChatViews.tsx: a border over muted/60), warning is
// the paused banner's surface, border and icon color (shell/AppShell.tsx), and
// error is the web's error line (bg-destructive/10 with text-destructive, as
// ChatError and the lists' errors). rounded-lg, p-3, text-sm, its icon at
// size-4. A warning's words are the foreground: the web's paused-banner words
// are 3:1 on its surface, an exception tests/theme/contrast.test.ts keeps for
// the web's 11 px paused line, not for a warning's sentence. An error is an
// alert to screen readers, as the web's role="alert": said when it appears and
// when it changes; the others are said when they change. That is a live region
// on Android and an announcement on iOS (use-announcement.ts), so its words
// are a string. It can carry one action, as ChatError does.

const TONES = {
    info: { box: 'border border-border bg-muted/60', text: 'default', icon: 'info', iconColor: 'muted-foreground' },
    warning: {
        box: 'border border-paused-banner-border bg-paused-banner',
        text: 'default',
        icon: 'triangle-alert',
        iconColor: 'paused-banner-foreground',
    },
    error: { box: 'bg-destructive/10', text: 'destructive', icon: 'circle-alert', iconColor: 'destructive' },
} as const satisfies Record<string, { box: string; text: TextTone; icon: SymbolName; iconColor: ColorToken }>;

export type BannerTone = keyof typeof TONES;

export interface BannerProps {
    readonly tone: BannerTone;
    /** Its words, which screen readers are told. */
    readonly children: string;
    readonly action?: { readonly label: string; readonly onPress: () => void };
    readonly testID?: string;
}

export function Banner({ tone, children, action, testID }: BannerProps) {
    const look = TONES[tone];
    useAnnouncement(children, { onAppear: tone === 'error' });
    return (
        <View
            testID={testID}
            accessibilityRole={tone === 'error' ? 'alert' : undefined}
            accessibilityLiveRegion={tone === 'error' ? 'assertive' : 'polite'}
            className={cx('flex-row items-center gap-3 self-stretch rounded-lg p-3', look.box)}
        >
            <AppSymbol name={look.icon} color={look.iconColor} />
            <Text tone={look.text} className="flex-1">
                {children}
            </Text>
            {action === undefined ? null : <Button variant="ghost" label={action.label} onPress={action.onPress} />}
        </View>
    );
}
