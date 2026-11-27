import { useEffect, useState } from 'react';
import { AccessibilityInfo, Pressable, ScrollView, View } from 'react-native';

import type { PersonMention } from '@socio/shared/rooms/room-people-mentions';

import { composerView, SEND_FAILED, STOP_FAILED } from '../chat/composer';
import {
    leadName,
    lengthNotice,
    mayStopRoom,
    MENTION_LIST_LABEL,
    type MentionPicker,
    mentionPicker,
    type MentionRow,
    pickMention,
    ROOM_INPUT_LABEL,
    roomPlaceholder,
    type RoomStarter,
    sendRoomMessage,
    STOP_NEEDS_CONNECTION,
    tooLong,
} from '../chat/room-composer';
import type { RoomContext } from '../chat/room-transcript';
import { useSyncStatus, useWorkspaceScope } from '../live';
import { createRunClient } from '../net/run-client';
import { randomId } from '../platform/crypto';
import { askForNotifications } from '../platform/notification-ask';
import { chatDraft } from '../sync/chat-drafts';
import type { OutboxRow } from '../sync/outbox';
import { Text } from '../ui';

import { useTray } from './attachments';
import { Composer, useDraft, useQuotedDraft } from './chat-composer';
import { PersonAvatar, SocioMark } from './room-parts';

// The room's composer (src/chat/room-composer.ts has the rules): the
// chat's Composer in room mode. "Message the room and Sebas…", the `@` picker
// over the box (people and socios, 44 pt rows with the button role, the count
// said once per change), who will answer under it, the length past 7,500
// characters and Send off past 8,000. Sends go through the outbox as
// `room-message` rows, so they queue offline; the tray and pasted images go
// with them. Stop is the running cycle's initiator's or an admin's,
// online only, never queued. A message sent here whose turn is running (one
// it joined, or the one it started, once RUN_STARTED comes) calls the notification ask
// (`askForNotifications('room-turn')`), which decides whether to show it.

export function RoomComposer(props: {
    id: string;
    context: RoomContext;
    admin: boolean;
    running: boolean;
    heldForSignIn: boolean;
    /** Who started the running turn (`mayStopRoom`). */
    started: RoomStarter;
    onSent: (row: OutboxRow) => void;
}) {
    const { id, context } = props;
    const scope = useWorkspaceScope();
    const syncStatus = useSyncStatus();
    const box = chatDraft(id);
    const draft = useDraft(box);
    // The box shows the words after any quote (CB-571); the length counts the whole message.
    const quoted = useQuotedDraft(draft);
    const tray = useTray(box);
    const [busy, setBusy] = useState(false);
    const [notice, setNotice] = useState<string | null>(null);
    const [caret, setCaret] = useState<number | null>(null);
    const [selection, setSelection] = useState<{ start: number; end: number } | null>(null);
    const [dismissed, setDismissed] = useState<number | null>(null);
    const [picked, setPicked] = useState<readonly PersonMention[]>([]);
    // A message sent from here waits for its turn to run, then the notification ask.
    const [askOnTurn, setAskOnTurn] = useState(false);
    useEffect(() => {
        if (askOnTurn && props.running) {
            setAskOnTurn(false);
            void askForNotifications('room-turn');
        }
    }, [askOnTurn, props.running]);
    const picker = mentionPicker({
        text: quoted.text,
        caret,
        dismissed,
        view: context.view,
        me: context.me,
        dots: context.dots,
    });
    // Closed for one `@` only: another (or none) opens it again.
    const start = picker.query?.start ?? null;
    useEffect(() => {
        if (dismissed !== null && start !== dismissed) {
            setDismissed(null);
        }
    }, [dismissed, start]);
    // The count, said once per change (the box isn't a combobox a reader follows).
    useEffect(() => {
        if (picker.said !== '') {
            AccessibilityInfo.announceForAccessibility(picker.said);
        }
    }, [picker.said]);
    // A picked mention moved the caret once; the box owns it again after.
    useEffect(() => {
        if (selection === null) {
            return undefined;
        }
        const frame = requestAnimationFrame(() => setSelection(null));
        return () => cancelAnimationFrame(frame);
    }, [selection]);

    const lead = leadName(context);
    const socios = context.view?.socios ?? [];
    const canStop = mayStopRoom({ admin: props.admin, me: context.me, ...props.started });
    const long = tooLong(draft.text);
    const base = composerView({
        text: quoted.text,
        // Stop shows only for whom the server lets stop.
        running: props.running && canStop,
        locked: draft.locked || !scope.userDb.writable,
        heldForSignIn: props.heldForSignIn,
        busy,
        files: tray.items.filter((item) => !item.failed).length,
    });
    const view = {
        ...base,
        enabled: base.enabled && !(base.action === 'send' && long),
        // Only the held or update line: none says who answers (CB-491).
        line: base.line,
    };

    const pick = (row: MentionRow) => {
        if (picker.query === null) {
            return;
        }
        const next = pickMention(
            { text: quoted.text, caret: caret ?? quoted.text.length, query: picker.query, picked: [...picked] },
            row.candidate,
        );
        quoted.setText(next.text);
        setPicked(next.picked);
        setDismissed(next.dismissed);
        setCaret(next.caret);
        setSelection({ start: next.caret, end: next.caret });
    };
    const send = () => {
        if (long) {
            return;
        }
        setNotice(null);
        setBusy(true);
        sendRoomMessage({
            drafts: scope.drafts,
            history: scope.histories.history(id),
            steering: scope.steering.steering(id),
            roomId: id,
            picked,
            view: context.view,
            me: context.me,
            newId: randomId,
            serverAt: scope.serverClock.lastDate(),
            attachments: scope.attachments,
        })
            .then((row) => {
                if (row !== null) {
                    setPicked([]);
                    setDismissed(null);
                    setAskOnTurn(true);
                    props.onSent(row);
                }
            })
            .catch((error: unknown) => {
                console.warn('[room] the message was not saved', error);
                setNotice(SEND_FAILED);
            })
            .finally(() => setBusy(false));
    };
    const stop = () => {
        // Online only: a stop is never queued.
        if (syncStatus.reconnecting) {
            setNotice(STOP_NEEDS_CONNECTION);
            AccessibilityInfo.announceForAccessibility(STOP_NEEDS_CONNECTION);
            return;
        }
        setNotice(null);
        setBusy(true);
        createRunClient({ fetch: scope.fetch, newId: randomId })
            .stop(context.leadId, id)
            .then((outcome) => {
                if (!outcome.ok) {
                    setNotice(STOP_FAILED);
                }
            })
            .catch(() => setNotice(STOP_FAILED))
            .finally(() => setBusy(false));
    };
    return (
        <Composer
            text={quoted.text}
            quote={quoted.quote === null ? null : { quote: quoted.quote, onRemove: quoted.removeQuote }}
            onChangeText={(text) => {
                quoted.setText(text);
                if (notice !== null && notice !== STOP_FAILED) {
                    setNotice(null);
                }
            }}
            view={view}
            onSend={send}
            onStop={stop}
            notice={notice ?? lengthNotice(draft.text)}
            tray={tray}
            placeholder={roomPlaceholder(socios, lead)}
            inputLabel={ROOM_INPUT_LABEL}
            selection={selection}
            onCaret={setCaret}
            above={picker.rows.length ? <MentionList picker={picker} onPick={pick} /> : null}
            stacked
            testID="room-composer"
        />
    );
}

/** The `@` picker over the box: each row a button, 44 pt tall, the avatar hidden from screen readers. */
function MentionList({ picker, onPick }: { picker: MentionPicker; onPick: (row: MentionRow) => void }) {
    return (
        // Taps pick while the keyboard is up; about four rows show, the rest scroll.
        <ScrollView
            testID="room-mentions"
            accessibilityLabel={MENTION_LIST_LABEL}
            keyboardShouldPersistTaps="always"
            style={{ maxHeight: MENTION_LIST_HEIGHT }}
            contentContainerClassName="gap-1"
        >
            {picker.rows.map((row) => (
                <Pressable
                    key={row.key}
                    testID={`room-mention-${row.candidate.kind}-${row.label}`}
                    accessibilityRole="button"
                    accessibilityLabel={row.accessibilityLabel}
                    onPress={() => onPick(row)}
                    className="min-h-11 flex-row items-center gap-2 rounded-xl px-2 py-1 active:bg-muted"
                >
                    <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
                        {row.mark !== null ? (
                            <PersonAvatar mark={row.mark} />
                        ) : row.character !== null ? (
                            <SocioMark character={row.character} />
                        ) : null}
                    </View>
                    <Text className="flex-1" numberOfLines={1}>
                        {row.label}
                    </Text>
                    {row.badge === null ? null : (
                        <Text variant="footnote" tone="muted">
                            {row.badge}
                        </Text>
                    )}
                </Pressable>
            ))}
        </ScrollView>
    );
}

/** Four 44 pt rows and their gaps, and half of the next, so the list says it scrolls. */
const MENTION_LIST_HEIGHT = 4 * 44 + 3 * 4 + 22;
