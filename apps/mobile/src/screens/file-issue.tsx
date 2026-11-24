import { StackActions, type StaticScreenProps, useNavigation, usePreventRemove } from '@react-navigation/native';
import { TextInputWrapper } from 'expo-paste-input';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { Platform, Pressable, ScrollView, type TextInputInstance, View } from 'react-native';
import { KeyboardAvoidingView } from 'react-native-keyboard-controller';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { MODULE_IDS } from '@socio/shared/modules';

import { trayItems } from '../chat/attachment-tray';
import {
    useCollections,
    useHasWorkspaceScope,
    useIssueComponentOptions,
    useLiveQuery,
    useUnsent,
    useWorkspaceScope,
} from '../live';
import { pageSheetTopInset } from '../navigation/presets';
import { isHandOff } from '../navigation/shell-actions';
import { randomId } from '../platform/crypto';
import {
    AREA_CHOICES,
    BODY_PLACEHOLDER,
    CANCEL_DRAFT_QUESTION,
    cancelIssue,
    type Choice,
    DISCARD_DRAFT,
    discardIssueDraft,
    EDIT_GONE,
    editIssueFields,
    FILE_FAILED,
    FILE_ISSUE_HINT,
    fileIssueView,
    ISSUE_BODY_MAX,
    ISSUE_TITLE_MAX,
    issueFormFields,
    KEEP_DRAFT,
    KIND_CHOICES,
    openIssueFor,
    PRIORITY_CHOICES,
    TITLE_PLACEHOLDER,
    withIssueField,
} from '../shell/file-issue';
import { componentChip } from '../shell/issue-components';
import { issueParam } from '../shell/last-screen';
import { moduleEntry } from '../shell/modules';
import { issueComponentsQuery, issuesQuery } from '../shell/queries';
import {
    attachToIssue,
    fileIssueWithFiles,
    heldIssueFiles,
    issueEditTray,
    removeHeldFile,
    resendIssueWithFiles,
} from '../sync/issue-attachments';
import { highestIssue, ISSUE_DRAFT, IssueDraftError, type IssueFields } from '../sync/issue-create';
import { Button, Field, keyboardScroll, Text, ToneTile } from '../ui';
import { cx } from '../ui/cx';

import { useActionMenu } from './action-menu';
import { AttachMenu, AttachmentTray, type Tray, useCarriedFiles, useTray } from './attachments';
import { useDraft } from './chat-composer';
import { ComponentField, componentSheet } from './issue-components';
import { MODULE_ICONS } from './module-icons';
import { useRouteSheet } from './route-sheet';

// Filing an issue: the FileIssue
// modal, a ChatGPT-style compose screen over the Board. Its view model is
// src/shell/file-issue.ts. The form is the web's ReportForm: title,
// description, kind, priority and area, "Plugins and apps" (CB-442: a row
// that opens the picker's native sheet, shown once the issue list says the
// server has components, so an older server's strict create never sees the
// field), then the files (the chat's three pickers
// and T3 Code's tray, through the issue attachments' processor; an image pasted into a
// field goes there too). What is typed is the `issue:new` draft, so Cancel
// and a kill keep it; Cancel with text in a field or a file in the tray asks
// Keep draft or Discard first (`cancelIssue`, the action menu). File queues the issue's create with its attachment rows in one
// transaction (works offline) and lands on the issue's screen under `CB-?`.
// A refused filing's Edit (`edit`, its local key) opens on what was written,
// with its tray restored from its files' rows (`useHeldTray`): Remove discards
// that file's row, Add queues one behind the filing at once. Send again
// queues any file still in the tray, then changes the filing in place
// (`resendIssueWithFiles`), so every file the tray shows follows it.

const ISSUES_MODULE = moduleEntry(MODULE_IDS.issues);

export function FileIssueScreen({ route }: StaticScreenProps<{ runId?: string; edit?: string } | undefined>) {
    const navigation = useNavigation();
    if (!useHasWorkspaceScope()) {
        return null;
    }
    const edit = route.params?.edit;
    return edit === undefined ? (
        <NewIssue runId={route.params?.runId ?? null} />
    ) : (
        <EditIssue key={edit} id={edit} onDone={() => navigation.goBack()} />
    );
}

/** A new filing: the `issue:new` draft and its tray. */
function NewIssue({ runId }: { runId: string | null }) {
    const navigation = useNavigation();
    const scope = useWorkspaceScope();
    const collections = useCollections();
    const { data: issues } = useLiveQuery({ query: issuesQuery(collections) });
    const draft = useDraft(ISSUE_DRAFT);
    const tray = useTray(ISSUE_DRAFT);
    const menu = useActionMenu();
    const [busy, setBusy] = useState(false);
    const [notice, setNotice] = useState<string | null>(null);
    const fields = issueFormFields(draft.text);
    // The box links to the run it was opened for, or to none (`forRun`).
    useEffect(() => {
        openIssueFor(scope.drafts, runId);
    }, [runId, scope]);
    const view = fileIssueView({
        fields,
        editing: false,
        busy,
        picking: tray.busy,
        editable: !draft.locked && scope.userDb.writable,
    });
    const change = (patch: Partial<IssueFields>) => draft.setText(withIssueField(draft.text, patch));
    // Cancel, a swipe down on the page sheet and Back all ask Keep draft or
    // Discard while something is written (CB-421: the sheet then won't swipe
    // away without asking); filing, which replaces the sheet, never asks.
    usePreventRemove(cancelIssue(fields, tray.items.length) === 'ask', ({ data }) => {
        if (data.action.type === 'REPLACE' || isHandOff(data.action)) {
            navigation.dispatch(data.action);
            return;
        }
        menu.open({
            title: CANCEL_DRAFT_QUESTION,
            actions: [KEEP_DRAFT, DISCARD_DRAFT],
            onAction: (name) => {
                if (name === DISCARD_DRAFT.name) {
                    discardIssueDraft(scope.drafts, scope.attachments).catch((error: unknown) =>
                        console.warn('[file-issue] draft not discarded', error),
                    );
                }
                navigation.dispatch(data.action);
            },
        });
    });
    const file = () => {
        setNotice(null);
        setBusy(true);
        fileIssueWithFiles({
            drafts: scope.drafts,
            attachments: scope.attachments,
            newId: randomId,
            reporterId: scope.workspace.appUserId,
            after: highestIssue(issues),
            serverAt: scope.serverClock.lastDate(),
        })
            .then((filed) => {
                if (filed === null) {
                    setNotice(FILE_FAILED);
                    return;
                }
                // The issue's screen, under `CB-?` until its create resolves.
                navigation.dispatch(StackActions.replace('Issue', { key: issueParam(filed.localKey) }));
            })
            .catch((error: unknown) => {
                if (error instanceof IssueDraftError) {
                    setNotice(error.message);
                    return;
                }
                console.warn('[file-issue] not filed', error);
                setNotice(FILE_FAILED);
            })
            .finally(() => setBusy(false));
    };
    return (
        <Form
            heading={view.heading}
            lead={view.lead}
            action={view.action}
            canFile={view.canFile}
            busy={busy}
            onFile={file}
            onCancel={() => navigation.goBack()}
            notice={notice ?? tray.notice}
            fields={fields}
            titleHint={view.titleHint}
            editable={view.editable}
            onChange={change}
            tray={tray}
        >
            <Files tray={tray} editable={view.editable} />
            {menu.element}
        </Form>
    );
}

/** A refused filing's Edit: what was written, in memory; Send again changes the row in place. */
function EditIssue({ id, onDone }: { id: string; onDone: () => void }) {
    const scope = useWorkspaceScope();
    const { outbox } = scope;
    // A filing refused because its run is gone opens without the link (`editIssueFields`).
    const [opened] = useState(() => {
        const write = outbox.unsent().find((item) => item.id === id);
        return write === undefined ? null : editIssueFields(write);
    });
    const [fields, setFields] = useState<IssueFields | null>(opened?.fields ?? null);
    const [busy, setBusy] = useState(false);
    const [notice, setNotice] = useState<string | null>(fields === null ? EDIT_GONE : null);
    const tray = useHeldTray(id);
    const shown = fields ?? issueFormFields('');
    const view = fileIssueView({
        fields: shown,
        editing: true,
        busy,
        picking: tray.busy,
        editable: fields !== null,
        runUnlinked: opened?.runUnlinked ?? false,
    });
    const send = () => {
        if (fields === null) {
            return;
        }
        setNotice(null);
        setBusy(true);
        // A pick whose own queueing failed is still in the tray: it goes now, before the filing.
        resendIssueWithFiles({
            outbox,
            attachments: scope.attachments,
            newId: randomId,
            uploaderId: scope.workspace.appUserId,
            serverAt: scope.serverClock.lastDate(),
            id,
            fields,
            idempotencyKey: randomId(),
        })
            .then((sent) => {
                if (sent) {
                    onDone();
                } else {
                    setNotice(EDIT_GONE);
                }
            })
            .catch((error: unknown) => {
                console.warn('[file-issue] not sent again', error);
                setNotice(FILE_FAILED);
            })
            .finally(() => setBusy(false));
    };
    return (
        <Form
            heading={view.heading}
            lead={view.lead}
            action={view.action}
            canFile={view.canFile}
            busy={busy}
            onFile={send}
            onCancel={onDone}
            notice={notice ?? tray.notice}
            fields={shown}
            titleHint={view.titleHint}
            editable={view.editable}
            onChange={(patch) => setFields(fields === null ? null : { ...fields, ...patch })}
            tray={fields === null ? null : tray}
        >
            <Files tray={tray} editable={view.editable} />
        </Form>
    );
}

/**
 * A refused filing's tray, restored: the files its rows hold, then any
 * a pick is still copying. Remove discards that file's row (the attachments' sweep deletes
 * the copy); a pick goes into `issueEditTray` and from there into a row of its
 * own at once, waiting on the filing's local key, so it follows Send again.
 */
function useHeldTray(localKey: string): Tray {
    const scope = useWorkspaceScope();
    const { outbox, attachments } = scope;
    const held = heldIssueFiles(useUnsent().groups, localKey);
    const draft = issueEditTray(localKey);
    const warn = (what: string) => (error: unknown) => console.warn(`[file-issue] ${what}`, error);
    const picking = useTray(draft, {
        existing: held.length,
        onAdded: () => {
            attachToIssue({
                outbox,
                attachments,
                newId: randomId,
                issue: localKey,
                uploaderId: scope.workspace.appUserId,
                serverAt: scope.serverClock.lastDate(),
                draft,
            }).catch(warn('file not queued'));
        },
    });
    const carried = useCarriedFiles(held.map((file) => file.rowId));
    return {
        ...picking,
        items: [...trayItems(carried), ...picking.items],
        remove: (fileId) => {
            const file = held.find((item) => item.fileId === fileId);
            if (file === undefined) {
                picking.remove(fileId);
                return;
            }
            removeHeldFile(outbox, file.rowId).catch(warn('file not removed'));
        },
    };
}

/** The modal's frame: Cancel, the heading and File on top, then the fields, the choices and the files. */
function Form(props: {
    heading: string;
    lead: string;
    action: string;
    canFile: boolean;
    busy: boolean;
    onFile: () => void;
    onCancel: () => void;
    notice: string | null;
    fields: IssueFields;
    titleHint: string | null;
    editable: boolean;
    onChange: (patch: Partial<IssueFields>) => void;
    tray: Tray | null;
    children: ReactNode;
}) {
    const insets = useSafeAreaInsets();
    const { fields, tray } = props;
    const collections = useCollections();
    const { data: componentLabels } = useLiveQuery({ query: issueComponentsQuery(collections) });
    const chosen = fields.components ?? [];
    // Components (CB-442): only from a server that has them (its list carries their labels).
    const offersComponents = (componentLabels[0]?.value ?? null) !== null || chosen.length > 0;
    const options = useIssueComponentOptions(false);
    // The picker's set while it shows: each tap changes the box from it, never from a drawn one.
    const [picking, setPicking] = useState<string[] | null>(null);
    useRouteSheet(
        picking === null
            ? null
            : componentSheet({
                  value: picking,
                  onChange: (refs) => {
                      setPicking(refs);
                      props.onChange({ components: refs });
                  },
                  onClose: () => setPicking(null),
              }),
        () => setPicking(null),
    );
    // The title's Next moves to the description, keeping the keyboard up; the description's Return types a new line.
    const bodyField = useRef<TextInputInstance>(null);
    const pasted = (field: ReactNode) =>
        tray === null ? (
            field
        ) : (
            // An image pasted into a field joins the tray (CB-358); text pastes as usual.
            <TextInputWrapper
                onPaste={(payload) => {
                    if (payload.type === 'images') {
                        tray.paste(payload.uris);
                    }
                }}
            >
                {field}
            </TextInputWrapper>
        );
    return (
        <View testID="file-issue-screen" className="flex-1 bg-screen" collapsable={false}>
            <View
                className="bg-header"
                style={{
                    paddingTop: pageSheetTopInset(Platform.OS, insets.top),
                    paddingLeft: insets.left,
                    paddingRight: insets.right,
                }}
            >
                <View className="h-16 flex-row items-center gap-2 px-4">
                    <Button variant="ghost" label="Cancel" onPress={props.onCancel} testID="file-issue-cancel" />
                    <Text accessibilityRole="header" numberOfLines={1} className="min-w-0 flex-1 text-center">
                        {props.heading}
                    </Text>
                    <Button
                        label={props.action}
                        onPress={props.onFile}
                        disabled={!props.canFile}
                        busy={props.busy}
                        testID="file-issue-submit"
                    />
                </View>
            </View>
            <KeyboardAvoidingView behavior="padding" automaticOffset style={{ flex: 1 }}>
                <ScrollView
                    className="flex-1"
                    contentContainerClassName="gap-5 p-4"
                    contentContainerStyle={{ paddingBottom: 16 + insets.bottom }}
                    {...keyboardScroll(Platform.OS)}
                    testID="file-issue-scroll"
                >
                    <View className="flex-row items-center gap-3">
                        <ToneTile tone={ISSUES_MODULE.tone} icon={MODULE_ICONS[ISSUES_MODULE.icon]} />
                        <Text variant="subheadline" tone="muted" className="min-w-0 flex-1" testID="file-issue-lead">
                            {props.lead}
                        </Text>
                    </View>
                    {props.notice === null ? null : (
                        <Text tone="destructive" accessibilityLiveRegion="polite" testID="file-issue-notice">
                            {props.notice}
                        </Text>
                    )}
                    {pasted(
                        <Field
                            label="Title"
                            value={fields.title}
                            onChangeText={(title) => props.onChange({ title })}
                            placeholder={TITLE_PLACEHOLDER}
                            maxLength={ISSUE_TITLE_MAX}
                            editable={props.editable}
                            returnKeyType="next"
                            submitBehavior="submit"
                            onSubmitEditing={() => bodyField.current?.focus()}
                            {...(props.titleHint === null ? {} : { hint: props.titleHint })}
                            testID="file-issue-title"
                        />,
                    )}
                    {pasted(
                        <Field
                            ref={bodyField}
                            label="Description"
                            value={fields.body}
                            onChangeText={(body) => props.onChange({ body })}
                            placeholder={BODY_PLACEHOLDER}
                            maxLength={ISSUE_BODY_MAX}
                            editable={props.editable}
                            multiline
                            numberOfLines={5}
                            textAlignVertical="top"
                            testID="file-issue-body"
                        />,
                    )}
                    <Choices
                        label="Kind"
                        choices={KIND_CHOICES}
                        value={fields.kind}
                        disabled={!props.editable}
                        onChoose={(kind) => props.onChange({ kind })}
                    />
                    <Choices
                        label="Priority"
                        choices={PRIORITY_CHOICES}
                        value={fields.priority}
                        disabled={!props.editable}
                        onChoose={(priority) => props.onChange({ priority })}
                    />
                    <Choices
                        label="Area"
                        choices={AREA_CHOICES}
                        value={fields.area}
                        disabled={!props.editable}
                        onChoose={(area) => props.onChange({ area })}
                    />
                    {offersComponents ? (
                        <ComponentField
                            chips={chosen.map((ref) => componentChip(ref, undefined, options.value?.options))}
                            disabled={!props.editable}
                            onPress={() => setPicking([...chosen])}
                        />
                    ) : null}
                    {props.children}
                </ScrollView>
            </KeyboardAvoidingView>
        </View>
    );
}

/** One of the web's choice fields as a row of chips: radios, the chosen one filled. */
function Choices<T extends string | null>(props: {
    label: string;
    choices: readonly Choice<T>[];
    value: T;
    disabled: boolean;
    onChoose: (value: T) => void;
}) {
    return (
        <View className="gap-2" accessibilityRole="radiogroup" accessibilityLabel={props.label}>
            <Text weight="medium" accessibilityElementsHidden importantForAccessibility="no">
                {props.label}
            </Text>
            <View className="flex-row flex-wrap gap-2">
                {props.choices.map((choice) => {
                    const on = choice.value === props.value;
                    return (
                        <Pressable
                            key={choice.testID}
                            testID={choice.testID}
                            accessibilityRole="radio"
                            accessibilityLabel={choice.label}
                            accessibilityState={{ checked: on, disabled: props.disabled }}
                            disabled={props.disabled}
                            onPress={() => props.onChoose(choice.value)}
                            className={cx(
                                'min-h-11 flex-row items-center rounded-full border px-4',
                                on ? 'border-primary bg-primary/10' : 'border-border active:bg-accent/50',
                                props.disabled && 'opacity-50',
                            )}
                        >
                            <Text
                                variant="subheadline"
                                weight={on ? 'medium' : 'normal'}
                                tone={on ? 'default' : 'muted'}
                            >
                                {choice.label}
                            </Text>
                        </Pressable>
                    );
                })}
            </View>
        </View>
    );
}

/** The files: Photos, Camera and Files, the hint, then the tray. */
function Files({ tray, editable }: { tray: Tray; editable: boolean }) {
    return (
        <View className="gap-2" testID="file-issue-files">
            <Text weight="medium" accessibilityRole="header">
                Files
            </Text>
            {editable ? <AttachMenu onPick={(source) => tray.add(source)} /> : null}
            <Text variant="footnote" tone="muted">
                {FILE_ISSUE_HINT}
            </Text>
            <AttachmentTray tray={tray} />
        </View>
    );
}
