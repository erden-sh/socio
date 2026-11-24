import { type StaticScreenProps, useNavigation } from '@react-navigation/native';
import { useState } from 'react';
import { Platform, ScrollView, View } from 'react-native';

import { MODULE_IDS } from '@socio/shared/modules';

import {
    useCollections,
    useHasWorkspaceScope,
    useLiveQuery,
    useScheduleDetail,
    useSyncRefresh,
    useWorkspaceScope,
} from '../live';
import { useNativeBar } from '../navigation/native-bar';
import { scheduleAction, taskAction } from '../navigation/tabs';
import { useFirstFrameWithData } from '../platform/cold-start';
import { moduleEntry } from '../shell/modules';
import { shellQuery, shellRows } from '../shell/queries';
import {
    ACTIVITY_EMPTY_LINE,
    ACTIVITY_EMPTY_TITLE,
    ACTIVITY_INTRO,
    ACTIVITY_TITLE,
    activityRows,
    TASK_REPEAT_ON_WEB,
    taskButtons,
    taskDetailView,
} from '../shell/schedules';
import { actOnTask } from '../sync/schedule-writes';
import { useScheme } from '../theme/scheme';
import { theme, type ToneName } from '../theme/theme';
import { Button, Field, AppSymbol, keyboardScroll, Text, usePullToRefresh } from '../ui';

import { MODULE_ICONS } from './module-icons';
import {
    Age,
    Card,
    DetailEmpty,
    Notice,
    StatusChip,
    useOnlineAction,
    useRefreshOnRowChange,
    WebRow,
} from './schedule-parts';
import { ListRow, PageIntro, Section, StatusBanners, useRememberScreen } from './shell-parts';

// Scheduled & activity, the `Activity` route at the
// web's /activity, from More, Home's Scheduled tile and Search, in the
// module's amber: the shell's `state.tasks` (already polled with `/api/state`)
// searched over the prompt as the web does. A row opens the task's page
// (`Task`, no path): its detail from the `task-details` bounded kind, shown
// offline with its age, and its actions, all online only; its repeat
// interval opens the web.

const MODULE = moduleEntry(MODULE_IDS.activity);
const SHELL_KINDS = ['shell'] as const;

export function ActivityScreen() {
    return useHasWorkspaceScope() ? <Activity /> : <Unscoped title={ACTIVITY_TITLE} testID="activity-screen" />;
}

function Unscoped({ title, testID }: { title: string; testID: string }) {
    useNativeBar({ title });
    return <View testID={testID} className="flex-1 bg-screen" collapsable={false}></View>;
}

function useTasks() {
    const collections = useCollections();
    const { data: shell } = useLiveQuery({ query: shellQuery(collections) });
    return shellRows(shell).state;
}

function Activity() {
    const navigation = useNavigation();
    const { scheduleDetails } = useWorkspaceScope();
    useRememberScreen('Activity');
    const state = useTasks();
    const [query, setQuery] = useState('');
    const tasks = state?.tasks ?? [];
    const rows = activityRows(tasks, query, Date.now());
    useFirstFrameWithData('Activity', state !== null);
    const open = (id: string) => {
        scheduleDetails.tasks
            .preload(id)
            .catch((error: unknown) => console.warn('[activity] not read from disk', error));
        navigation.dispatch(taskAction(id));
    };
    useNativeBar({ title: ACTIVITY_TITLE, tone: MODULE.tone });
    // The tasks are the shell's `state.tasks`: a pull pulls /api/state now.
    const refreshControl = usePullToRefresh(useSyncRefresh(SHELL_KINDS));
    return (
        <View testID="activity-screen" className="flex-1 bg-screen" collapsable={false}>
            <ScrollView
                refreshControl={refreshControl}
                contentInsetAdjustmentBehavior="automatic"
                className="flex-1"
                contentContainerClassName="gap-4 p-4"
                {...keyboardScroll(Platform.OS)}
            >
                <StatusBanners />
                <PageIntro
                    subtitle={ACTIVITY_INTRO}
                    subtitleLines={0}
                    tile={{ tone: MODULE.tone, icon: MODULE_ICONS[MODULE.icon] }}
                    testID="activity-heading"
                />
                {tasks.length === 0 ? null : (
                    <Field
                        label="Search tasks"
                        placeholder="Find a task…"
                        value={query}
                        onChangeText={setQuery}
                        autoCapitalize="none"
                        autoCorrect={false}
                        returnKeyType="search"
                        testID="activity-search"
                    />
                )}
                {rows.length === 0 ? null : (
                    <Section title="Tasks" testID="activity-list">
                        {rows.map((row, index) => {
                            const task = tasks.find((item) => item.id === row.id);
                            const icon =
                                task?.status === 'completed'
                                    ? 'check-check'
                                    : task?.status === 'running'
                                      ? 'loader-circle'
                                      : 'message-circle';
                            return (
                                <ListRow
                                    key={row.id}
                                    first={index === 0}
                                    title={row.title}
                                    subtitle={row.line}
                                    leading={<AppSymbol name={icon} size={20} color="muted-foreground" />}
                                    leadingSize={20}
                                    trailing={<TaskStatus word={row.status} tone={row.statusTone} />}
                                    accessibilityLabel={row.accessibilityLabel}
                                    accessibilityHint="Opens the task"
                                    onPress={() => open(row.id)}
                                    testID={row.testID}
                                />
                            );
                        })}
                    </Section>
                )}
                {state !== null && tasks.length === 0 ? (
                    <View className="items-center gap-2 py-6" testID="activity-empty">
                        <AppSymbol name="clock-3" size={32} color="muted-foreground" />
                        <Text variant="headline" className="text-center">
                            {ACTIVITY_EMPTY_TITLE}
                        </Text>
                        <Text tone="muted" variant="footnote" className="text-center">
                            {ACTIVITY_EMPTY_LINE}
                        </Text>
                    </View>
                ) : null}
            </ScrollView>
        </View>
    );
}

/**
 * A task's status in the list: the web's chip, a dot and the word in the
 * status's tone over its tint, so a scheduled task reads green; the neutral chip
 * for a status with no tone. The word always shows (10.1).
 */
function TaskStatus({ word, tone }: { word: string; tone: ToneName | null }) {
    const colors = theme[useScheme()];
    if (tone === null) {
        return <StatusChip word={word} />;
    }
    const { foreground, tint } = colors.tones[tone];
    return (
        <View
            className="flex-row items-center gap-1.5 self-start rounded-sm px-1.5"
            style={{ backgroundColor: tint }}
            testID="task-status"
        >
            <View className="size-1 rounded-full" style={{ backgroundColor: foreground }} />
            <Text variant="footnote" style={{ color: foreground }}>
                {word}
            </Text>
        </View>
    );
}

export function TaskScreen({ route }: StaticScreenProps<{ taskId: string }>) {
    return useHasWorkspaceScope() ? <Task id={route.params.taskId} /> : <Unscoped title="Task" testID="task-screen" />;
}

function Task({ id }: { id: string }) {
    const navigation = useNavigation();
    const { scheduleDetails } = useWorkspaceScope();
    const state = useTasks();
    const item = useScheduleDetail('tasks', id);
    const row = state?.tasks.find((task) => task.id === id) ?? null;
    const view = taskDetailView(item, row);
    const refresh = () => void scheduleDetails.tasks.item(id).refresh();
    const action = useOnlineAction(refresh);
    // The shell's row moved on (its 5 s poll, an action): read the detail again, as the web reloads it.
    useRefreshOnRowChange(
        row === null ? '' : String(row.updatedAt),
        () => void scheduleDetails.tasks.peek(id)?.refresh(),
    );
    const task = view.task;
    useNativeBar({ title: view.title ?? 'Task' });
    return (
        <View testID="task-screen" className="flex-1 bg-screen" collapsable={false}>
            <ScrollView
                contentInsetAdjustmentBehavior="automatic"
                className="flex-1"
                contentContainerClassName="gap-4 p-4"
                {...keyboardScroll(Platform.OS)}
            >
                <StatusBanners />
                <DetailEmpty state={view.state} testID="task-detail" />
                {task === null ? null : (
                    <>
                        <Card testID="task-detail">
                            <StatusChip word={view.status ?? ''} testID="task-status" />
                            <Text selectable>{view.prompt}</Text>
                            {view.error === null ? null : (
                                <Text variant="footnote" tone="destructive">
                                    {view.error}
                                </Text>
                            )}
                            <Age age={view.age} testID="task-age" />
                            <View className="flex-row flex-wrap gap-2">
                                {taskButtons(task, state?.settings ?? null).map((button) => (
                                    <Button
                                        key={button.label}
                                        variant={button.action === 'cancel' ? 'ghost' : 'secondary'}
                                        label={button.label}
                                        busy={action.busy === button.label}
                                        disabled={button.blocked !== null || action.busy !== null}
                                        accessibilityHint={button.blocked ?? 'Needs a connection'}
                                        onPress={() =>
                                            action.run(button.label, (context) =>
                                                actOnTask(context, {
                                                    taskId: id,
                                                    action: button.action,
                                                    settings: state?.settings ?? null,
                                                }),
                                            )
                                        }
                                        testID={`task-${button.label.toLowerCase().replace(/ /g, '-')}`}
                                    />
                                ))}
                            </View>
                            <Notice words={action.notice} testID="task-notice" />
                        </Card>
                        {view.events.length === 0 ? null : (
                            <Card testID="task-events">
                                {view.events.map((text, index) => (
                                    <Text key={`${index}-${text}`} variant="footnote" tone="muted">
                                        {text}
                                    </Text>
                                ))}
                            </Card>
                        )}
                        <Button
                            variant="secondary"
                            label={
                                view.runs === null ? 'Details and past runs' : `${view.runs} · Details and past runs`
                            }
                            onPress={() => navigation.dispatch(scheduleAction(id))}
                            testID="task-schedule"
                        />
                        <WebRow label={TASK_REPEAT_ON_WEB} href="/activity" testID="task-repeat-web" />
                    </>
                )}
            </ScrollView>
        </View>
    );
}
