import { type ReactNode, useEffect, useState } from 'react';
import { View } from 'react-native';

import { addBackgroundGraceListener, holdBackgroundGrace } from '../../modules/socio-device';
import { useHasWorkspaceScope, useWorkspaceScope } from '../live';
import { BUILD_INFO } from '../platform/build-info';
import { randomBytes } from '../platform/crypto';
import { launchedStore } from '../platform/device-store';
import {
    checkPush,
    checkStoreFiles,
    type ContainerEntry,
    type FileCheck,
    deletePushCheckKey,
    listContainer,
    type PlantedFile,
    plantTestFiles,
    PUSH_CHECK_FILE,
    PUSH_CHECK_ID,
    type PushCheck,
    runScratchStore,
    type ScratchRun,
} from '../platform/diagnostics';
import type { Launched } from '../platform/launch';
import { askForNotifications } from '../platform/notification-ask';
import { originLine, versionLine } from '../shell/build-info';
import type { Outbox } from '../sync/outbox';
import { outboxTally, outboxTallyLine } from '../sync/outbox-tally';
import { Banner, Button, Screen, Text } from '../ui';

// The store's checks, in development and preview builds only (the route table
// leaves it out of production): every file's cipher_status and cipher_version
// and its header, both open times from a scratch store (early timing data),
// the app's whole container, and test files for the sign-out wipe. It runs
// the checks when it opens, scratch store first so nothing else runs during
// its timings, and logs a summary for the device checks. At the top, the
// open workspace's outbox rows counted by state (perf/kill-send.mjs reads
// that line after a run: every row, not just the bubbles on screen).

/** One result or why it isn't there. */
type Outcome<T> = { readonly ok: T } | { readonly problem: string };

interface Report {
    readonly scratch: Outcome<ScratchRun>;
    readonly files: Outcome<readonly FileCheck[]>;
    readonly container: Outcome<{ entries: ContainerEntry[]; complete: boolean }>;
    readonly hasWorkspace: boolean;
}

const clock = () => performance.now();

async function outcome<T>(work: () => Promise<T>): Promise<Outcome<T>> {
    try {
        return { ok: await work() };
    } catch (error) {
        return { problem: error instanceof Error ? `${error.name}: ${error.message}` : String(error) };
    }
}

async function collect(launched: Launched): Promise<Report> {
    const { store } = launched.opened;
    const scratch = await outcome(() => runScratchStore(store, randomBytes, clock));
    const files = await outcome(() => checkStoreFiles(store, clock));
    const container = await outcome(() => listContainer());
    const hasWorkspace = (await store.registry.active().catch(() => null)) !== null;
    console.log('[diagnostics]', JSON.stringify({ launch: launchSummary(launched), scratch, files }));
    return { scratch, files, container, hasWorkspace };
}

function launchSummary(launched: Launched) {
    const { launch } = launched.opened;
    return { cell: launch.cell, tell: launch.tell, openStoreMs: ms(launched.openMs), waited: launched.waited };
}

const ms = (value: number) => Math.round(value * 10) / 10;

const HEADER_WORDS: Record<FileCheck['header'], string> = {
    encrypted: 'not SQLite’s (passes)',
    plain: 'SQLite format 3 (fails)',
    short: 'under 16 bytes (fails)',
    unreadable: 'unreadable (fails)',
};

export function DiagnosticsScreen() {
    const launched = launchedStore();
    const [run, setRun] = useState(0);
    const [report, setReport] = useState<Report | null>(null);
    const [planted, setPlanted] = useState<string | null>(null);
    const [protections, setProtections] = useState<readonly PlantedFile[]>([]);
    const [grace, setGrace] = useState<string | null>(null);
    useEffect(() => {
        if (launched === null) {
            return;
        }
        let live = true;
        setReport(null);
        collect(launched).then((next) => {
            if (live) {
                setReport(next);
            }
        });
        return () => {
            live = false;
        };
    }, [launched, run]);

    if (launched === null) {
        return (
            <Screen testID="diagnostics-screen" edges={['right', 'bottom', 'left']}>
                <Banner tone="error">The store isn’t open.</Banner>
            </Screen>
        );
    }

    const plant = () => {
        plantTestFiles(launched.opened.store).then(
            (files) => {
                setPlanted(files === null ? 'No active workspace.' : `Wrote ${files.length} files.`);
                setProtections(files ?? []);
                if (files !== null) {
                    console.log('[diagnostics] planted', JSON.stringify(files.map(plantedSummary)));
                }
            },
            (error: unknown) => setPlanted(error instanceof Error ? error.message : String(error)),
        );
    };
    // The background grace's simulator check: holds the outbox's background grace as a request in
    // flight would, until it runs out in the background or the app comes back.
    const holdGrace = () => {
        const started = Date.now();
        const say = (line: string) => {
            console.log('[grace]', line);
            setGrace(line);
        };
        const subscription = addBackgroundGraceListener((secondsLeft) => {
            subscription.remove();
            void holdBackgroundGrace(false);
            const held = Math.round((Date.now() - started) / 1000);
            say(`Ran out: told with ${secondsLeft.toFixed(1)} s left, ${held} s after holding.`);
        });
        holdBackgroundGrace(true).then(
            () => say(`Holding since ${new Date(started).toISOString()}: leave the app now.`),
            (error: unknown) => {
                subscription.remove();
                say(error instanceof Error ? error.message : String(error));
            },
        );
    };
    const summary = launchSummary(launched);

    return (
        <Screen testID="diagnostics-screen" edges={['right', 'bottom', 'left']}>
            {/* Which build this is (src/shell/build-info.ts), as Settings' footer says it. */}
            <View className="gap-0.5" testID="diagnostics-build">
                <Text variant="footnote" weight="medium" selectable>
                    {versionLine(BUILD_INFO)}
                </Text>
                {originLine(BUILD_INFO) === null ? null : (
                    <Text variant="footnote" tone="muted" selectable>
                        {originLine(BUILD_INFO)}
                    </Text>
                )}
            </View>
            <OutboxSection />
            <Section title="Scratch store" caption="socio/diagnostics/: made, closed, opened again, checked, deleted.">
                {report === null ? (
                    <Text variant="subheadline" tone="muted">
                        Running…
                    </Text>
                ) : 'problem' in report.scratch ? (
                    <Banner tone="error">{report.scratch.problem}</Banner>
                ) : (
                    <>
                        <Line testID="diagnostics-created">
                            First open: cache.db {ms(report.scratch.ok.created.cache)} ms, user.db{' '}
                            {ms(report.scratch.ok.created.user)} ms
                        </Line>
                        <Line testID="diagnostics-reopened">
                            Open again: cache.db {ms(report.scratch.ok.reopened.cache)} ms, user.db{' '}
                            {ms(report.scratch.ok.reopened.user)} ms
                        </Line>
                        {report.scratch.ok.files.map((file) => (
                            <FileLines key={file.label} file={file} />
                        ))}
                        <Line testID="diagnostics-scratch-deleted">
                            Deleted afterwards: {report.scratch.ok.deleted ? 'yes' : 'no'}
                        </Line>
                    </>
                )}
                <Button
                    variant="secondary"
                    label="Run again"
                    icon="rotate-ccw"
                    disabled={report === null}
                    onPress={() => setRun((count) => count + 1)}
                    testID="diagnostics-run"
                />
            </Section>

            <Section title="Store files" caption="Each opened again on a connection of its own.">
                <Line testID="diagnostics-launch">
                    Launch: {summary.cell}, openStore {summary.openStoreMs} ms
                    {summary.waited ? ', waited for protected data' : ''}
                    {summary.tell ? ', told the person' : ''}
                </Line>
                {report === null ? null : 'problem' in report.files ? (
                    <Banner tone="error">{report.files.problem}</Banner>
                ) : (
                    report.files.ok.map((file) => <FileLines key={file.label} file={file} />)
                )}
            </Section>

            <Section
                title="Test files"
                caption="Into the active workspace’s images/ and attachments/, for the sign-out wipe."
            >
                <Button
                    variant="secondary"
                    label="Plant test files"
                    icon="flask-conical"
                    disabled={report === null || !report.hasWorkspace}
                    onPress={plant}
                    testID="diagnostics-plant"
                />
                {report !== null && !report.hasWorkspace ? <Line>Needs a workspace: sign in first.</Line> : null}
                {planted === null ? null : <Line testID="diagnostics-planted">{planted}</Line>}
                {protections.map((file) => (
                    <Line key={file.path} testID="diagnostics-protection">
                        {plantedSummary(file)}
                    </Line>
                ))}
            </Section>

            <Section
                title="Background grace"
                caption="Holds the outbox’s background grace (iOS) as a send in flight would, until it runs out."
            >
                <Button
                    variant="secondary"
                    label="Hold the grace"
                    icon="hourglass"
                    onPress={holdGrace}
                    testID="diagnostics-grace"
                />
                {grace === null ? null : <Line testID="diagnostics-grace-result">{grace}</Line>}
            </Section>

            <PushSection />
            <NotificationAskSection />

            <Section title="Container" caption="Everything in the app’s container, with sizes in bytes.">
                {report === null ? null : 'problem' in report.container ? (
                    <Banner tone="error">{report.container.problem}</Banner>
                ) : (
                    <>
                        {report.container.ok.entries.map((entry) => (
                            <Line key={entry.path}>
                                {entry.path}
                                {entry.unreadable ? ' (could not be listed)' : ''}
                                {entry.size === null ? '' : `  ${entry.size}`}
                            </Line>
                        ))}
                        {report.container.ok.complete ? null : <Line>The listing stops here.</Line>}
                    </>
                )}
            </Section>
        </Screen>
    );
}

/**
 * socio-push: where its keychain items go, a scratch key for the
 * made-up id `diagnostics` read back (made on the first check), and the body in
 * PUSH_CHECK_FILE decrypted with it. No workspace's key is shown.
 */
/**
 * A room turn's trigger for the notification ask, as a room's composer calls it: the
 * explanation shows when the rules say so, else why not.
 */
function NotificationAskSection() {
    const [result, setResult] = useState<string | null>(null);
    const ask = () => {
        askForNotifications('room-turn').then(
            (decision) => setResult(decision.kind === 'ask' ? 'Asked' : `Not asked: ${decision.reason}`),
            (error: unknown) => setResult(error instanceof Error ? error.message : String(error)),
        );
    };
    return (
        <Section title="Notification ask" caption="Asks as a room message whose turn is still running would.">
            <Button
                variant="secondary"
                label="Ask about notifications"
                icon="bell"
                onPress={ask}
                testID="diagnostics-notification-ask"
            />
            {result === null ? null : <Line testID="diagnostics-notification-ask-result">{result}</Line>}
        </Section>
    );
}

function PushSection() {
    const [result, setResult] = useState<{ check: PushCheck } | { problem: string } | null>(null);
    const [busy, setBusy] = useState(false);
    const settle = (work: Promise<{ check: PushCheck } | { problem: string } | null>) => {
        setBusy(true);
        work.then(
            (next) => {
                setResult(next);
                setBusy(false);
                if (next !== null && 'check' in next) {
                    console.log('[diagnostics-push]', JSON.stringify(next.check));
                }
            },
            (error: unknown) => {
                setResult({ problem: error instanceof Error ? error.message : String(error) });
                setBusy(false);
            },
        );
    };
    return (
        <Section
            title="Push keys"
            caption={`A scratch key for “${PUSH_CHECK_ID}”, kept in the keychain; ${PUSH_CHECK_FILE} in Documents is decrypted with it.`}
        >
            <Button
                variant="secondary"
                label="Check push keys"
                icon="key-round"
                disabled={busy}
                onPress={() => settle(checkPush().then((check) => ({ check })))}
                testID="diagnostics-push"
            />
            {result === null ? null : 'problem' in result ? (
                <Banner tone="error">{result.problem}</Banner>
            ) : (
                <>
                    <Line testID="diagnostics-push-storage">
                        Keychain: {result.check.storage.keychainGroup ?? 'the app’s own group'}
                        {result.check.storage.shared ? ' (shared)' : ''}; inbox{' '}
                        {result.check.storage.inbox ? `${result.check.inboxFiles} files` : 'not in this build'}
                    </Line>
                    <Line testID="diagnostics-push-key">
                        {result.check.created ? 'Made now' : 'Kept from before'}: p256dh {result.check.keys.p256dh},
                        auth {result.check.keys.auth}
                    </Line>
                    {result.check.decrypted === null ? null : (
                        <Line testID="diagnostics-push-decrypted">
                            {'text' in result.check.decrypted
                                ? `Decrypted: ${result.check.decrypted.text}`
                                : `Didn’t decrypt: ${result.check.decrypted.problem}`}
                        </Line>
                    )}
                </>
            )}
            <Button
                variant="ghost"
                label="Delete the scratch key"
                disabled={busy}
                onPress={() => settle(deletePushCheckKey().then(() => null))}
                testID="diagnostics-push-delete"
            />
        </Section>
    );
}

/** The open workspace's outbox, counted by state as it changes: no row's content. */
function OutboxSection() {
    const open = useHasWorkspaceScope();
    return (
        <Section title="Outbox" caption="The open workspace’s rows by state, and the refused writes.">
            {open ? <OutboxTallyLine /> : <Line testID="diagnostics-outbox">No workspace open.</Line>}
        </Section>
    );
}

function OutboxTallyLine() {
    const { outbox } = useWorkspaceScope();
    const [line, setLine] = useState(() => tallyLine(outbox));
    useEffect(() => {
        const update = () => setLine(tallyLine(outbox));
        update();
        const offRows = outbox.subscribe(update);
        const offUnsent = outbox.onUnsent(update);
        return () => {
            offRows();
            offUnsent();
        };
    }, [outbox]);
    useEffect(() => {
        console.log('[diagnostics]', line);
    }, [line]);
    return <Line testID="diagnostics-outbox">{line}</Line>;
}

function tallyLine(outbox: Outbox): string {
    return outboxTallyLine(outboxTally(outbox.rows(), outbox.unsent().length));
}

/** A planted file's folder and protection class, nothing else of its path. */
function plantedSummary(file: PlantedFile): string {
    const parts = file.path.split('/');
    return `${parts.slice(-2).join('/')}: protection ${file.protection ?? 'none reported'}`;
}

function Section(props: { title: string; caption: string; children: ReactNode }) {
    return (
        <View className="gap-2">
            <Text accessibilityRole="header" variant="headline">
                {props.title}
            </Text>
            <Text variant="footnote" tone="muted">
                {props.caption}
            </Text>
            {props.children}
        </View>
    );
}

function Line(props: { children: ReactNode; testID?: string }) {
    return (
        <Text variant="footnote" testID={props.testID}>
            {props.children}
        </Text>
    );
}

function FileLines({ file }: { file: FileCheck }) {
    return (
        <Line testID={`diagnostics-file-${file.label}`}>
            {file.label}: cipher_status {file.cipherStatus ?? '–'}, cipher_version {file.cipherVersion ?? '–'}, header{' '}
            {HEADER_WORDS[file.header]}
            {file.openMs === null ? '' : `, open ${ms(file.openMs)} ms`}
            {file.problem === null ? '' : `, ${file.problem}`}
        </Line>
    );
}
