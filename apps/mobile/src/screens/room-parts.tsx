import { useEffect, useState } from 'react';
import { Pressable, useWindowDimensions, View } from 'react-native';

import type { HistoryRun } from '@socio/shared/chat/chat-history';
import type { LocalId } from '@socio/shared/mascot';

import type { PersonMark, RoomHeaderView } from '../chat/room-people';
import {
    CANCEL_QUEUED,
    MENTIONS_YOU,
    type OthersBubble,
    readRoomFailures,
    type RoomNoteRow,
    unwordedRuns,
} from '../chat/room-transcript';
import type { Speaker } from '../chat/transcript';
import { useWorkspaceScope } from '../live';
import { useNativeBar } from '../navigation/native-bar';
import type { RunFailures } from '../sync/run-failures';
import { useScheme } from '../theme/scheme';
import { colorsOf, theme } from '../theme/theme';
import { AppSymbol, LocalAvatar, Squircle, Text } from '../ui';

import { MessageText } from './message-text';

// A room's pieces on the chat screen, over src/chat/room-people.ts and
// room-transcript.ts:
// - `RoomHeader`: the app's header (header-bar.tsx's look) with the title, the
//   status line and who else is here, read by a screen reader as one header
//   (`label`), never announced; the presence avatars are hidden from it. It
//   and the socios' stacked marks at its end open the Members sheet.
// - `SpeakerLine`: who wrote a message, above it: a person's squircle avatar
//   in their tone and their name, a socio's mark and name with the web's small
//   "socio" badge (RoomSpeaker.tsx), the reader's "You".
// - `RoomNote`: a handoff or an unanswered turn, as a quiet line.
// - `OthersBubbleView`: someone else's waiting message, for a room admin, with Cancel.
// - `useRoomFailures`: why the room's failed runs failed, for their lines.

/** A person's avatar: their initials on a squircle in their tone. Hidden from screen readers. */
export function PersonAvatar({ mark, size = 24 }: { mark: PersonMark; size?: number }) {
    const { foreground, tiles } = theme[useScheme()].tones[mark.tone];
    return (
        <Squircle size={size} color={tiles.screen}>
            <Text variant="footnote" weight="semibold" style={{ color: foreground }}>
                {mark.initials}
            </Text>
        </Squircle>
    );
}

/** A socio's mark: its Local, as `SocioAvatar`, at a room's sizes. Hidden from screen readers. */
export function SocioMark({ character, size = 24 }: { character: LocalId; size?: number }) {
    return <LocalAvatar character={character} size={size} />;
}

/** The web's badge beside a socio's name in a room (RoomSpeaker.tsx). */
export const SOCIO_BADGE = 'socio';

/** Who wrote a room message, above it; the reader's own on the right. */
export function SpeakerLine({ speaker }: { speaker: Speaker }) {
    return (
        <View
            className={
                speaker.kind === 'you' ? 'flex-row items-center gap-1.5 self-end' : 'flex-row items-center gap-1.5'
            }
        >
            {speaker.kind === 'person' ? <PersonAvatar mark={speaker} size={20} /> : null}
            {speaker.kind === 'socio' ? <SocioMark character={speaker.character} size={20} /> : null}
            <Text
                variant="footnote"
                weight="medium"
                tone={speaker.kind === 'socio' ? 'default' : 'muted'}
                className="shrink"
            >
                {speaker.name}
            </Text>
            {speaker.kind === 'person' && speaker.mentionsYou === true ? <MentionedYou /> : null}
            {speaker.kind === 'socio' ? (
                <View className="rounded-sm border border-border px-1" testID="room-socio-badge">
                    <Text variant="footnote" tone="muted">
                        {SOCIO_BADGE}
                    </Text>
                </View>
            ) : null}
        </View>
    );
}

/**
 * The web's MentionedYou (CB-416): "@you" in the primary tone on its 10% tint, the link teal in
 * light (the brand is under 4.5:1 on its tint at this size, CB-219); "mentions you" to a screen reader.
 */
function MentionedYou() {
    const scheme = useScheme();
    const colors = colorsOf(scheme);
    const color = scheme === 'light' ? colors['chat-link'] : colors.primary;
    return (
        <View
            testID="room-mentioned-you"
            accessible
            accessibilityLabel={MENTIONS_YOU}
            className="flex-row items-center gap-0.5 rounded-sm px-1"
            style={{ backgroundColor: `${colors.primary}1a` }}
        >
            <AppSymbol name="at-sign" size={12} weight="medium" color={{ value: color }} />
            <Text variant="footnote" weight="medium" style={{ color }}>
                you
            </Text>
        </View>
    );
}

/** A handoff between socios, or a turn that went unanswered: a line, not a message. */
export function RoomNote({ row }: { row: RoomNoteRow }) {
    return (
        <View
            testID={`chat-${row.id.replace(':', '-')}`}
            accessible
            accessibilityRole="text"
            className={
                row.note === 'problem'
                    ? 'flex-row items-start gap-2 rounded-md border border-dashed border-border px-3 py-2'
                    : 'flex-row items-start justify-center gap-1.5 px-2'
            }
        >
            <AppSymbol
                name={row.note === 'problem' ? 'circle-alert' : 'arrow-right-left'}
                size={14}
                color="muted-foreground"
            />
            <Text variant="footnote" tone="muted" className="min-w-0 shrink">
                {row.text}
            </Text>
        </View>
    );
}

/** Someone else's waiting message, which a room admin may cancel (online only). */
export function OthersBubbleView({
    bubble,
    busy,
    onCancel,
}: {
    bubble: OthersBubble;
    busy: boolean;
    onCancel: (bubble: OthersBubble) => void;
}) {
    const files = bubble.files === 0 ? '' : ` · ${bubble.files} ${bubble.files === 1 ? 'file' : 'files'}`;
    return (
        <View className="max-w-[80%] gap-1" testID={`chat-${bubble.id.replace(':', '-')}`}>
            <View className="rounded-2xl rounded-bl-sm border border-dashed border-border p-3">
                <MessageText text={bubble.text} surface="other" />
            </View>
            <View className="flex-row flex-wrap items-center gap-x-3 gap-y-1">
                <Text variant="footnote" tone="muted">
                    {`${bubble.caption}${files}`}
                </Text>
                {bubble.cancellable ? (
                    <Pressable
                        testID={`chat-${bubble.id.replace(':', '-')}-cancel`}
                        accessibilityRole="button"
                        accessibilityLabel={`${CANCEL_QUEUED} ${bubble.caption.split(' · ')[0]}’s message`}
                        disabled={busy}
                        onPress={() => onCancel(bubble)}
                        className="min-h-9 justify-center rounded-md px-2 active:bg-muted disabled:opacity-50"
                    >
                        <Text variant="footnote" weight="medium" tone="primary">
                            {CANCEL_QUEUED}
                        </Text>
                    </Pressable>
                ) : null}
            </View>
        </View>
    );
}

/**
 * A room's bar (CB-420): one system bar over the transcript. Its title is the room's name
 * with its status under it ("Ben is here" while someone is), which opens its Members, as Slack's
 * does; at its end the room's menu and its socios' marks, which open the Members too.
 * Draws nothing itself.
 */
export function RoomBar({
    header,
    onMembers,
    onMenu,
}: {
    header: RoomHeaderView;
    /** Null until the room's view has come: there is nobody to list. */
    onMembers: (() => void) | null;
    /** The room's menu: notifications, Members, the web. */
    onMenu: () => void;
}) {
    const { width } = useWindowDimensions();
    const members = onMembers;
    // UIKit centers the title between the bar's buttons: it fits in what the wider side leaves,
    // here ⋯ and the socios' faces.
    const titleWidth = width - (members === null || header.socios.length === 0 ? 170 : 260);
    useNativeBar({
        title: header.title,
        edge: 'hard',
        titleView: {
            signature: JSON.stringify([
                header.label,
                header.title,
                header.status,
                header.presence,
                members !== null,
                titleWidth,
            ]),
            element: () => (
                <Pressable
                    testID="room-header"
                    accessible
                    accessibilityRole="header"
                    accessibilityLabel={header.label}
                    accessibilityHint={members === null ? undefined : 'Shows the members'}
                    disabled={members === null}
                    onPress={members ?? undefined}
                    style={{ maxWidth: titleWidth }}
                    className="items-center rounded-md px-1 active:opacity-60"
                >
                    <Text weight="semibold" numberOfLines={1}>
                        {header.title}
                    </Text>
                    <Text variant="footnote" tone="muted" numberOfLines={1} testID="room-status">
                        {header.presence === '' ? header.status : header.presence}
                    </Text>
                </Pressable>
            ),
        },
        right: [
            {
                id: 'room-menu-button',
                label: 'Room menu',
                symbol: 'ellipsis',
                icon: 'ellipsis',
                iconOnly: true,
                onPress: onMenu,
            },
            ...(members === null || header.socios.length === 0
                ? []
                : [
                      {
                          kind: 'custom' as const,
                          id: 'room-members-button',
                          signature: JSON.stringify([header.socios, header.moreSocios]),
                          element: () => (
                              <Pressable
                                  testID="room-members-button"
                                  accessibilityRole="button"
                                  accessibilityLabel="Members"
                                  accessibilityHint={header.socios.map((socio) => socio.name).join(', ')}
                                  onPress={members}
                                  className="min-h-9 flex-row items-center justify-center px-1 active:opacity-60"
                              >
                                  {header.socios.map((socio) => (
                                      <View key={socio.dotId} className="-mr-2">
                                          <SocioMark character={socio.character} size={26} />
                                      </View>
                                  ))}
                                  {header.moreSocios === 0 ? (
                                      <View className="w-2" />
                                  ) : (
                                      <View className="ml-3">
                                          <Text variant="footnote" tone="muted">{`+${header.moreSocios}`}</Text>
                                      </View>
                                  )}
                              </Pressable>
                          ),
                      },
                  ]),
        ],
    });
    return null;
}

/** Runs whose transcript answer came this session, worded or not: never asked again until the app restarts. */
const ASKED = new WeakMap<RunFailures, Set<string>>();
const NO_CODES: ReadonlyMap<string, string> = new Map();

/**
 * The room's `RoomContext.failure`: the codes this device saw
 * (`runFailures`), and for a failed run it never saw, the room's transcript's
 * (`readRoomFailures`), read once when such a run shows and kept with the
 * others, so the line says why, as the web's does. `roomId` null: not a room.
 */
export function useRoomFailures(
    roomId: string | null,
    runs: readonly HistoryRun[],
): (runId: string) => string | undefined {
    const { fetch, runFailures } = useWorkspaceScope();
    const [found, setFound] = useState(NO_CODES);
    const asked = ASKED.get(runFailures) ?? new Set<string>();
    const missing =
        roomId === null
            ? ''
            : unwordedRuns(runs, (runId) => runFailures.codeOf(runId) ?? found.get(runId))
                  .filter((runId) => !asked.has(runId))
                  .join(' ');
    useEffect(() => {
        if (roomId === null || missing === '') {
            return undefined;
        }
        let live = true;
        readRoomFailures(fetch, roomId)
            .then((codes) => {
                if (codes === null) {
                    return; // No answer: asked again the next time the room shows.
                }
                const seen = ASKED.get(runFailures) ?? new Set<string>();
                ASKED.set(runFailures, seen);
                for (const runId of missing.split(' ')) {
                    seen.add(runId);
                }
                for (const [runId, code] of codes) {
                    runFailures.note(runId, code);
                }
                if (live && codes.length > 0) {
                    setFound((before) => new Map([...before, ...codes]));
                }
            })
            .catch((error: unknown) => console.warn('[room] failures not read', error));
        return () => {
            live = false;
        };
    }, [fetch, runFailures, roomId, missing]);
    return (runId) => runFailures.codeOf(runId) ?? found.get(runId);
}
