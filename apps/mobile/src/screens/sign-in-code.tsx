import type { StaticScreenProps } from '@react-navigation/native';
import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator } from 'react-native';

import { formatCode } from '@socio/shared/device-sign-in';

import type { PendingCodeView } from '../data/code-flow';
import type { StagedLogo } from '../data/logo';
import {
    CODE_REQUEST_GONE,
    type CodeChannel,
    codeEmailHint,
    codeRefusal,
    codeRequestLine,
    codeSentLine,
    codeStepTitle,
    readCodeField,
    sendAgainLabel,
    sendAgainSeconds,
} from '../net/sign-in-codes';
import { codeFlow, listenForFilledCode, takeFilledCode } from '../platform/code-sign-in';
import { Banner, Button, Field, Screen, Text } from '../ui';

import type { ConfirmWorkspaceParams } from './confirm-workspace';
import { COMMIT_FAILED, settle, type Shown } from './sign-in';
import { WorkspaceHost } from './workspace-host';

// A sign-in code by email or Telegram, from SignIn's "Email me a code" or "Send a code
// to my Telegram" (with the workspace in its params), or opened by the code's link after a kill (no
// params: the pending request names the workspace). Two steps:
// - the email, then Send code: a fresh request (src/data/code-flow.ts). Nothing on the screen says
//   whether the email has an account: the server answers the same either way.
// - "Enter the code we sent to your email" (or "…to your Telegram"): the field takes the code with
//   or without its dash, pasted or typed (`readCodeField`); the code's link fills it in. Sign in
//   redeems and commits as the password form does (`settle`: the same another-person question),
//   with the codes' own words for each refusal (`codeRefusal`). A dead request (expired, its 5 tries
//   used, another build's, its channel changed, the method off) goes back to the email with its line.
//   Send again waits a minute after each send; "Use another email" starts over.
// The code is in the field and the redeem's body only: never in params, a log or a problem.

export type SignInCodeParams =
    | (ConfirmWorkspaceParams & {
          /** The manifest's channel for codes. */
          readonly channel: CodeChannel;
      })
    | undefined;

const MASCOT: StagedLogo = { kind: 'mascot' };

type Phase = 'loading' | 'email' | 'code' | 'gone';

const hostOf = (origin: string) => {
    try {
        return new URL(origin).host;
    } catch {
        return origin;
    }
};

export function SignInCodeScreen({ route }: StaticScreenProps<SignInCodeParams>) {
    const params = route.params;
    const [phase, setPhase] = useState<Phase>('loading');
    const [pending, setPending] = useState<PendingCodeView | null>(null);
    /** The workspace a link's pending request named (no params), kept when the request goes. */
    const [held, setHeld] = useState<{ origin: string; name: string; channel: CodeChannel } | null>(null);
    const [email, setEmail] = useState('');
    const [codeText, setCodeText] = useState('');
    const [busy, setBusy] = useState(false);
    const [shown, setShown] = useState<Shown | null>(null);
    const [now, setNow] = useState(() => Date.now());
    const mounted = useRef(true);

    const origin = params?.origin ?? held?.origin ?? null;
    const name = params?.name ?? held?.name ?? '';
    const channel: CodeChannel = pending?.channel ?? params?.channel ?? held?.channel ?? 'email';
    const logo = params?.logo ?? MASCOT;

    useEffect(() => {
        mounted.current = true;
        return () => {
            mounted.current = false;
        };
    }, []);

    // The pending request, if it is this workspace's (or, opened by a link, whichever it is), and a
    // code its link filled in.
    useEffect(() => {
        const given = params?.origin ?? null;
        codeFlow()
            .pending()
            .then(
                (found) => {
                    if (!mounted.current) {
                        return;
                    }
                    const mine = found !== null && (given === null || found.origin === given) ? found : null;
                    const filled = takeFilledCode();
                    if (mine !== null) {
                        setPending(mine);
                        setHeld({ origin: mine.origin, name: mine.name, channel: mine.channel });
                        setEmail(mine.email);
                        setPhase('code');
                        if (filled !== null) {
                            setCodeText(formatCode(filled));
                        }
                    } else {
                        setPhase(given === null ? 'gone' : 'email');
                    }
                },
                (error: unknown) => {
                    console.warn('[code] pending not read', error instanceof Error ? error.name : 'unknown');
                    if (mounted.current) {
                        setPhase(given === null ? 'gone' : 'email');
                    }
                },
            );
    }, [params?.origin]);

    // A code link while this screen shows fills the field in.
    useEffect(
        () =>
            listenForFilledCode(() => {
                const filled = takeFilledCode();
                if (filled !== null) {
                    setCodeText(formatCode(filled));
                    setShown(null);
                }
            }),
        [],
    );

    const waitSeconds = pending === null ? 0 : sendAgainSeconds(pending.sentAt, now);
    // The Send again countdown.
    useEffect(() => {
        if (phase !== 'code' || waitSeconds === 0) {
            return;
        }
        const timer = setInterval(() => setNow(Date.now()), 1000);
        return () => clearInterval(timer);
    }, [phase, waitSeconds]);

    const send = async (to: string) => {
        if (busy || origin === null || to.trim() === '') {
            return;
        }
        setBusy(true);
        setShown(null);
        let next: Shown | null = null;
        try {
            const sent = await codeFlow().send({ origin, name, email: to, channel });
            if (sent.kind === 'sent') {
                if (mounted.current) {
                    setPending(sent.pending);
                    setNow(Date.now());
                    setCodeText('');
                    setPhase('code');
                }
            } else {
                next = { line: codeRequestLine(sent.problem), detail: null, openWeb: false };
            }
        } catch (error) {
            console.warn('[code] not sent', error instanceof Error ? error.name : 'unknown');
            next = { line: COMMIT_FAILED, detail: null, openWeb: false };
        }
        if (mounted.current) {
            setBusy(false);
            setShown(next);
        }
    };

    const field = readCodeField(codeText);

    const signIn = async () => {
        if (busy || origin === null || field.code === null) {
            return;
        }
        setBusy(true);
        setShown(null);
        let next: Shown | null = null;
        let startOver = false;
        try {
            const redeemed = await codeFlow().redeem({ origin, typed: codeText, logo });
            if (redeemed.kind === 'no-request') {
                startOver = true;
                next = { line: CODE_REQUEST_GONE, detail: null, openWeb: false };
            } else if (redeemed.kind === 'outcome') {
                startOver = redeemed.startOver;
                next = await settle(redeemed.outcome, (problem) => codeRefusal(problem).line);
            }
        } catch (error) {
            console.warn('[code] sign-in failed', error instanceof Error ? error.name : 'unknown');
            next = { line: COMMIT_FAILED, detail: null, openWeb: false };
        }
        if (!mounted.current) {
            return;
        }
        setBusy(false);
        if (startOver) {
            setPending(null);
            setCodeText('');
            setPhase('email');
        }
        setShown(next !== null && next.line === '' ? null : next);
    };

    const anotherEmail = () => {
        if (busy) {
            return;
        }
        setShown(null);
        setPending(null);
        setCodeText('');
        setPhase('email');
        codeFlow()
            .clear()
            .catch((error: unknown) =>
                console.warn('[code] pending not cleared', error instanceof Error ? error.name : 'unknown'),
            );
    };

    return (
        <Screen testID="sign-in-code-screen" centered edges={['right', 'bottom', 'left']}>
            <Text accessibilityRole="header" variant="heading" className="text-center">
                {phase === 'code' ? codeStepTitle(channel) : name === '' ? 'Sign in' : `Sign in to ${name}`}
            </Text>
            {origin === null ? null : (
                <WorkspaceHost host={params?.host ?? hostOf(origin)} testID="sign-in-code-host" />
            )}
            {phase === 'loading' ? <ActivityIndicator accessibilityLabel="Loading" /> : null}
            {phase === 'gone' ? (
                <Banner tone="error" testID="sign-in-code-gone">
                    {CODE_REQUEST_GONE}
                </Banner>
            ) : null}
            {phase === 'email' ? (
                <>
                    <Field
                        label="Email"
                        hint={codeEmailHint(channel)}
                        value={email}
                        onChangeText={setEmail}
                        keyboardType="email-address"
                        autoCapitalize="none"
                        autoCorrect={false}
                        autoComplete="email"
                        textContentType="username"
                        returnKeyType="send"
                        onSubmitEditing={() => void send(email)}
                        editable={!busy}
                        testID="sign-in-code-email"
                    />
                    <Button
                        label="Send code"
                        onPress={() => void send(email)}
                        busy={busy}
                        disabled={email.trim() === ''}
                        testID="sign-in-code-send"
                    />
                </>
            ) : null}
            {phase === 'code' && pending !== null ? (
                <>
                    <Text variant="subheadline" tone="muted" className="text-center" testID="sign-in-code-sent">
                        {codeSentLine(channel, pending.email)}
                    </Text>
                    <Field
                        label="Code"
                        hint={field.hint === null ? 'Like ABCD-EFGH. With or without the dash.' : undefined}
                        error={field.hint ?? undefined}
                        value={codeText}
                        onChangeText={setCodeText}
                        autoCapitalize="characters"
                        autoCorrect={false}
                        autoComplete="one-time-code"
                        textContentType="oneTimeCode"
                        maxLength={24}
                        returnKeyType="go"
                        onSubmitEditing={() => void signIn()}
                        editable={!busy}
                        testID="sign-in-code-field"
                    />
                    <Button
                        label="Sign in"
                        onPress={() => void signIn()}
                        busy={busy}
                        disabled={field.code === null}
                        testID="sign-in-code-submit"
                    />
                    <Button
                        variant="secondary"
                        label={sendAgainLabel(waitSeconds)}
                        onPress={() => void send(pending.email)}
                        disabled={busy || waitSeconds > 0}
                        testID="sign-in-code-again"
                    />
                    <Button
                        variant="ghost"
                        label="Use another email"
                        onPress={anotherEmail}
                        disabled={busy}
                        testID="sign-in-code-another"
                    />
                </>
            ) : null}
            {shown === null ? null : (
                <Banner tone="error" testID="sign-in-code-problem">
                    {shown.line}
                </Banner>
            )}
            {shown?.detail == null ? null : (
                <Text variant="footnote" tone="muted" className="self-stretch" testID="sign-in-code-detail">
                    {shown.detail}
                </Text>
            )}
        </Screen>
    );
}
