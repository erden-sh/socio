import { useNavigation } from '@react-navigation/native';
import type { StaticScreenProps } from '@react-navigation/native';
import { View } from 'react-native';

import { MODULE_IDS } from '@socio/shared/modules';

import { GONE } from '../chat/approval-card';
import { useCollections, useHasWorkspaceScope, useLiveQuery, useSyncOnFocus, useSyncRefresh } from '../live';
import { useNativeBar } from '../navigation/native-bar';
import {
    approvalsList,
    NO_DECISIONS,
    NOTHING_WAITING,
    READ_WHEN_ONLINE,
    READING_REQUEST,
    RECENT_TITLE,
    WAITING_TITLE,
} from '../shell/approvals';
import { moduleEntry } from '../shell/modules';
import { Screen, Text, usePullToRefresh } from '../ui';

import { ApprovalCardById, useChatApprovals } from './approval-card';
import { MODULE_ICONS } from './module-icons';
import { PageIntro, StatusBanners } from './shell-parts';

// The approvals list and one request's page (src/shell/approvals.ts says
// which show, in what order), each card the chat's approval card, with its
// watch, Deny, Approve, Open details (the ApprovalDetails sheet) and Undo:
// - `ApprovalsScreen`, `/approvals`, from the Inbox's See all and More: the
//   requests waiting, then the recent decisions. The approvals kind is in
//   view while it shows, so it is pulled every 60 s.
// - `ApprovalScreen`, `/approvals/:id`, from an Inbox row or a link (a
//   notice's, Telegram's): the one request, read at once when the device
//   doesn't hold it; "This request isn't there any more." when the server
//   says so (someone else's request reads the same).

const SYNCED = ['approvals'] as const;
const MODULE = moduleEntry(MODULE_IDS.approvals);
/** The list's description, the web ApprovalsPage's. */
export const APPROVALS_INTRO =
    'Actions with side effects wait for you: a new dataset, changes to a shared one, access to your data. Approve or deny them here or in the chat, or let auto review decide the routine ones. Reading and querying data a socio may use never needs approval.';
const EDGES = ['right', 'bottom', 'left'] as const;

export function ApprovalsScreen() {
    useNativeBar({ title: MODULE.title, tone: MODULE.tone });
    return useHasWorkspaceScope() ? (
        <ScopedApprovals />
    ) : (
        <Screen testID="approvals-screen" edges={EDGES}>
            {null}
        </Screen>
    );
}

/** The list with pull to refresh: it pulls the approvals kind now. */
function ScopedApprovals() {
    const refreshControl = usePullToRefresh(useSyncRefresh(SYNCED));
    return (
        <Screen testID="approvals-screen" edges={EDGES} refreshControl={refreshControl}>
            <ApprovalsList />
        </Screen>
    );
}

function ApprovalsList() {
    const collections = useCollections();
    const navigation = useNavigation();
    useSyncOnFocus(SYNCED);
    const { data: rows } = useLiveQuery({ query: (q) => q.from({ approval: collections.approvals }) });
    const list = approvalsList(rows);
    const ids = [...list.waiting, ...list.recent].map((view) => view.id);
    const approvals = useChatApprovals(
        ids,
        () => {},
        (id) => navigation.navigate('ApprovalDetails', { id }),
    );
    return (
        <>
            <StatusBanners />
            <PageIntro
                subtitle={APPROVALS_INTRO}
                subtitleLines={0}
                tile={{ tone: MODULE.tone, icon: MODULE_ICONS[MODULE.icon] }}
                testID="approvals-heading"
            />
            <View className="gap-2" testID="approvals-waiting">
                <Text accessibilityRole="header" variant="footnote" weight="medium" tone="muted">
                    {list.waitingLabel === null ? WAITING_TITLE : `${WAITING_TITLE} · ${list.waitingLabel}`}
                </Text>
                {list.waiting.length === 0 ? (
                    <Text variant="subheadline" tone="muted">
                        {NOTHING_WAITING}
                    </Text>
                ) : (
                    list.waiting.map((view) => (
                        <ApprovalCardById
                            key={view.id}
                            id={view.id}
                            approvals={approvals}
                            testID={`approval-${view.id}`}
                        />
                    ))
                )}
            </View>
            <View className="gap-2" testID="approvals-recent">
                <Text accessibilityRole="header" variant="footnote" weight="medium" tone="muted">
                    {RECENT_TITLE}
                </Text>
                {list.recent.length === 0 ? (
                    <Text variant="subheadline" tone="muted">
                        {NO_DECISIONS}
                    </Text>
                ) : (
                    list.recent.map((view) => (
                        <ApprovalCardById
                            key={view.id}
                            id={view.id}
                            approvals={approvals}
                            testID={`approval-${view.id}`}
                        />
                    ))
                )}
            </View>
        </>
    );
}

export function ApprovalScreen({ route }: StaticScreenProps<{ id: string }>) {
    return (
        <Screen testID="approval-screen" edges={EDGES}>
            {useHasWorkspaceScope() ? <OneApproval id={route.params.id} /> : null}
        </Screen>
    );
}

function OneApproval({ id }: { id: string }) {
    const navigation = useNavigation();
    const approvals = useChatApprovals(
        [id],
        () => {},
        (requestId) => navigation.navigate('ApprovalDetails', { id: requestId }),
    );
    const known = approvals.views.has(id);
    const waitingWord = approvals.context(id).blocked === 'offline' ? READ_WHEN_ONLINE : READING_REQUEST;
    return (
        <>
            <StatusBanners />
            {known ? (
                <ApprovalCardById id={id} approvals={approvals} testID="approval-request" />
            ) : (
                <Text
                    variant="subheadline"
                    tone="muted"
                    accessibilityLiveRegion="polite"
                    testID="approval-request-state"
                >
                    {approvals.gone.has(id) ? GONE : waitingWord}
                </Text>
            )}
        </>
    );
}
