import { useNavigation } from '@react-navigation/native';
import type { StaticScreenProps } from '@react-navigation/native';
import * as Clipboard from 'expo-clipboard';
import { useEffect, useState, useSyncExternalStore } from 'react';
import { Alert, Platform, Pressable, ScrollView, View } from 'react-native';
import { KeyboardAvoidingView } from 'react-native-keyboard-controller';

import type { IssueDetail } from '@socio/shared/issues/issue-types';

import { composerView, SEND_FAILED } from '../chat/composer';
import { outboxStateStore } from '../chat/composer';
import {
    useCollections,
    useHasWorkspaceScope,
    useIssueComponentOptions,
    useIssueDetail,
    useLiveQuery,
    useSyncOnFocus,
    useUnsent,
    useWorkspaceScope,
} from '../live';
import { useNativeBar } from '../navigation/native-bar';
import { issueAction, mediaFileAction } from '../navigation/tabs';
import { useFirstFrameWithData } from '../platform/cold-start';
import { randomId } from '../platform/crypto';
import { useAttachmentPicture } from '../platform/image-cache';
import {
    ATTACH_TO_ISSUE,
    type DetailComment,
    type DetailFile,
    type DetailProblem,
    ISSUE_DETAIL_VIEWS,
    ISSUE_GONE,
    ISSUE_GONE_LINE,
    ISSUE_OFFLINE,
    ISSUE_SECTIONS,
    type IssueDetailView,
    issueDetailView,
    NO_COMMENTS,
    NO_DESCRIPTION,
    NO_FILES,
    NO_HISTORY,
    type ProblemAction,
} from '../shell/issue-detail';
import { issueOfParam, issueParam, issueScreen } from '../shell/last-screen';
import { shellQuery, shellRows } from '../shell/queries';
import { attachToIssue, commentWithFiles, issueAttachTray, seenAttachments } from '../sync/issue-attachments';
import { CommentError, deleteComment, editComment, seenComments } from '../sync/issue-comments';
import { issueCommentsDraft } from '../sync/issue-create';
import { editIssue, IssueEditError, keepMine, keepTheirs, voteOnIssue } from '../sync/issue-edit';
import { ISSUES } from '../sync/issues';
import { overlaysOf } from '../sync/outbox-overlay';
import { useScheme } from '../theme/scheme';
import { colorsOf, theme, type ToneName } from '../theme/theme';
import {
    Button,
    Field,
    GroupedCard,
    GroupedRoot,
    AppSymbol,
    keyboardScroll,
    ROW_INSET,
    RowSeparator,
    Screen,
    Text,
} from '../ui';
import { cx } from '../ui/cx';
import { EmptyState, useWayBack } from '../ui/empty-state';
import { Squircle, SquircleImage } from '../ui/squircle';

import { AttachMenu, AttachmentTray, useTray } from './attachments';
import { Composer, useDraft } from './chat-composer';
import { ReplyMarkdown } from './chat-markdown';
import { AdminFields } from './issue-admin';
import { ComponentChip, ComponentChipList } from './issue-components';
import { StatusBanners, useRememberScreen } from './shell-parts';

// An issue: the `Issue` route at
// `/issues/:key`, pushed from the Board, Search, issue chips, another issue's
// links and notifications. Its view model is src/shell/issue-detail.ts: the
// held detail (read from disk first, then the server) with this device's
// writes laid over. The web's IssueDetail on a phone: the key, status and
// vote, the title, who filed it, the description (the chat replies' renderer: issue text
// is untrusted, nothing it names is fetched), the files (with Attach), the comments (their
// box, with the chat's tray, docked under the page) and the history, then the
// fields and the links (each opens its issue): the conversation first, in
// the web's order (`ISSUE_SECTIONS`). Votes, comments and (a member's own issue in triage) the
// title and description go through the outbox, so they work offline; what
// the server refused shows in place with Keep mine and Keep theirs, or Retry,
// Copy and Discard. Admins edit the fields (issue-admin.tsx).

/** The list's poll (15 s while shown) is what tells the detail it changed (`followIssueList`). */
const SYNCED = [ISSUES];

export function IssueScreen({ route }: StaticScreenProps<{ key: string }>) {
    return useHasWorkspaceScope() ? <IssueRoute param={route.params.key} /> : null;
}

function IssueRoute({ param }: { param: string }) {
    const navigation = useNavigation();
    const { issues } = useWorkspaceScope();
    const named = issueOfParam(param);
    // A filing's local key resolves through `ids` once its create has: the route swaps to the number.
    useEffect(
        () =>
            issues.subscribe((local, number) => {
                if (local === named) {
                    navigation.setParams({ key: issueParam(number) } as never);
                }
            }),
        [issues, navigation, named],
    );
    if (named === null) {
        return <Missing label="Issue" headline={ISSUE_GONE} line={null} />;
    }
    const key = issues.resolve(named);
    return <Detail key={key} issueKey={key} />;
}

/** An issue the screen can't show: said plainly (the shared empty state), with a way back. */
function Missing(props: { label: string; headline: string; line: string | null }) {
    const back = useWayBack('Issue');
    useFirstFrameWithData('Issue', true);
    useNativeBar({ title: props.label });
    return (
        <View testID="issue-screen" className="flex-1 bg-screen" collapsable={false}>
            <Screen edges={['right', 'bottom', 'left']}>
                <StatusBanners />
                <EmptyState headline={props.headline} line={props.line} action={back} testID="issue-missing" />
            </Screen>
        </View>
    );
}

function Detail({ issueKey: key }: { issueKey: string }) {
    const navigation = useNavigation();
    const scope = useWorkspaceScope();
    const { outbox } = scope;
    const collections = useCollections();
    useRememberScreen(issueScreen(key));
    useSyncOnFocus(SYNCED);
    const item = useIssueDetail(key);
    const [store] = useState(() => outboxStateStore(outbox));
    const writes = useSyncExternalStore(store.subscribe, store.get);
    const unsent = useUnsent();
    const { data: shell } = useLiveQuery({ query: shellQuery(collections) });
    const user = shellRows(shell).workspace?.user ?? null;
    // The kept component options name a filing's and a just-picked component (CB-442); not read here.
    const options = useIssueComponentOptions(false);
    const view = issueDetailView({
        key,
        detail: item.value,
        item,
        overlays: overlaysOf({ rows: writes.rows, unsent: writes.unsent, kinds: ISSUE_DETAIL_VIEWS, scope: outbox }),
        unsent: unsent.writes,
        groups: unsent.groups,
        user,
        me: scope.workspace.appUserId,
        resolve: outbox.resolve,
        options: options.value?.options ?? null,
    });
    useFirstFrameWithData('Issue', view.state === 'ready');
    // The system's bar (CB-420): the issue's key as its inline title, the system's Back.
    useNativeBar({ title: view.label });

    if (view.state === 'gone') {
        return <Missing label={view.label} headline={ISSUE_GONE} line={ISSUE_GONE_LINE} />;
    }
    if (view.state !== 'ready') {
        return view.state === 'offline' ? (
            <Missing label={view.label} headline={ISSUE_OFFLINE} line={null} />
        ) : (
            <View testID="issue-screen" className="flex-1 bg-screen" collapsable={false}>
                <Screen edges={['right', 'bottom', 'left']}>
                    <Text variant="subheadline" tone="muted" testID="issue-loading">
                        Loading issue…
                    </Text>
                </Screen>
            </View>
        );
    }
    return (
        <KeyboardAvoidingView behavior="padding" automaticOffset style={{ flex: 1 }}>
            {/* Reminders' detail: an inset grouped page, its fields and links in groups. */}
            <GroupedRoot testID="issue-screen">
                <ScrollView
                    contentInsetAdjustmentBehavior="automatic"
                    className="flex-1"
                    contentContainerClassName="gap-6 p-4"
                    {...keyboardScroll(Platform.OS)}
                    testID="issue-scroll"
                >
                    <StatusBanners />
                    <Head view={view} issueKey={key} />
                    <Problems problems={view.problems} detail={item.value} />
                    {ISSUE_SECTIONS.map((section) => {
                        switch (section) {
                            case 'description':
                                return <Description key={section} view={view} issueKey={key} />;
                            case 'files':
                                return (
                                    <IssueAttachments key={section} view={view} issueKey={key} detail={item.value} />
                                );
                            case 'comments':
                                return <Comments key={section} view={view} issueKey={key} />;
                            case 'history':
                                return <History key={section} view={view} />;
                            case 'triage':
                                return <Triage key={section} view={view} />;
                            case 'fields':
                                return view.admin === null ? (
                                    <Fields key={section} view={view} />
                                ) : (
                                    <AdminFields
                                        key={section}
                                        admin={view.admin}
                                        issueKey={key}
                                        number={item.value?.issue.number ?? null}
                                        users={item.value?.users ?? {}}
                                        labels={item.value?.components}
                                    />
                                );
                            case 'links':
                                return (
                                    <Links
                                        key={section}
                                        view={view}
                                        onOpen={(linked) => openIssue(scope, navigation, linked)}
                                    />
                                );
                        }
                    })}
                </ScrollView>
                <CommentBox issueKey={key} detail={item.value} />
            </GroupedRoot>
        </KeyboardAvoidingView>
    );
}

type Navigation = { dispatch(action: ReturnType<typeof issueAction>): void };
type Scope = ReturnType<typeof useWorkspaceScope>;

/** Another issue: its detail from disk first, then its screen. */
function openIssue(scope: Scope, navigation: Navigation, key: string) {
    scope.issueDetails.preload(key).catch((error: unknown) => console.warn('[issue] not read from disk', error));
    navigation.dispatch(issueAction(key));
}

const failed = (what: string) => (error: unknown) => console.warn(`[issue] ${what}`, error);

/** A value the server would refuse shows under its field (its own words); anything else is logged. */
const refused =
    (kind: new (...args: never[]) => Error, show: (message: string) => void, what: string) => (error: unknown) => {
        if (error instanceof kind) {
            show(error.message);
        } else {
            failed(what)(error);
        }
    };

/** Words on a tone's tile: the status and the priority, never color alone. */
function TonePill({ tone, children, testID }: { tone: ToneName; children: string; testID?: string }) {
    const { foreground, tiles } = theme[useScheme()].tones[tone];
    return (
        <View className="rounded-sm px-1.5" style={{ backgroundColor: tiles.card }} testID={testID}>
            <Text variant="footnote" weight="medium" style={{ color: foreground }}>
                {children}
            </Text>
        </View>
    );
}

function Pending({ words }: { words: string | null }) {
    return words === null ? null : (
        <View className="flex-row items-center gap-1">
            <AppSymbol name="clock" size={12} color="muted-foreground" />
            <Text variant="footnote" tone="muted">
                {words}
            </Text>
        </View>
    );
}

/**
 * The vote: the web's IssueVote chip in the meta line, a thumb and the
 * count (`size="xs"`, ghost; voted, secondary in the primary color with the thumb
 * filled), not a labelled button. The chip is small; hitSlop keeps the 44 pt
 * target. Its label says the key, the count and whether the person voted.
 */
function VoteChip(props: { vote: NonNullable<IssueDetailView['vote']>; disabled: boolean; onPress: () => void }) {
    const { vote } = props;
    const colors = colorsOf(useScheme());
    const tint = vote.voted ? colors.primary : colors['muted-foreground'];
    return (
        <Pressable
            testID="issue-vote"
            accessibilityRole="button"
            accessibilityLabel={vote.accessibilityLabel}
            accessibilityState={{ selected: vote.voted, disabled: props.disabled }}
            disabled={props.disabled}
            onPress={props.onPress}
            hitSlop={VOTE_HIT_SLOP}
            className={cx(
                'min-h-7 flex-row items-center gap-1 rounded-md px-2',
                vote.voted ? 'bg-secondary' : 'active:bg-accent dark:active:bg-accent/50',
            )}
        >
            <AppSymbol name="thumbs-up" size={14} color={{ value: tint }} filled={vote.voted} />
            <Text variant="meta" tone={vote.voted ? 'primary' : 'muted'}>
                {String(vote.votes)}
            </Text>
            {vote.pending ? <AppSymbol name="clock" size={12} color="muted-foreground" /> : null}
        </Pressable>
    );
}

/** The chip is 28 pt high: 8 above and below make a phone's 44 pt tap target. */
const VOTE_HIT_SLOP = { top: 8, bottom: 8, left: 4, right: 4 } as const;

/** The key's line (status, priority, vote, demand, blocked), the title (editable by the issue edits' rule) and who filed it. */
function Head({ view, issueKey: key }: { view: IssueDetailView; issueKey: string }) {
    const { outbox } = useWorkspaceScope();
    const [title, setTitle] = useState<string | null>(null);
    const [error, setError] = useState<string | undefined>();
    const vote = view.vote!;
    const save = () => {
        if (title === null || view.base === null) {
            return;
        }
        editIssue(outbox, { issue: key, changes: { title }, base: view.base, newId: randomId })
            .then(() => setTitle(null))
            .catch(refused(IssueEditError, setError, 'the title was not saved'));
    };
    return (
        <View className="gap-2">
            <View className="flex-row flex-wrap items-center gap-2">
                {view.status === null ? null : (
                    <TonePill tone={view.status.tone} testID="issue-status">
                        {view.status.label}
                    </TonePill>
                )}
                {view.priority === null ? null : (
                    <TonePill tone={view.priority.tone}>{`${view.priority.label} priority`}</TonePill>
                )}
                {view.demand === null ? null : <TonePill tone="violet">{view.demand}</TonePill>}
                {view.blocked === null ? null : <TonePill tone="amber">{view.blocked}</TonePill>}
                <VoteChip
                    vote={vote}
                    disabled={view.voteBase === null}
                    onPress={() =>
                        voteOnIssue(outbox, {
                            issue: key,
                            vote: !vote.voted,
                            base: view.voteBase!,
                            newId: randomId,
                        }).catch(failed('the vote was not saved'))
                    }
                />
            </View>
            {title === null ? (
                <View className="flex-row items-start gap-2">
                    <Text
                        accessibilityRole="header"
                        variant="title2"
                        weight="semibold"
                        className="min-w-0 flex-1"
                        testID="issue-title"
                    >
                        {view.title}
                    </Text>
                    {view.canEditText ? (
                        <Button
                            variant="ghost"
                            iconOnly
                            icon="pencil"
                            label="Edit title"
                            onPress={() => setTitle(view.title)}
                            testID="issue-edit-title"
                        />
                    ) : null}
                </View>
            ) : (
                <View className="gap-2">
                    <Field
                        label="Title"
                        value={title}
                        onChangeText={(text) => {
                            setTitle(text);
                            setError(undefined);
                        }}
                        maxLength={200}
                        autoFocus
                        error={error}
                        testID="issue-title-field"
                    />
                    <EditButtons onCancel={() => setTitle(null)} onSave={save} testID="issue-title" />
                </View>
            )}
            {view.filed === null ? null : (
                <Text variant="meta" testID="issue-filed">
                    {view.filed}
                </Text>
            )}
            {view.age === null ? null : (
                <Text variant="meta" testID="issue-age">
                    {view.age}
                </Text>
            )}
            <Pending words={view.pending} />
        </View>
    );
}

function EditButtons({ onCancel, onSave, testID }: { onCancel: () => void; onSave: () => void; testID: string }) {
    return (
        <View className="flex-row justify-end gap-2">
            <Button variant="ghost" label="Cancel" onPress={onCancel} testID={`${testID}-cancel`} />
            <Button label="Save" onPress={onSave} testID={`${testID}-save`} />
        </View>
    );
}

function SectionTitle({ children }: { children: string }) {
    return (
        <Text accessibilityRole="header" variant="section">
            {children}
        </Text>
    );
}

/** What the server refused on this issue, in place: why, and what the person can do. */
function Problems({ problems, detail }: { problems: readonly DetailProblem[]; detail: IssueDetail | null }) {
    const navigation = useNavigation();
    const { outbox } = useWorkspaceScope();
    if (problems.length === 0) {
        return null;
    }
    const act = (problem: DetailProblem, action: ProblemAction) => {
        switch (action) {
            case 'keep-mine':
                if (detail !== null) {
                    keepMine(outbox, { id: problem.id, current: detail.issue, idempotencyKey: randomId() }).catch(
                        failed('not sent again'),
                    );
                }
                return;
            case 'keep-theirs':
                keepTheirs(outbox, problem.id).catch(failed('not discarded'));
                return;
            case 'retry':
                outbox.retryUnsent(problem.id, randomId()).catch(failed('not sent again'));
                return;
            case 'edit':
                navigation.navigate('FileIssue', { edit: problem.id });
                return;
            case 'copy':
                Clipboard.setStringAsync(problem.text ?? '').catch(failed('not copied'));
                return;
            case 'discard':
                Alert.alert('Discard this?', 'It won’t be sent.', [
                    { text: 'Cancel', style: 'cancel' },
                    {
                        text: 'Discard',
                        style: 'destructive',
                        onPress: () => void outbox.discardUnsent(problem.id).catch(failed('not discarded')),
                    },
                ]);
                return;
        }
    };
    return (
        <View className="gap-2" testID="issue-problems">
            {problems.map((problem) => (
                <View key={problem.id} className="gap-2 rounded-xl border border-destructive/40 bg-card p-3">
                    <View accessible accessibilityLabel={problem.accessibilityLabel} className="gap-1">
                        <Text variant="footnote" tone="muted">
                            {problem.what}
                        </Text>
                        {problem.text === null ? null : <Text numberOfLines={4}>{problem.text}</Text>}
                        <Text variant="footnote" tone="destructive">
                            {problem.why}
                        </Text>
                    </View>
                    <View className="flex-row flex-wrap justify-end gap-2">
                        {problem.actions.map((action) => (
                            <Button
                                key={action}
                                variant={
                                    action === 'keep-mine' || action === 'retry' || action === 'edit'
                                        ? 'secondary'
                                        : 'ghost'
                                }
                                label={PROBLEM_LABELS[action]}
                                onPress={() => act(problem, action)}
                                testID={`issue-problem-${action}`}
                            />
                        ))}
                    </View>
                </View>
            ))}
        </View>
    );
}

const PROBLEM_LABELS: Readonly<Record<ProblemAction, string>> = {
    'keep-mine': 'Keep mine',
    'keep-theirs': 'Keep theirs',
    retry: 'Retry',
    edit: 'Edit',
    copy: 'Copy',
    discard: 'Discard',
};

function Description({ view, issueKey: key }: { view: IssueDetailView; issueKey: string }) {
    const { outbox } = useWorkspaceScope();
    const [body, setBody] = useState<string | null>(null);
    const [error, setError] = useState<string | undefined>();
    const save = () => {
        if (body === null || view.base === null) {
            return;
        }
        editIssue(outbox, { issue: key, changes: { body }, base: view.base, newId: randomId })
            .then(() => setBody(null))
            .catch(refused(IssueEditError, setError, 'the description was not saved'));
    };
    return (
        <View className="gap-2" testID="issue-description">
            <SectionTitle>Description</SectionTitle>
            {body !== null ? (
                <View className="gap-2">
                    <Field
                        label="Description"
                        value={body}
                        onChangeText={(text) => {
                            setBody(text);
                            setError(undefined);
                        }}
                        multiline
                        maxLength={20_000}
                        autoFocus
                        error={error}
                        testID="issue-body-field"
                    />
                    <EditButtons onCancel={() => setBody(null)} onSave={save} testID="issue-body" />
                </View>
            ) : (
                <>
                    {view.body === null ? (
                        <Text variant="subheadline" tone="muted">
                            {NO_DESCRIPTION}
                        </Text>
                    ) : (
                        <ReplyMarkdown text={view.body} testID="issue-body" prose="issue" />
                    )}
                    {view.canEditText ? (
                        <View className="flex-row">
                            <Button
                                variant="secondary"
                                icon="pencil"
                                label="Edit description"
                                onPress={() => setBody(view.body ?? '')}
                                testID="issue-edit-body"
                            />
                        </View>
                    ) : null}
                </>
            )}
        </View>
    );
}

/** A side of a picture tile. */
const PICTURE = 96;

/** Files: pictures open the viewer (the image cache), other files their page in Media (CB-558); a file still waiting says so. */
function Files({ files, testID }: { files: readonly DetailFile[]; testID: string }) {
    const navigation = useNavigation();
    if (files.length === 0) {
        return null;
    }
    const pictures = files
        .filter((file) => file.picture)
        .map((file) => ({ id: file.id, name: file.name, local: null, kind: 'issue' as const }));
    return (
        <View className="flex-row flex-wrap gap-2" testID={testID} accessibilityLabel="Attachments">
            {files.map((file) =>
                file.picture ? (
                    <Picture
                        key={file.id}
                        file={file}
                        onOpen={() =>
                            navigation.navigate('AttachmentViewer', {
                                images: pictures,
                                index: Math.max(
                                    0,
                                    pictures.findIndex((picture) => picture.id === file.id),
                                ),
                            })
                        }
                    />
                ) : (
                    <Pressable
                        key={file.id}
                        testID={`issue-file-${file.id}`}
                        accessibilityRole="button"
                        accessibilityLabel={file.accessibilityLabel}
                        accessibilityHint={file.pending === null ? 'Opens the file' : undefined}
                        disabled={file.pending !== null}
                        onPress={() =>
                            navigation.dispatch(
                                mediaFileAction({ issueFile: file.id, name: file.name, mediaType: file.mediaType }),
                            )
                        }
                        className="min-h-11 max-w-full flex-row items-center gap-2 rounded-2xl border border-border bg-card p-2 active:bg-accent"
                    >
                        <AppSymbol name="file" size={16} color="muted-foreground" />
                        <View className="shrink">
                            <Text weight="medium" numberOfLines={1}>
                                {file.name}
                            </Text>
                            {file.pending === null ? null : (
                                <Text variant="footnote" tone="muted">
                                    {file.pending}
                                </Text>
                            )}
                        </View>
                    </Pressable>
                ),
            )}
        </View>
    );
}

/**
 * The issue's own files: the web's Attachments section, shown even
 * with none, its Attach button beside the title. Attach opens the comment
 * box's three choices; a pick goes through the same tray and issue
 * processor as the box's "+", into `issueAttachTray`, and from there at once
 * into rows of its own (`attachToIssue`), which wait in the outbox offline and
 * post to the web's `POST /api/issues/:n/attachments` with no comment. A file
 * that couldn't be queued stays in the section's tray to remove or retry.
 */
function IssueAttachments(props: { view: IssueDetailView; issueKey: string; detail: IssueDetail | null }) {
    const { view, issueKey: key, detail } = props;
    const scope = useWorkspaceScope();
    const [menu, setMenu] = useState(false);
    const draft = issueAttachTray(key);
    const tray = useTray(draft, {
        existing: view.fileCount,
        onAdded: () => {
            attachToIssue({
                outbox: scope.outbox,
                attachments: scope.attachments,
                newId: randomId,
                issue: key,
                uploaderId: scope.workspace.appUserId,
                serverAt: scope.serverClock.lastDate(),
                seen: seenAttachments(detail),
                draft,
            }).catch(failed('the file was not queued'));
        },
    });
    const disabled = !scope.userDb.writable || tray.busy;
    return (
        <View className="gap-2" testID="issue-attachments">
            <View className="flex-row items-center justify-between gap-2">
                <SectionTitle>Attachments</SectionTitle>
                <Pressable
                    testID="issue-attach"
                    accessibilityRole="button"
                    accessibilityLabel={ATTACH_TO_ISSUE}
                    accessibilityState={{ expanded: menu, disabled, busy: tray.busy }}
                    disabled={disabled}
                    onPress={() => setMenu(!menu)}
                    className={cx(
                        'size-11 items-center justify-center rounded-md border border-border bg-card',
                        'active:bg-accent dark:active:bg-accent/50',
                        menu && 'bg-accent',
                    )}
                    style={{ opacity: disabled ? 0.5 : 1 }}
                >
                    <AppSymbol name="paperclip" size={16} />
                </Pressable>
            </View>
            {menu ? (
                <AttachMenu
                    testID="issue-attach"
                    onPick={(source) => {
                        setMenu(false);
                        tray.add(source);
                    }}
                />
            ) : null}
            {tray.notice === null ? null : (
                <Text variant="footnote" tone="destructive" testID="issue-attach-notice">
                    {tray.notice}
                </Text>
            )}
            <AttachmentTray tray={tray} testID="issue-attach-tray" />
            {view.files.length === 0 && tray.items.length === 0 ? (
                <Text variant="footnote" tone="muted" testID="issue-files-empty">
                    {NO_FILES}
                </Text>
            ) : (
                <Files files={view.files} testID="issue-files" />
            )}
        </View>
    );
}

function Picture({ file, onOpen }: { file: DetailFile; onOpen: () => void }) {
    const picture = useAttachmentPicture(file.id, null, 'issue');
    const muted = theme[useScheme()].tones.slate;
    return (
        <Pressable
            testID={`issue-picture-${file.id}`}
            accessibilityRole="imagebutton"
            accessibilityLabel={`View ${file.name}`}
            onPress={onOpen}
            disabled={picture.state !== 'ready'}
        >
            {picture.state === 'ready' ? (
                <SquircleImage size={PICTURE} source={{ uri: picture.uri }} />
            ) : (
                <Squircle size={PICTURE} color={muted.tint}>
                    <AppSymbol
                        name={picture.state === 'loading' ? 'image' : 'image-off'}
                        size={24}
                        color="muted-foreground"
                    />
                </Squircle>
            )}
        </Pressable>
    );
}

/** What members see of the fields (the web's ReadOnlyFields); admins get AdminFields. */
function Fields({ view }: { view: IssueDetailView }) {
    return (
        <View className="gap-2" testID="issue-fields">
            <SectionTitle>Details</SectionTitle>
            <GroupedCard>
                {view.fields.map((field, index) => (
                    <View
                        key={field.label}
                        accessible
                        accessibilityLabel={`${field.label}, ${field.value}`}
                        className="min-h-11 flex-row items-center gap-3 p-3"
                    >
                        {index > 0 ? <RowSeparator inset={ROW_INSET} /> : null}
                        <Text variant="subheadline" tone="muted" className="w-24">
                            {field.label}
                        </Text>
                        {field.chips === undefined ? (
                            <Text className="min-w-0 flex-1">{field.value}</Text>
                        ) : (
                            <ComponentChipList chips={field.chips} testID="issue-components" />
                        )}
                    </View>
                ))}
            </GroupedCard>
        </View>
    );
}

/**
 * The automatic triage proposal (the web's IssueTriage), read-only: the proposed kind, area,
 * priority and labels, the suggested components (CB-442) the reader may see, the model's line,
 * then who decided, or what happens next. Admins apply or ignore it on the web for now.
 */
function Triage({ view }: { view: IssueDetailView }) {
    const triage = view.triage;
    if (triage === null) {
        return null;
    }
    return (
        // A group on the page's grouped colors, as the fields.
        <GroupedCard>
            <View accessible accessibilityLabel={triage.accessibilityLabel} className="gap-2 p-3" testID="issue-triage">
                <Text variant="subheadline" weight="medium" tone="muted">
                    {triage.title}
                </Text>
                <View className="flex-row flex-wrap items-center gap-1">
                    {triage.tags.map((tag) => (
                        <View key={tag} className="rounded-sm bg-muted px-1.5">
                            <Text variant="footnote" tone="muted">
                                {tag}
                            </Text>
                        </View>
                    ))}
                    {triage.components.map((chip) => (
                        <ComponentChip key={chip.ref} chip={chip} testID={`issue-triage-component-${chip.ref}`} />
                    ))}
                </View>
                <Text variant="footnote" tone="muted">
                    {triage.reason}
                </Text>
                {triage.decided === null && triage.note === null ? null : (
                    <Text variant="footnote" tone={triage.decided === null ? 'muted' : 'default'}>
                        {triage.decided ?? triage.note}
                    </Text>
                )}
            </View>
        </GroupedCard>
    );
}

/** Blocked by, blocks and related: rows that open the linked issue (read-only here). */
function Links({ view, onOpen }: { view: IssueDetailView; onOpen: (key: string) => void }) {
    if (view.links.length === 0) {
        return null;
    }
    return (
        <View className="gap-2" testID="issue-links">
            <SectionTitle>Links</SectionTitle>
            <GroupedCard>
                {view.links.map((link, index) => (
                    <Pressable
                        key={`${link.relation}-${link.key}`}
                        testID={`issue-link-${link.key}`}
                        accessibilityRole="button"
                        accessibilityLabel={link.accessibilityLabel}
                        onPress={() => onOpen(link.key)}
                        className="min-h-11 gap-0.5 p-3 active:bg-accent"
                    >
                        {index > 0 ? <RowSeparator inset={ROW_INSET} /> : null}
                        <Text variant="footnote" tone="muted">
                            {`${link.relation} · ${link.label} · ${link.status}`}
                        </Text>
                        <Text weight="medium" numberOfLines={2}>
                            {link.title}
                        </Text>
                    </Pressable>
                ))}
            </GroupedCard>
        </View>
    );
}

function Comments({ view, issueKey: key }: { view: IssueDetailView; issueKey: string }) {
    return (
        <View className="gap-2" testID="issue-comments">
            <SectionTitle>{`Comments (${view.comments.length})`}</SectionTitle>
            {view.comments.length === 0 ? (
                <Text variant="subheadline" tone="muted">
                    {NO_COMMENTS}
                </Text>
            ) : (
                view.comments.map((comment) => <CommentView key={comment.id} comment={comment} issueKey={key} />)
            )}
        </View>
    );
}

function CommentView({ comment, issueKey: key }: { comment: DetailComment; issueKey: string }) {
    const { outbox } = useWorkspaceScope();
    const [text, setText] = useState<string | null>(null);
    const [error, setError] = useState<string | undefined>();
    const save = () => {
        if (text === null) {
            return;
        }
        editComment(outbox, { issue: key, commentId: comment.id, newId: randomId, text })
            .then(() => setText(null))
            .catch(refused(CommentError, setError, 'the comment was not saved'));
    };
    const remove = () =>
        Alert.alert('Delete this comment?', 'It’s removed for everyone.', [
            { text: 'Cancel', style: 'cancel' },
            {
                text: 'Delete',
                style: 'destructive',
                onPress: () =>
                    void deleteComment(outbox, { issue: key, commentId: comment.id, newId: randomId }).catch(
                        failed('the comment was not deleted'),
                    ),
            },
        ]);
    return (
        <View
            className={cx(
                'gap-2 rounded-xl border bg-card p-3',
                comment.pending ? 'border-dashed border-border' : 'border-border',
            )}
            testID={`issue-comment-${comment.id}`}
        >
            <View className="flex-row flex-wrap items-center gap-x-2">
                <Text variant="subheadline" weight="semibold">
                    {comment.author}
                </Text>
                <Text variant="meta">{comment.edited ? `${comment.when} (edited)` : comment.when}</Text>
            </View>
            {text === null ? (
                <ReplyMarkdown text={comment.body} prose="issue" />
            ) : (
                <View className="gap-2">
                    <Field
                        label="Edit comment"
                        value={text}
                        onChangeText={(next) => {
                            setText(next);
                            setError(undefined);
                        }}
                        multiline
                        maxLength={10_000}
                        autoFocus
                        error={error}
                        testID="issue-comment-field"
                    />
                    <EditButtons onCancel={() => setText(null)} onSave={save} testID="issue-comment" />
                </View>
            )}
            <Files files={comment.files} testID={`issue-comment-files-${comment.id}`} />
            <Pending words={comment.pending} />
            {text === null && (comment.canEdit || comment.canDelete) ? (
                <View className="-mr-3 -mb-3 flex-row justify-end">
                    {comment.canEdit ? (
                        <Button
                            variant="ghost"
                            label="Edit"
                            onPress={() => setText(comment.body)}
                            testID={`issue-comment-edit-${comment.id}`}
                        />
                    ) : null}
                    {comment.canDelete ? (
                        <Button
                            variant="ghost"
                            label="Delete"
                            onPress={remove}
                            testID={`issue-comment-delete-${comment.id}`}
                        />
                    ) : null}
                </View>
            ) : null}
        </View>
    );
}

function History({ view }: { view: IssueDetailView }) {
    return (
        <View className="gap-2" testID="issue-history">
            <SectionTitle>{`History (${view.history.length})`}</SectionTitle>
            {view.history.length === 0 ? (
                <Text variant="subheadline" tone="muted">
                    {NO_HISTORY}
                </Text>
            ) : (
                view.history.map((event) => (
                    <View key={event.id} accessible className="gap-0.5 border-l-2 border-border pl-3">
                        <Text variant="subheadline">
                            <Text variant="subheadline" weight="semibold">
                                {event.actor}
                            </Text>
                            {` ${event.text}`}
                        </Text>
                        <Text variant="meta">{event.when}</Text>
                    </View>
                ))
            )}
        </View>
    );
}

/** The comment box (the issue's draft, `issue-comments:<key>`) with the chat's tray: sent through the outbox. */
function CommentBox({ issueKey: key, detail }: { issueKey: string; detail: IssueDetail | null }) {
    const scope = useWorkspaceScope();
    const scopeName = issueCommentsDraft(key);
    const draft = useDraft(scopeName);
    const tray = useTray(scopeName);
    const [busy, setBusy] = useState(false);
    const [notice, setNotice] = useState<string | null>(null);
    const view = composerView({
        text: draft.text,
        running: false,
        locked: draft.locked || !scope.userDb.writable,
        heldForSignIn: false,
        busy,
        files: tray.items.filter((file) => !file.failed).length,
    });
    const send = () => {
        setNotice(null);
        setBusy(true);
        commentWithFiles({
            outbox: scope.outbox,
            drafts: scope.drafts,
            attachments: scope.attachments,
            newId: randomId,
            issue: key,
            authorId: scope.workspace.appUserId,
            serverAt: scope.serverClock.lastDate(),
            seen: seenComments(detail),
            seenFiles: seenAttachments(detail),
        })
            .catch((error: unknown) => {
                if (error instanceof CommentError) {
                    setNotice(error.message);
                    return;
                }
                console.warn('[issue] the comment was not saved', error);
                setNotice(SEND_FAILED);
            })
            .finally(() => setBusy(false));
    };
    return (
        <Composer
            text={draft.text}
            onChangeText={draft.setText}
            view={view}
            onSend={send}
            onStop={() => {}}
            notice={notice}
            tray={tray}
            placeholder="Add a comment"
            send="primary"
            testID="issue-composer"
        />
    );
}
