import { useEffect, useState } from 'react';
import { Alert, Pressable, View } from 'react-native';

import type { Space } from '@socio/shared/types';

import { CANCEL } from '../chat/long-press';
import { useLiveQuery, useWorkspaceScope } from '../live';
import { AT_TOP, MOVE_TO, MOVE_UNDER, parentChoices } from '../shell/page-menus';
import { pagesQuery } from '../shell/queries';
import { moveDatasetLine, moveDatasetTitle, moveSpaceChoices, type MoveSpaceChoice } from '../shell/space-items';
import { placeDataset } from '../sync/space-items';
import { AppSymbol, Button, Text } from '../ui';
import { cx } from '../ui/cx';

import type { MenuRequest } from './action-menu';
import { useRouteSheet } from './route-sheet';

// Moving a dataset (CB-469, CB-451, who may place): a native sheet (CB-421) with the Spaces the
// person edits, then where in the chosen one (its top, or under one of its pages, from the phone's
// copy, pulled while the sheet shows), and Private for one in a Space. Only a Space's editors see
// Move (`canPlaceIn`); the server checks every placement again, and its 403 explains itself in an
// alert ("Only this Space's editors can add to it."). Online only: a placement changes who can read
// the dataset, so it never waits in the outbox. Afterwards the Spaces it left and joined and the
// Private group are pulled.

export const MOVE_ACTION = { name: 'move', label: 'Move…' } as const;

interface Moving {
    readonly id: string;
    readonly title: string;
    /** The Space it is in, or null in Private. */
    readonly from: string | null;
}

export function useDatasetMove(spaces: readonly Space[]) {
    const scope = useWorkspaceScope();
    const [moving, setMoving] = useState<Moving | null>(null);
    const move = async (target: Moving, to: string | null, parentId: string | null) => {
        const result = await placeDataset({
            fetch: scope.fetch,
            signal: scope.signal,
            datasetId: target.id,
            place: { spaceId: to, parentId: to === null ? null : parentId },
        });
        const items = scope.pages.items;
        await Promise.all([
            target.from === null ? null : items.space(target.from).pull(),
            to === null || to === target.from ? null : items.space(to).pull(),
            items.private().pull(),
        ]);
        if (result.outcome === 'refused') {
            Alert.alert('Couldn’t move it', result.message);
        }
    };
    const [target, setTarget] = useState<MoveTarget | null>(null);
    const start = (item: Moving) => {
        const choices = moveSpaceChoices(spaces, item.from);
        setTarget({ to: item.from ?? choices[0]?.id ?? null, parentId: null });
        setMoving(item);
    };
    const close = () => {
        setMoving(null);
        setTarget(null);
    };
    // The title row holds Cancel and Move (the system's sheets put their action there), so Move
    // shows at the medium detent however long the lists get.
    useRouteSheet(
        moving === null || target === null
            ? null
            : {
                  testID: 'dataset-move',
                  title: moveDatasetTitle(moving.title),
                  tall: true,
                  actions: (
                      <View className="flex-row gap-1">
                          <Button label={CANCEL} variant="ghost" onPress={close} testID="dataset-move-cancel" />
                          <Button
                              label="Move"
                              variant="primary"
                              disabled={target.to === null}
                              onPress={() => {
                                  const item = moving;
                                  const { to, parentId } = target;
                                  if (to === null) {
                                      return;
                                  }
                                  close();
                                  move(item, to === '' ? null : to, parentId).catch((error: unknown) =>
                                      console.warn('[datasets] not moved', error),
                                  );
                              }}
                              testID="dataset-move-save"
                          />
                      </View>
                  ),
                  body: (
                      <MoveSheet
                          key={moving.id}
                          from={moving.from}
                          choices={moveSpaceChoices(spaces, moving.from)}
                          target={target}
                          onChange={setTarget}
                      />
                  ),
              },
        close,
    );
    return {
        /** The row's menu: Move, for a person who may place it here. */
        menu: (item: Moving, allowed: boolean): MenuRequest | null =>
            allowed ? { actions: [MOVE_ACTION], onAction: () => start(item) } : null,
        open: start,
    };
}

interface MoveTarget {
    /** A Space's id, '' for Private, null with nowhere to move it. */
    readonly to: string | null;
    readonly parentId: string | null;
}

function MoveSheet(props: {
    from: string | null;
    choices: readonly MoveSpaceChoice[];
    target: MoveTarget;
    onChange: (target: MoveTarget) => void;
}) {
    const { choices, target } = props;
    const toSpace = target.to === '' ? null : target.to;
    return (
        <>
            <Text variant="subheadline" tone="muted">
                {choices.length === 0
                    ? 'You don’t edit any Space, so there’s nowhere to move it.'
                    : moveDatasetLine(props.from)}
            </Text>
            {target.to === null ? null : (
                <>
                    <Choices
                        title={MOVE_TO}
                        choices={choices.map((choice) => ({ id: choice.id, label: choice.label, depth: 0 }))}
                        chosen={target.to}
                        onChoose={(id) => props.onChange({ to: id, parentId: null })}
                        testID="dataset-move-space"
                    />
                    {toSpace === null ? null : (
                        <Parents
                            key={toSpace}
                            spaceId={toSpace}
                            chosen={target.parentId}
                            onChoose={(parentId) => props.onChange({ to: target.to, parentId })}
                        />
                    )}
                </>
            )}
        </>
    );
}

/** Where in Space `spaceId`: its top, or under one of its pages (a dataset never sits under a dataset). */
function Parents(props: { spaceId: string; chosen: string | null; onChoose: (id: string | null) => void }) {
    const { pages: store } = useWorkspaceScope();
    const space = store.space(props.spaceId);
    useEffect(() => space.view(), [space]);
    const { data: pages } = useLiveQuery({ query: pagesQuery(space.collection) });
    const choices = [
        { id: '', label: AT_TOP, depth: 0 },
        ...parentChoices(pages, props.spaceId).map((row) => ({ id: row.id, label: row.title, depth: row.depth })),
    ];
    return (
        <Choices
            title={MOVE_UNDER}
            choices={choices}
            chosen={props.chosen ?? ''}
            onChoose={(id) => props.onChoose(id === '' ? null : id)}
            testID="dataset-move-parent"
        />
    );
}

const INDENT = 16;

function Choices(props: {
    title: string;
    choices: readonly { id: string; label: string; depth: number }[];
    chosen: string;
    onChoose: (id: string) => void;
    testID: string;
}) {
    return (
        <View className="gap-1" accessibilityRole="radiogroup" accessibilityLabel={props.title}>
            <Text variant="footnote" tone="muted" weight="medium">
                {props.title}
            </Text>
            <View className="overflow-hidden rounded-xl border border-border">
                {props.choices.map((choice, index) => {
                    const on = choice.id === props.chosen;
                    return (
                        <Pressable
                            key={choice.id === '' ? 'top' : choice.id}
                            testID={`${props.testID}-${choice.id === '' ? 'top' : choice.id}`}
                            accessibilityRole="radio"
                            accessibilityState={{ checked: on }}
                            onPress={() => props.onChoose(choice.id)}
                            className={cx(
                                'min-h-11 flex-row items-center gap-3 p-3 active:bg-accent',
                                index > 0 && 'border-t border-border',
                                on && 'bg-accent',
                            )}
                            style={{ paddingLeft: 12 + choice.depth * INDENT }}
                        >
                            <Text numberOfLines={1} className="min-w-0 flex-1">
                                {choice.label}
                            </Text>
                            {on ? <AppSymbol name="check" color="primary" /> : null}
                        </Pressable>
                    );
                })}
            </View>
        </View>
    );
}
