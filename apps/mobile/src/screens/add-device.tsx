import { useNavigation } from '@react-navigation/native';
import { useEffect, useState, useSyncExternalStore } from 'react';
import { ActivityIndicator, useWindowDimensions, View } from 'react-native';

import type { AddDeviceView } from '../data/add-device';
import { useNativeBar } from '../navigation/native-bar';
import { rootState } from '../navigation/root-gate';
import { routeInVariant } from '../navigation/routes';
import {
    ADD_DEVICE_LINE,
    ADD_DEVICE_TITLE,
    type Countdown,
    DIGITS_INSTRUCTION,
    digitsLook,
    type DigitsLook,
    endLook,
    NOT_SIGNED_IN_TITLE,
    otherAccountLine,
    otherAccountQuestion,
} from '../net/add-device';
import { otherPersonCopy } from '../net/sign-in-copy';
import { addDevice, keptLogoPath, listenForDeviceLink, takeDeviceLink } from '../platform/add-device';
import { BUILD_VARIANT } from '../platform/variant';
import { AppSymbol, Banner, Button, Screen, stacksAccessory, Text } from '../ui';
import type { SymbolName } from '../ui/symbols';

import { WorkspaceHost } from './workspace-host';
import { WorkspaceLogo } from './workspace-logo';

// Add a device, on the new device (src/data/add-device.ts): opened by the QR code's link
// (links.ts `openRoute`, never by a path), so nothing of the link is in params or the navigation
// state. "Sign in on this device" with the workspace's logo, name and host; Continue claims; then,
// when this device holds the workspace as someone else, that question with Cancel the default; then
// the code (CB-568): "On your computer, type this code" over the 6 digits, large, in two groups, who
// signs in on one quiet line, the claim's 2 minutes as a bar and words, and whether polls get an
// answer. Its 2 minutes up, the digits go and "This code expired" says how to start again. The bar's
// Cancel is the one way out while the claim lives (no Back chevron or swipe); an ended claim has its
// Close. Leaving the screen stops polling and drops the claim. The digits are drawn from the view
// only, never kept in state of this screen, and never copied to the clipboard.

const TEST_BUILD = routeInVariant('Diagnostics', BUILD_VARIANT);

/** The countdown's figures keep one width as they tick. */
const TABULAR = { fontVariant: ['tabular-nums' as const] };
/** The digits' own spacing, so the six read as two groups at a glance. */
const DIGITS_SPACING = { letterSpacing: 4 };
/** How often the countdown's bar moves (the words change once a second). */
const TICK_MS = 250;

export function AddDeviceScreen() {
    const navigation = useNavigation();
    const view = useSyncExternalStore(addDevice.subscribe, addDevice.view);
    const [now, setNow] = useState(() => Date.now());

    // The link the gate held, and any that comes while this screen shows; leaving drops the claim.
    useEffect(() => {
        const take = () => {
            const link = takeDeviceLink();
            if (link !== null) {
                addDevice.start(link);
            }
        };
        take();
        const stop = listenForDeviceLink(take);
        return () => {
            stop();
            addDevice.leave();
        };
    }, []);

    const counting = view.step === 'digits';
    // The countdown.
    useEffect(() => {
        if (!counting) {
            return;
        }
        setNow(Date.now());
        const timer = setInterval(() => setNow(Date.now()), TICK_MS);
        return () => clearInterval(timer);
    }, [counting]);

    const close = () => {
        addDevice.leave();
        if (navigation.canGoBack()) {
            navigation.goBack();
        } else {
            rootState.setAdding(false);
        }
    };

    // One way out: Cancel in the bar while there is something to cancel; an end has its own Close,
    // and a sign-in being committed has none. No Back chevron or swipe beside it.
    const cancels = barCancels(view, now);
    useNativeBar({
        title: '',
        back: false,
        left: cancels ? [{ id: 'add-device-cancel', label: 'Cancel', onPress: close }] : [],
    });

    return (
        // Keyed by the step, so each step opens at its top: at the largest text sizes Continue sits
        // a scroll down, and the code would otherwise open scrolled past its first lines.
        <Screen key={view.step} testID="add-device-screen" centered edges={['right', 'bottom', 'left']}>
            <Body view={view} now={now} close={close} />
        </Screen>
    );
}

/** Whether the bar shows Cancel: before the claim, the question and the live digits. */
function barCancels(view: AddDeviceView, now: number): boolean {
    switch (view.step) {
        case 'idle':
        case 'checking':
        case 'confirm':
        case 'claiming':
        case 'other-account':
            return true;
        case 'digits':
            return digitsLook(view, now).kind === 'code';
        default:
            return false;
    }
}

function Title({ children }: { children: string }) {
    return (
        <Text accessibilityRole="header" variant="heading" className="text-center" testID="add-device-title">
            {children}
        </Text>
    );
}

/** The workspace: its logo (the one the device keeps, else the mascot), its name and its host. */
function Workspace({ host, name }: { host: string; name: string | null }) {
    const [logo, setLogo] = useState<string | null>(null);
    useEffect(() => {
        let live = true;
        keptLogoPath(host).then(
            (path) => {
                if (live) {
                    setLogo(path);
                }
            },
            () => undefined,
        );
        return () => {
            live = false;
        };
    }, [host]);
    return (
        <View className="items-center gap-1 self-stretch">
            <View className="mb-2" importantForAccessibility="no-hide-descendants" accessibilityElementsHidden>
                <WorkspaceLogo path={logo} size={64} />
            </View>
            {name === null || name === '' ? null : (
                <Text variant="title3" weight="semibold" className="text-center" testID="add-device-name">
                    {name}
                </Text>
            )}
            <WorkspaceHost host={host} testID="add-device-host" />
        </View>
    );
}

/** An end: a symbol in its tone, the title, what happened, and Close. */
function Outcome({
    symbol,
    tone,
    title,
    line,
    detail,
    close,
}: {
    symbol: SymbolName;
    tone: 'muted-foreground' | 'destructive';
    title: string;
    line: string;
    detail: string | null;
    close: () => void;
}) {
    return (
        <>
            <View
                className={tone === 'destructive' ? 'rounded-full bg-destructive/10 p-4' : 'rounded-full bg-muted p-4'}
                importantForAccessibility="no-hide-descendants"
                accessibilityElementsHidden
            >
                <AppSymbol name={symbol} size={32} color={tone} />
            </View>
            <Title>{title}</Title>
            <Text
                variant="callout"
                tone="muted"
                className="text-center"
                accessibilityRole="alert"
                accessibilityLiveRegion="polite"
                testID="add-device-problem"
            >
                {line}
            </Text>
            {TEST_BUILD && detail !== null ? (
                <Text variant="footnote" tone="muted" testID="add-device-detail">
                    {detail}
                </Text>
            ) : null}
            <Button variant="secondary" label="Close" onPress={close} testID="add-device-close" />
        </>
    );
}

function Body({ view, now, close }: { view: AddDeviceView; now: number; close: () => void }) {
    switch (view.step) {
        case 'idle':
        case 'checking':
            return (
                <>
                    <Title>{ADD_DEVICE_TITLE}</Title>
                    {view.step === 'checking' ? <WorkspaceHost host={view.host} testID="add-device-host" /> : null}
                    <ActivityIndicator accessibilityLabel="Checking the workspace" testID="add-device-busy" />
                </>
            );
        case 'refused':
            return (
                <>
                    <WorkspaceHost host={view.host} testID="add-device-host" />
                    <Outcome
                        symbol="circle-alert"
                        tone="destructive"
                        title={NOT_SIGNED_IN_TITLE}
                        line={view.line}
                        detail={view.detail}
                        close={close}
                    />
                </>
            );
        case 'confirm':
        case 'claiming':
            return (
                <>
                    <Workspace host={view.host} name={view.name} />
                    <Title>{ADD_DEVICE_TITLE}</Title>
                    <Text variant="subheadline" tone="muted" className="text-center">
                        {ADD_DEVICE_LINE}
                    </Text>
                    <Button
                        label="Continue"
                        onPress={() => addDevice.continue()}
                        busy={view.step === 'claiming'}
                        testID="add-device-continue"
                    />
                </>
            );
        case 'other-account':
            return (
                <>
                    <Workspace host={view.host} name={view.name} />
                    <Title>{otherAccountQuestion(view.name, view.current, view.next)}</Title>
                    <Text variant="subheadline" tone="muted" className="text-center" testID="add-device-other-line">
                        {otherAccountLine(view.unsent)}
                    </Text>
                    {/* Cancel is the default: first, and the primary button. */}
                    <Button label="Cancel" onPress={close} testID="add-device-other-cancel" />
                    <Button
                        variant="destructive"
                        label={`Sign in as ${view.next}`}
                        onPress={() => addDevice.switchAccount()}
                        testID="add-device-other-switch"
                    />
                </>
            );
        case 'digits': {
            const look = digitsLook(view, now);
            if (look.kind === 'expired') {
                // The claim's 2 minutes are up by this device's clock: the digits are gone at once,
                // and the poll ends the claim on its next turn (with the same words).
                return (
                    <>
                        <Workspace host={view.host} name={view.name} />
                        <Outcome
                            symbol="hourglass"
                            tone="muted-foreground"
                            title={look.title}
                            line={look.line}
                            detail={null}
                            close={close}
                        />
                    </>
                );
            }
            return <Digits view={view} look={look} />;
        }
        case 'signing-in':
            return (
                <>
                    <Workspace host={view.host} name={view.name} />
                    <Title>{`Signing in to ${view.name}`}</Title>
                    <ActivityIndicator accessibilityLabel="Signing in" testID="add-device-busy" />
                </>
            );
        case 'commit-question': {
            const copy = otherPersonCopy(view.unsent);
            return (
                <>
                    <Workspace host={view.host} name={view.name} />
                    <Title>{copy.title}</Title>
                    <Text variant="subheadline" tone="muted" className="text-center">
                        {copy.message}
                    </Text>
                    <Button
                        label={copy.cancel}
                        onPress={() => addDevice.answerCommit(false)}
                        testID="add-device-commit-cancel"
                    />
                    <Button
                        variant="destructive"
                        label={copy.confirm}
                        onPress={() => addDevice.answerCommit(true)}
                        testID="add-device-commit-confirm"
                    />
                </>
            );
        }
        case 'signed-in':
            return <ActivityIndicator accessibilityLabel="Signed in" testID="add-device-busy" />;
        case 'ended': {
            const look = endLook(view.line);
            return (
                <>
                    <Workspace host={view.host} name={view.name} />
                    <Outcome
                        symbol={look.expired ? 'hourglass' : 'circle-alert'}
                        tone={look.expired ? 'muted-foreground' : 'destructive'}
                        title={look.title}
                        line={look.line}
                        detail={null}
                        close={close}
                    />
                </>
            );
        }
    }
}

/**
 * The live code. At the accessibility text sizes (`stacksAccessory`) the code comes first, right
 * under the bar, and who signs in follows it, so the digits never sit a few screens down; the
 * icons go over their words there instead of beside them.
 */
function Digits({
    view,
    look,
}: {
    view: Extract<AddDeviceView, { step: 'digits' }>;
    look: Extract<DigitsLook, { kind: 'code' }>;
}) {
    const large = stacksAccessory(useWindowDimensions().fontScale);
    const row = large
        ? 'items-center justify-center gap-2 self-stretch'
        : 'flex-row items-center justify-center gap-2 self-stretch';
    const identity = (
        <>
            <Workspace host={view.host} name={view.name} />
            <Title>{ADD_DEVICE_TITLE}</Title>
            <View className={row}>
                <AppSymbol name="user-round" size={16} color="muted-foreground" />
                <Text
                    variant="subheadline"
                    tone="muted"
                    className="shrink text-center"
                    accessibilityLabel={look.accountLabel}
                    testID="add-device-account"
                >
                    {look.account}
                </Text>
            </View>
        </>
    );
    const code = (
        <>
            <View className={large ? 'items-center gap-3 self-stretch' : 'mt-2 items-center gap-3 self-stretch'}>
                <Text variant="headline" className="text-center" testID="add-device-instruction">
                    {DIGITS_INSTRUCTION}
                </Text>
                <Code shown={look.shown} label={look.label} />
                <CountdownBar countdown={look.countdown} />
            </View>
            {look.status.kind === 'waiting' ? (
                <View className={row} accessible accessibilityLabel={look.status.line} testID="add-device-waiting">
                    <ActivityIndicator size="small" />
                    <Text variant="subheadline" tone="muted" className="text-center">
                        {look.status.line}
                    </Text>
                </View>
            ) : (
                <Banner tone="warning" testID="add-device-reaching">
                    {look.status.line}
                </Banner>
            )}
        </>
    );
    return large ? (
        <>
            {code}
            {identity}
        </>
    ) : (
        <>
            {identity}
            {code}
        </>
    );
}

/**
 * The 6 digits, the screen's hero: large, monospaced, in two groups of three, one line that shrinks
 * to fit rather than wrap at the largest text sizes. A screen reader says them one by one. No copy:
 * they are typed on the computer, and a copy here would outlive the claim on the clipboard.
 */
function Code({ shown, label }: { shown: string; label: string }) {
    return (
        <View className="self-stretch rounded-2xl bg-muted px-4 py-5">
            <Text
                variant="title"
                weight="semibold"
                mono
                numberOfLines={1}
                adjustsFontSizeToFit
                className="text-center"
                style={DIGITS_SPACING}
                accessibilityLabel={label}
                testID="add-device-digits"
            >
                {shown}
            </Text>
        </View>
    );
}

/** The claim's time left: a thin bar that empties, and its words; the warning color near the end. */
function CountdownBar({ countdown }: { countdown: Countdown }) {
    const percent: `${number}%` = `${Math.round(countdown.fraction * 1000) / 10}%`;
    return (
        <View className="items-center gap-2 self-stretch">
            <View
                className="h-1.5 self-stretch overflow-hidden rounded-full bg-muted"
                importantForAccessibility="no-hide-descendants"
                accessibilityElementsHidden
                testID="add-device-progress"
            >
                <View
                    className={
                        countdown.urgent ? 'h-full rounded-full bg-destructive' : 'h-full rounded-full bg-primary'
                    }
                    style={{ width: percent }}
                />
            </View>
            <Text
                variant="footnote"
                tone={countdown.urgent ? 'destructive' : 'muted'}
                className="text-center"
                style={TABULAR}
                accessibilityLabel={countdown.spoken}
                testID="add-device-countdown"
            >
                {countdown.label}
            </Text>
        </View>
    );
}
