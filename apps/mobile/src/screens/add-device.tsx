import { useNavigation } from '@react-navigation/native';
import { useEffect, useState, useSyncExternalStore } from 'react';
import { ActivityIndicator } from 'react-native';

import type { AddDeviceView } from '../data/add-device';
import { rootState } from '../navigation/root-gate';
import { routeInVariant } from '../navigation/routes';
import {
    ADD_DEVICE_LINE,
    ADD_DEVICE_TITLE,
    countdownLabel,
    DIGITS_INSTRUCTION,
    otherAccountLine,
    otherAccountQuestion,
    secondsLeft,
    shownDigits,
    signInAsQuestion,
    STILL_TRYING,
} from '../net/add-device';
import { otherPersonCopy } from '../net/sign-in-copy';
import { addDevice, listenForDeviceLink, takeDeviceLink } from '../platform/add-device';
import { BUILD_VARIANT } from '../platform/variant';
import { Banner, Button, Screen, Text } from '../ui';

import { WorkspaceHost } from './workspace-host';

// Add a device, on the new device (src/data/add-device.ts): opened by the QR code's link
// (links.ts `openRoute`, never by a path), so nothing of the link is in params or the navigation
// state. "Sign in on this device" with the workspace's name and host; Continue claims; then, when
// this device holds the workspace as someone else, that question with Cancel the default; then
// "Sign in to Acme as <name> (<email>)?", the 6 digits, large, "Type this code on your computer to
// sign in" and the 2-minute countdown. Leaving the screen stops polling and drops the claim. The
// digits are drawn from the view only, never kept in state of this screen.

const TEST_BUILD = routeInVariant('Diagnostics', BUILD_VARIANT);

/** The countdown's figures keep one width as they tick. */
const TABULAR = { fontVariant: ['tabular-nums' as const] };

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
        const timer = setInterval(() => setNow(Date.now()), 1000);
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

    return (
        <Screen testID="add-device-screen" centered edges={['right', 'bottom', 'left']}>
            <Body view={view} now={now} close={close} />
        </Screen>
    );
}

function Title({ children }: { children: string }) {
    return (
        <Text accessibilityRole="header" variant="heading" className="text-center">
            {children}
        </Text>
    );
}

function Body({ view, now, close }: { view: AddDeviceView; now: number; close: () => void }) {
    const cancel = <Button variant="ghost" label="Cancel" onPress={close} testID="add-device-cancel" />;
    switch (view.step) {
        case 'idle':
        case 'checking':
            return (
                <>
                    <Title>{ADD_DEVICE_TITLE}</Title>
                    {view.step === 'checking' ? <WorkspaceHost host={view.host} testID="add-device-host" /> : null}
                    <ActivityIndicator accessibilityLabel="Checking the workspace" testID="add-device-busy" />
                    {cancel}
                </>
            );
        case 'refused':
            return (
                <>
                    <Title>{ADD_DEVICE_TITLE}</Title>
                    <WorkspaceHost host={view.host} testID="add-device-host" />
                    <Banner tone="error" testID="add-device-problem">
                        {view.line}
                    </Banner>
                    {TEST_BUILD && view.detail !== null ? (
                        <Text variant="footnote" tone="muted" testID="add-device-detail">
                            {view.detail}
                        </Text>
                    ) : null}
                    <Button variant="secondary" label="Close" onPress={close} testID="add-device-close" />
                </>
            );
        case 'confirm':
        case 'claiming':
            return (
                <>
                    <Title>{ADD_DEVICE_TITLE}</Title>
                    <Text variant="title3" weight="semibold" className="text-center" testID="add-device-name">
                        {view.name}
                    </Text>
                    <WorkspaceHost host={view.host} testID="add-device-host" />
                    <Text variant="subheadline" tone="muted" className="text-center">
                        {ADD_DEVICE_LINE}
                    </Text>
                    <Button
                        label="Continue"
                        onPress={() => addDevice.continue()}
                        busy={view.step === 'claiming'}
                        testID="add-device-continue"
                    />
                    {cancel}
                </>
            );
        case 'other-account':
            return (
                <>
                    <Title>{otherAccountQuestion(view.name, view.current, view.next)}</Title>
                    <WorkspaceHost host={view.host} testID="add-device-host" />
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
            const seconds = secondsLeft(view.deadline, now);
            return (
                <>
                    <Title>{signInAsQuestion(view.name, view.account)}</Title>
                    <WorkspaceHost host={view.host} testID="add-device-host" />
                    <Text
                        weight="semibold"
                        mono
                        className="text-center"
                        accessibilityLabel={view.digits.split('').join(' ')}
                        testID="add-device-digits"
                    >
                        {shownDigits(view.digits)}
                    </Text>
                    <Text variant="callout" className="text-center" testID="add-device-instruction">
                        {DIGITS_INSTRUCTION}
                    </Text>
                    <Text
                        variant="subheadline"
                        tone="muted"
                        className="text-center"
                        style={TABULAR}
                        testID="add-device-countdown"
                    >
                        {countdownLabel(seconds)}
                    </Text>
                    {view.reaching ? null : (
                        <Text variant="subheadline" tone="muted" className="text-center" testID="add-device-reaching">
                            {STILL_TRYING}
                        </Text>
                    )}
                    {cancel}
                </>
            );
        }
        case 'signing-in':
            return (
                <>
                    <Title>{`Signing in to ${view.name}`}</Title>
                    <WorkspaceHost host={view.host} testID="add-device-host" />
                    <ActivityIndicator accessibilityLabel="Signing in" testID="add-device-busy" />
                </>
            );
        case 'commit-question': {
            const copy = otherPersonCopy(view.unsent);
            return (
                <>
                    <Title>{copy.title}</Title>
                    <WorkspaceHost host={view.host} testID="add-device-host" />
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
        case 'ended':
            return (
                <>
                    <Title>{ADD_DEVICE_TITLE}</Title>
                    <WorkspaceHost host={view.host} testID="add-device-host" />
                    <Banner tone="error" testID="add-device-problem">
                        {view.line}
                    </Banner>
                    <Button variant="secondary" label="Close" onPress={close} testID="add-device-close" />
                </>
            );
    }
}
