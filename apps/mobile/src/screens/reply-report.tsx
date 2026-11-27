import { useIsFocused } from '@react-navigation/native';
import { type ReactNode, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { AccessibilityInfo, Alert, Pressable, View } from 'react-native';

import type { ReactionKind, ReactionsView } from '@socio/shared/chat/reactions';
import type { ReplyReportsState, ReportReason } from '@socio/shared/chat/reply-reports';

import { reactionSaid } from '../chat/reactions';
import {
    noteCount,
    offersReport,
    reactionPress,
    readReportPreview,
    removeSharedAsk,
    REPORT_WORDS,
    reportMark,
    reportRequest,
    type ReportRequest,
    type ReportSheet,
    reportSheetOf,
    reportSheetText,
} from '../chat/reply-reports';
import { useSyncRefresh, useSyncStatus, useWorkspaceScope } from '../live';
import { appState } from '../platform/app-state';
import { randomId } from '../platform/crypto';
import { react } from '../sync/chat-manage';
import type { ReactionsState } from '../sync/reactions';
import { AppSymbol, Button, Field, Text } from '../ui';
import { cx } from '../ui/cx';

import { useReportNotice } from './report-notice';
import { useRouteSheet } from './route-sheet';

// AI reply reports in the chat (CB-382, docs/specs/REPLY-REPORTS.md; the web's
// MessageReactions and ReportDialog): a thumbs-down, from the action row or
// "Bad reply" in the long-press menu, while the workspace shares reports asks
// the server what would go (`GET …/report`), then opens the confirmation in a
// native sheet (`useRouteSheet`, TallSheet): what goes and what stays, the
// line about another person's message when the server says so, the reasons,
// an optional note counted in code points, Cancel and Report. Report queues the
// thumbs-down with its report through the outbox (`react`). Offline, the
// thumbs-down goes plain through the outbox and the reply offers "Report it
// now?" once the app is back online. Removing a thumbs-down whose report went
// (or a thumbs-up in its place) warns first that it doesn't recall it. Under the
// reply: "Shared with Ingenio", a report's quiet notice, or the offer.

const SHELL = ['shell'] as const;

export interface ReplyReports {
    /** A press of a reaction (the row's button or the menu's), whatever it does with reports. */
    press(messageId: string, socio: string, kind: ReactionKind, on: boolean): void;
    /** The lines under a reply about its report, or null. */
    lines(messageId: string, socio: string): ReactNode;
}

interface Open {
    readonly sheet: ReportSheet;
    /** It came from "Report it now?": its offer goes once it is sent or canceled. */
    readonly offered: boolean;
}

export function useReplyReports(input: {
    readonly threadId: string;
    readonly state: ReactionsState;
    /** The view as shown: the outbox's reaction rows laid over. */
    readonly shown: ReactionsView;
    /** `GET /api/workspace`'s `replyReports` (`replyReportsOf`). */
    readonly reports: ReplyReportsState;
    /** A reaction of this reply still waits in the outbox. */
    readonly waiting: (messageId: string) => boolean;
    readonly onFailed: (error: unknown) => void;
}): ReplyReports {
    const { threadId, state, shown, reports, waiting, onFailed } = input;
    const scope = useWorkspaceScope();
    const { reconnecting } = useSyncStatus();
    const online = !reconnecting;
    const refreshShell = useSyncRefresh(SHELL);
    const [chat] = useState(() => scope.reactions.reactions(threadId));
    const [checking, setChecking] = useState<string | null>(null);
    const [open, setOpen] = useState<Open | null>(null);
    // A report's outcome (§3): a quiet line for a while, and the shell read again.
    const { notice, say: quiet } = useReportNotice(state.report, refreshShell);
    // A queued report goes to Ingenio later and nothing tells the phone: while the chat shows, in
    // the foreground and online, its reactions are asked again until no report is queued, and once
    // more on each reconnect.
    const focused = useIsFocused();
    const active = useSyncExternalStore(appState.subscribe, () => appState.current() === 'active');
    const watching = focused && active && online;
    useEffect(() => (watching ? chat.watchQueued() : undefined), [chat, watching]);
    const wasOnline = useRef(online);
    useEffect(() => {
        if (online && !wasOnline.current) {
            void chat.refresh();
        }
        wasOnline.current = online;
    }, [chat, online]);

    const send = (messageId: string, kind: ReactionKind, on: boolean, report?: ReportRequest) => {
        react(scope.outbox, {
            threadId,
            messageId,
            reaction: kind,
            on,
            newId: randomId,
            ...(report === undefined ? {} : { report }),
        }).catch(onFailed);
    };
    /** A plain reaction: `add` puts it on, else takes it off. */
    const plain = (messageId: string, kind: ReactionKind, add: boolean) => {
        AccessibilityInfo.announceForAccessibility(reactionSaid(kind, !add));
        if (kind === 'down' && !add) {
            chat.offer(messageId, false);
        }
        send(messageId, kind, add);
    };
    /** Asks the server what the report would hold, then opens the sheet; nothing is sent until Report. */
    const startReport = (messageId: string, socio: string, consent: string, offered: boolean) => {
        setChecking(messageId);
        void readReportPreview(scope.fetch, threadId, messageId).then((read) => {
            setChecking(null);
            if (read.kind === 'offline') {
                if (!offered) {
                    // No answer: a plain thumbs-down now, the report once back online.
                    plain(messageId, 'down', true);
                    chat.offer(messageId, true);
                }
                return;
            }
            if (read.kind === 'failed') {
                quiet(messageId, REPORT_WORDS.previewFailed);
                return;
            }
            const sheet = reportSheetOf(read.preview, { messageId, consent, socio });
            if (sheet === null) {
                // Sharing went off since the workspace was read: a plain one.
                chat.offer(messageId, false);
                if (!offered) {
                    plain(messageId, 'down', true);
                }
                refreshShell().catch(() => {});
                return;
            }
            setOpen({ sheet, offered });
        }, onFailed);
    };
    const press = (messageId: string, socio: string, kind: ReactionKind, on: boolean) => {
        if (checking !== null || open !== null) {
            return;
        }
        const what = reactionPress(shown, messageId, kind, reports);
        if (what.kind === 'warn') {
            const ask = removeSharedAsk(what.reaction);
            Alert.alert(ask.title, ask.message, [
                { text: ask.cancel, style: 'cancel' },
                {
                    text: ask.confirm,
                    // What the warning said: remove the thumbs-down, or add the thumbs-up.
                    onPress: () => plain(messageId, what.reaction, what.reaction === 'up'),
                },
            ]);
            return;
        }
        if (what.kind === 'report') {
            if (!online) {
                plain(messageId, 'down', true);
                chat.offer(messageId, true);
                return;
            }
            startReport(messageId, socio, what.consent, false);
            return;
        }
        plain(messageId, kind, !on);
    };
    const close = () => {
        if (open?.offered === true) {
            chat.offer(open.sheet.messageId, false);
        }
        setOpen(null);
    };
    useRouteSheet(
        open === null
            ? null
            : {
                  testID: 'report-sheet',
                  tall: true,
                  title: reportSheetText(open.sheet).title,
                  body: (
                      <ReportSheetBody
                          key={open.sheet.messageId}
                          sheet={open.sheet}
                          onCancel={close}
                          onConfirm={(report) => {
                              const { messageId } = open.sheet;
                              chat.offer(messageId, false);
                              setOpen(null);
                              AccessibilityInfo.announceForAccessibility(reactionSaid('down', false));
                              send(messageId, 'down', true, report);
                          }}
                      />
                  ),
              },
        close,
    );
    const lines = (messageId: string, socio: string): ReactNode => {
        const mark = reportMark(shown, messageId);
        const said = notice?.messageId === messageId ? notice.text : null;
        const offer =
            reports !== null &&
            offersReport({
                offered: state.offers.includes(messageId),
                reports,
                online,
                view: shown,
                messageId,
                waiting: waiting(messageId),
            });
        if (mark === null && said === null && !offer) {
            return null;
        }
        return (
            <View className="gap-1 px-3" testID={`report-lines-${messageId}`}>
                {mark === null ? null : (
                    <Text variant="footnote" tone="muted" testID={`report-shared-${messageId}`}>
                        {mark}
                    </Text>
                )}
                {said === null ? null : (
                    <Text
                        variant="footnote"
                        tone="muted"
                        accessibilityLiveRegion="polite"
                        testID={`report-notice-${messageId}`}
                    >
                        {said}
                    </Text>
                )}
                {offer && reports !== null ? (
                    <View className="flex-row flex-wrap items-center gap-2" testID={`report-offer-${messageId}`}>
                        <Text variant="footnote" tone="muted" className="shrink">
                            {REPORT_WORDS.offer}
                        </Text>
                        <Button
                            label={REPORT_WORDS.offerReport}
                            variant="tinted"
                            busy={checking === messageId}
                            onPress={() => startReport(messageId, socio, reports.consent, true)}
                            testID={`report-offer-${messageId}-report`}
                        />
                        <Button
                            label={REPORT_WORDS.offerDismiss}
                            variant="ghost"
                            onPress={() => chat.offer(messageId, false)}
                            testID={`report-offer-${messageId}-dismiss`}
                        />
                    </View>
                ) : null}
            </View>
        );
    };
    return { press, lines };
}

/** The confirmation's body: what goes, the reasons, the note and its counter, Cancel and Report. */
function ReportSheetBody(props: {
    sheet: ReportSheet;
    onCancel: () => void;
    onConfirm: (report: ReportRequest) => void;
}) {
    const [reason, setReason] = useState<ReportReason | null>(null);
    const [note, setNote] = useState('');
    const text = reportSheetText(props.sheet);
    const count = noteCount(note);
    const request = reportRequest({
        reason,
        note,
        consent: props.sheet.consent,
        shownByOther: props.sheet.byOther !== undefined,
    });
    return (
        <View className="gap-4" testID="report-sheet-body">
            <Text tone="muted" testID="report-sheet-text">
                {text.body}
            </Text>
            {text.byOther === null ? null : (
                <Text weight="medium" testID="report-sheet-by-other">
                    {text.byOther}
                </Text>
            )}
            <View className="gap-2">
                <Text accessibilityRole="header" variant="subheadline" weight="medium">
                    {REPORT_WORDS.reason}
                </Text>
                <View className="rounded-xl border border-border bg-card" accessibilityRole="radiogroup">
                    {text.reasons.map((option, index) => {
                        const checked = reason === option.id;
                        return (
                            <Pressable
                                key={option.id}
                                testID={`report-reason-${option.id}`}
                                accessibilityRole="radio"
                                accessibilityLabel={option.label}
                                accessibilityState={{ checked }}
                                onPress={() => setReason(option.id)}
                                className={cx(
                                    'min-h-11 flex-row items-center gap-3 p-3 active:bg-accent',
                                    index > 0 && 'border-t border-border',
                                )}
                            >
                                <Text className="min-w-0 flex-1">{option.label}</Text>
                                <View className="w-5">
                                    {checked ? <AppSymbol name="check" size={20} color="primary" /> : null}
                                </View>
                            </Pressable>
                        );
                    })}
                </View>
            </View>
            <View className="gap-1">
                <Field
                    label={REPORT_WORDS.noteLabel}
                    value={note}
                    onChangeText={setNote}
                    multiline
                    numberOfLines={3}
                    accessibilityHint={count.count}
                    {...(count.warning === null ? {} : { error: count.warning })}
                    testID="report-note"
                />
                <Text
                    variant="footnote"
                    tone={count.over ? 'destructive' : 'muted'}
                    style={{ fontVariant: ['tabular-nums'] }}
                    testID="report-note-count"
                >
                    {count.count}
                </Text>
            </View>
            <View className="flex-row flex-wrap justify-end gap-3">
                <Button label={text.cancel} variant="ghost" onPress={props.onCancel} testID="report-cancel" />
                <Button
                    label={text.confirm}
                    variant="destructive"
                    disabled={request === null}
                    onPress={() => {
                        if (request !== null) {
                            props.onConfirm(request);
                        }
                    }}
                    testID="report-confirm"
                />
            </View>
        </View>
    );
}
