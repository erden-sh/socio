import { useNavigation } from '@react-navigation/native';
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { ActivityIndicator, type TextInputInstance } from 'react-native';

import type { InviteView } from '../data/invite';
import { rootState } from '../navigation/root-gate';
import { routeInVariant } from '../navigation/routes';
import {
    EMAIL_HINT,
    JOIN_LINE,
    joinQuestion,
    joinTitle,
    MAX_PASSWORD_LENGTH,
    PASSWORD_LINE,
    PASSWORD_SET_LINE,
    PASSWORD_TITLE,
} from '../net/invite';
import { otherPersonCopy } from '../net/sign-in-copy';
import { invite, inviteLinks } from '../platform/invite';
import { BUILD_VARIANT } from '../platform/variant';
import { Banner, Button, Field, Screen, Text } from '../ui';

import { WorkspaceHost } from './workspace-host';

// An invite, when the app was installed first (src/data/invite.ts): opened by the invite's
// link (links.ts `openRoute`, never by a path), so its token is in no param or navigation state.
// "Join Acme?" with the host where the probe ended (WorkspaceHost) and a warning when a workspace of
// that name is already on the device; Join opens the web's set-password form (the email, the
// password twice); then the sign-in and the gate. Leaving the screen drops the token and the
// password. The form's fields are this screen's state only, cleared once the password is sent.

const TEST_BUILD = routeInVariant('Diagnostics', BUILD_VARIANT);

export function InviteScreen() {
    const navigation = useNavigation();
    const view = useSyncExternalStore(invite.subscribe, invite.view);

    // The link the gate held, and any that comes while this screen shows; leaving drops the token.
    useEffect(() => {
        const take = () => {
            const link = inviteLinks.take();
            if (link !== null) {
                invite.start(link);
            }
        };
        take();
        const stop = inviteLinks.listen(take);
        return () => {
            stop();
            invite.leave();
        };
    }, []);

    const close = () => {
        invite.leave();
        if (navigation.canGoBack()) {
            navigation.goBack();
        } else {
            rootState.setAdding(false);
        }
    };

    return (
        <Screen testID="invite-screen" centered edges={['right', 'bottom', 'left']}>
            <Body view={view} close={close} />
        </Screen>
    );
}

function Title({ children, label }: { children: string; label?: string }) {
    return (
        <Text
            accessibilityRole="header"
            accessibilityLabel={label}
            variant="heading"

            className="text-center"
            testID="invite-title"
        >
            {children}
        </Text>
    );
}

function Problem({ line, detail }: { line: string | null; detail: string | null }) {
    if (line === null) {
        return null;
    }
    return (
        <>
            <Banner tone="error" testID="invite-problem">
                {line}
            </Banner>
            {TEST_BUILD && detail !== null ? (
                <Text variant="footnote" tone="muted" className="self-stretch" testID="invite-detail">
                    {detail}
                </Text>
            ) : null}
        </>
    );
}

function Body({ view, close }: { view: InviteView; close: () => void }) {
    const cancel = <Button variant="ghost" label="Cancel" onPress={close} testID="invite-cancel" />;
    switch (view.step) {
        case 'idle':
        case 'checking':
            return (
                <>
                    <Title>Checking your invite</Title>
                    {view.step === 'checking' ? <WorkspaceHost host={view.host} testID="invite-host" /> : null}
                    <ActivityIndicator accessibilityLabel="Checking the workspace" testID="invite-busy" />
                    {cancel}
                </>
            );
        case 'refused':
            return (
                <>
                    <Title>Can’t open this invite</Title>
                    <WorkspaceHost host={view.host} testID="invite-host" />
                    <Problem line={view.line} detail={view.detail} />
                    <Button variant="secondary" label="Close" onPress={close} testID="invite-close" />
                </>
            );
        case 'join':
            return (
                <>
                    <Title label={joinQuestion(view.name, view.host)}>{joinTitle(view.name)}</Title>
                    <WorkspaceHost host={view.host} testID="invite-host" />
                    <Text variant="callout" tone="muted" className="text-center" testID="invite-line">
                        {JOIN_LINE}
                    </Text>
                    {view.warning === null ? null : (
                        <Banner tone="warning" testID="invite-same-name">
                            {view.warning}
                        </Banner>
                    )}
                    <Button label="Join" onPress={() => invite.join()} testID="invite-join" />
                    {cancel}
                </>
            );
        case 'password':
            return <PasswordForm view={view} close={close} />;
        case 'sign-in':
            return <SignInAgain view={view} close={close} />;
        case 'signing-in':
            return (
                <>
                    <Title>{`Joining ${view.name}`}</Title>
                    <WorkspaceHost host={view.host} testID="invite-host" />
                    <ActivityIndicator accessibilityLabel="Signing in" testID="invite-busy" />
                </>
            );
        case 'commit-question': {
            const copy = otherPersonCopy(view.unsent);
            return (
                <>
                    <Title>{copy.title}</Title>
                    <WorkspaceHost host={view.host} testID="invite-host" />
                    <Text variant="subheadline" tone="muted" className="text-center">
                        {copy.message}
                    </Text>
                    {/* Cancel is the default: first, and the primary button. */}
                    <Button
                        label={copy.cancel}
                        onPress={() => invite.answerCommit(false)}
                        testID="invite-commit-cancel"
                    />
                    <Button
                        variant="destructive"
                        label={copy.confirm}
                        onPress={() => invite.answerCommit(true)}
                        testID="invite-commit-confirm"
                    />
                </>
            );
        }
        case 'signed-in':
            return <ActivityIndicator accessibilityLabel="Signed in" testID="invite-busy" />;
        case 'ended':
            return (
                <>
                    <Title>{view.name === '' ? 'Can’t open this invite' : `Join ${view.name}`}</Title>
                    <WorkspaceHost host={view.host} testID="invite-host" />
                    <Problem line={view.line} detail={null} />
                    <Button variant="secondary" label="Close" onPress={close} testID="invite-close" />
                </>
            );
    }
}

function PasswordForm({ view, close }: { view: Extract<InviteView, { step: 'password' }>; close: () => void }) {
    const [email, setEmail] = useState('');
    const [password, setPassword] = useState('');
    const [repeat, setRepeat] = useState('');
    const passwordField = useRef<TextInputInstance>(null);
    const repeatField = useRef<TextInputInstance>(null);
    const submit = () => invite.submit({ email, password, repeat });
    return (
        <>
            <Title>{PASSWORD_TITLE}</Title>
            <WorkspaceHost host={view.host} testID="invite-host" />
            <Text variant="subheadline" tone="muted" className="text-center" testID="invite-password-line">
                {PASSWORD_LINE}
            </Text>
            <Field
                label="Email"
                hint={EMAIL_HINT}
                value={email}
                onChangeText={setEmail}
                keyboardType="email-address"
                autoCapitalize="none"
                autoCorrect={false}
                autoComplete="email"
                textContentType="username"
                returnKeyType="next"
                submitBehavior="submit"
                onSubmitEditing={() => passwordField.current?.focus()}
                editable={!view.busy}
                testID="invite-email"
            />
            <Field
                ref={passwordField}
                label="New password"
                value={password}
                onChangeText={setPassword}
                secureTextEntry
                autoCapitalize="none"
                autoCorrect={false}
                autoComplete="new-password"
                textContentType="newPassword"
                maxLength={MAX_PASSWORD_LENGTH}
                returnKeyType="next"
                submitBehavior="submit"
                onSubmitEditing={() => repeatField.current?.focus()}
                editable={!view.busy}
                testID="invite-password"
            />
            <Field
                ref={repeatField}
                label="Repeat the password"
                value={repeat}
                onChangeText={setRepeat}
                secureTextEntry
                autoCapitalize="none"
                autoCorrect={false}
                autoComplete="new-password"
                textContentType="newPassword"
                maxLength={MAX_PASSWORD_LENGTH}
                returnKeyType="go"
                onSubmitEditing={submit}
                editable={!view.busy}
                testID="invite-repeat"
            />
            <Problem line={view.line} detail={view.detail} />
            <Button
                label="Set password and join"
                onPress={submit}
                busy={view.busy}
                disabled={email.trim() === '' || password === '' || repeat === ''}
                testID="invite-submit"
            />
            {view.busy ? null : <Button variant="ghost" label="Cancel" onPress={close} testID="invite-cancel" />}
        </>
    );
}

function SignInAgain({ view, close }: { view: Extract<InviteView, { step: 'sign-in' }>; close: () => void }) {
    const [email, setEmail] = useState(view.email);
    return (
        <>
            <Title>{`Join ${view.name}`}</Title>
            <WorkspaceHost host={view.host} testID="invite-host" />
            <Text variant="subheadline" tone="muted" className="text-center">
                {PASSWORD_SET_LINE}
            </Text>
            <Field
                label="Email"
                hint={EMAIL_HINT}
                value={email}
                onChangeText={setEmail}
                keyboardType="email-address"
                autoCapitalize="none"
                autoCorrect={false}
                autoComplete="email"
                textContentType="username"
                returnKeyType="go"
                onSubmitEditing={() => invite.signIn(email)}
                testID="invite-sign-in-email"
            />
            <Problem line={view.line} detail={view.detail} />
            <Button
                label="Sign in"
                onPress={() => invite.signIn(email)}
                disabled={email.trim() === ''}
                testID="invite-sign-in"
            />
            <Button variant="ghost" label="Cancel" onPress={close} testID="invite-cancel" />
        </>
    );
}
