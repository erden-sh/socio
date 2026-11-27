import { useEffect, useRef, useState } from 'react';
import { Alert, View } from 'react-native';

import type { SocialProvider, WorkspaceManifest } from '@socio/shared/device-sign-in';

import type { SocialLinkOutcome } from '../data/social-sign-in';
import { useWorkspaceScope } from '../live';
import { routeInVariant } from '../navigation/routes';
import type { AuthedFetch } from '../net/authed-fetch';
import { AbortedError } from '../net/errors';
import {
    LINK,
    LINKED,
    LINKS_UNREAD,
    NO_GOOGLE_ACCOUNT,
    nativeFailedLine,
    nativeUnavailableLine,
    NOT_LINKED,
    SIGN_IN_METHODS_NOTE,
    SIGN_IN_METHODS_TITLE,
    socialProblemLine,
    UNLINK,
    unlinkQuestion,
} from '../net/social-copy';
import {
    PROVIDER_NAMES,
    readSocialLinks,
    type SignInMethodRow,
    signInMethodRows,
    type SocialLinksRead,
    unlinkSocial,
} from '../net/social-sign-in';
import { readWorkspaceManifest } from '../platform/add-workspace';
import {
    showsTestAccount,
    socialBuildWith,
    socialLink,
    TEST_ACCOUNTS,
    testAccountOf,
} from '../platform/social-sign-in';
import { BUILD_VARIANT } from '../platform/variant';
import { Banner, Button, Field, ROW_INSET, RowSeparator, Text } from '../ui';

import { Section } from './shell-parts';

// Settings → Account's Sign-in methods (CB-570): Google and Apple, where the workspace offers them
// and this build can carry them out, and any already linked, each with its linked email (when the
// server has one) and Link or Unlink. Unlink asks first (Cancel the default). The links are read as
// the section shows and after every change; a change that ended this phone's own session (an
// unlink of the provider it signed in with) is met by that read's 401, which locks the copy as
// Ended. Every refusal is worded from social-copy.ts by its code; test builds add it under the line.

const TEST_BUILD = routeInVariant('Diagnostics', BUILD_VARIANT);

interface Problem {
    readonly line: string;
    readonly detail: string | null;
}

const detailOf = (status: number | null, code: string | null) => {
    const detail = [status === null ? null : `HTTP ${status}`, code].filter((part) => part !== null).join(' · ');
    return TEST_BUILD && detail !== '' ? detail : null;
};

function linkProblem(provider: SocialProvider, outcome: SocialLinkOutcome): Problem | null {
    switch (outcome.kind) {
        case 'linked':
        case 'cancelled':
            return null;
        case 'native': {
            const { failure } = outcome;
            const line =
                failure.kind === 'no-account'
                    ? NO_GOOGLE_ACCOUNT
                    : failure.kind === 'unavailable'
                      ? nativeUnavailableLine(provider)
                      : nativeFailedLine(provider);
            return { line, detail: TEST_BUILD && 'reason' in failure ? failure.reason : null };
        }
        case 'refused':
            return {
                line: socialProblemLine(provider, outcome.problem, 'link'),
                detail: detailOf(outcome.problem.status, outcome.problem.code),
            };
    }
}

/** Asks before an unlink; resolves true on Unlink. Cancel, back and a tap outside keep it. */
function confirmUnlink(provider: SocialProvider): Promise<boolean> {
    const question = unlinkQuestion(provider);
    return new Promise((resolve) => {
        Alert.alert(
            question.title,
            question.message,
            [
                { text: question.cancel, style: 'cancel', onPress: () => resolve(false) },
                { text: question.confirm, style: 'destructive', onPress: () => resolve(true) },
            ],
            { cancelable: true, onDismiss: () => resolve(false) },
        );
    });
}

/** Links `provider`; the problem to show, or null. Never rejects. */
async function linkNow(
    fetch: AuthedFetch,
    provider: SocialProvider,
    testAccount: string | null,
    signal: AbortSignal,
): Promise<Problem | null> {
    try {
        return linkProblem(provider, await socialLink(fetch, provider, testAccount, signal));
    } catch (error) {
        if (!(error instanceof AbortedError)) {
            console.warn('[settings] link failed', error instanceof Error ? error.name : 'unknown');
        }
        return null;
    }
}

/** Unlinks `provider`; the problem to show, or null. Never rejects. */
async function unlinkNow(fetch: AuthedFetch, provider: SocialProvider, signal: AbortSignal): Promise<Problem | null> {
    try {
        const done = await unlinkSocial(fetch, provider, signal);
        return done.ok
            ? null
            : {
                  line: socialProblemLine(provider, done.problem, 'unlink'),
                  detail: detailOf(done.problem.status, done.problem.code),
              };
    } catch (error) {
        if (!(error instanceof AbortedError)) {
            console.warn('[settings] unlink failed', error instanceof Error ? error.name : 'unknown');
        }
        return null;
    }
}

export function SignInMethodsSection() {
    const scope = useWorkspaceScope();
    const [manifest, setManifest] = useState<WorkspaceManifest | null>(null);
    const [links, setLinks] = useState<SocialLinksRead | null>(null);
    const [busy, setBusy] = useState<SocialProvider | null>(null);
    const [problem, setProblem] = useState<Problem | null>(null);
    const [testAccount, setTestAccount] = useState('');
    const alive = useRef(new AbortController());

    useEffect(() => {
        const controller = new AbortController();
        alive.current = controller;
        readWorkspaceManifest(scope.workspace.origin, controller.signal).then(
            (read) => {
                if (!controller.signal.aborted && read.kind === 'manifest') {
                    setManifest(read.manifest);
                }
            },
            () => undefined,
        );
        readSocialLinks(scope.fetch, controller.signal).then(
            (read) => {
                if (!controller.signal.aborted) {
                    setLinks(read);
                }
            },
            () => undefined,
        );
        return () => controller.abort();
    }, [scope]);

    const reread = async () => {
        const signal = alive.current.signal;
        // Also how this phone learns its own session ended with an unlink: the read's 401 locks it.
        const read = await readSocialLinks(scope.fetch, signal).catch(() => null);
        if (read !== null && !signal.aborted) {
            setLinks(read);
        }
    };

    if (links === null || links.kind === 'unsupported') {
        return null;
    }
    const rows = signInMethodRows(
        manifest,
        links.kind === 'links' ? links.links : [],
        socialBuildWith(testAccountOf(testAccount)),
    );
    if (rows.length === 0 && links.kind === 'links' && !showsTestAccount(manifest)) {
        return null;
    }

    const change = async (provider: SocialProvider, kind: 'link' | 'unlink') => {
        if (kind === 'unlink' && !(await confirmUnlink(provider))) {
            return;
        }
        setBusy(provider);
        setProblem(null);
        const signal = alive.current.signal;
        const next =
            kind === 'link'
                ? await linkNow(scope.fetch, provider, testAccountOf(testAccount), signal)
                : await unlinkNow(scope.fetch, provider, signal);
        if (!signal.aborted) {
            setProblem(next);
        }
        await reread();
        setBusy(null);
    };

    return (
        <Section title={SIGN_IN_METHODS_TITLE} testID="settings-sign-in-methods" footer={SIGN_IN_METHODS_NOTE}>
            {links.kind === 'failed' ? (
                <View className="p-3">
                    <Text variant="footnote" tone="muted" testID="settings-sign-in-methods-unread">
                        {LINKS_UNREAD}
                    </Text>
                </View>
            ) : null}
            {rows.map((row, index) => (
                <MethodRow
                    key={row.provider}
                    row={row}
                    first={index === 0 && links.kind !== 'failed'}
                    busy={busy === row.provider}
                    disabled={busy !== null && busy !== row.provider}
                    onLink={() => void change(row.provider, 'link')}
                    onUnlink={() => void change(row.provider, 'unlink')}
                />
            ))}
            {TEST_ACCOUNTS && showsTestAccount(manifest) ? (
                // Development builds only: a made-up account stands in for Google and Apple (e2e/fake-cloud.mjs).
                <View className="p-3">
                    <Field
                        label="Test account (development)"
                        hint="Leave empty for the phone's own Google or Apple sign-in."
                        value={testAccount}
                        onChangeText={setTestAccount}
                        autoCapitalize="none"
                        autoCorrect={false}
                        testID="settings-test-account"
                    />
                </View>
            ) : null}
            {problem === null ? null : (
                <View className="gap-1 p-3">
                    <Banner tone="error" testID="settings-sign-in-methods-problem">
                        {problem.line}
                    </Banner>
                    {problem.detail === null ? null : (
                        <Text variant="footnote" tone="muted" testID="settings-sign-in-methods-detail">
                            {problem.detail}
                        </Text>
                    )}
                </View>
            )}
        </Section>
    );
}

function MethodRow({
    row,
    first,
    busy,
    disabled,
    onLink,
    onUnlink,
}: {
    readonly row: SignInMethodRow;
    readonly first: boolean;
    readonly busy: boolean;
    readonly disabled: boolean;
    readonly onLink: () => void;
    readonly onUnlink: () => void;
}) {
    const name = PROVIDER_NAMES[row.provider];
    const line = row.link === null ? NOT_LINKED : (row.link.email ?? LINKED);
    return (
        <View
            className="flex-row items-center gap-3 p-3"
            style={{ minHeight: 56 }}
            testID={`settings-method-${row.provider}`}
        >
            {first ? null : <RowSeparator inset={ROW_INSET} />}
            <View
                accessible
                accessibilityLabel={`${name}, ${line}`}
                className="min-w-0 flex-1 gap-0.5"
                testID={`settings-method-${row.provider}-state`}
            >
                <Text>{name}</Text>
                <Text variant="footnote" tone="muted">
                    {line}
                </Text>
            </View>
            {row.link !== null ? (
                <Button
                    variant="secondary"
                    label={UNLINK}
                    accessibilityHint={`Unlinks ${name}`}
                    busy={busy}
                    disabled={disabled}
                    onPress={onUnlink}
                    testID={`settings-unlink-${row.provider}`}
                />
            ) : row.canLink ? (
                <Button
                    variant="secondary"
                    label={LINK}
                    accessibilityHint={`Links your ${name} account`}
                    busy={busy}
                    disabled={disabled}
                    onPress={onLink}
                    testID={`settings-link-${row.provider}`}
                />
            ) : null}
        </View>
    );
}
