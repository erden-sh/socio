import { View } from 'react-native';

import { useSpaceSection } from '../live';
import {
    MEMORY_EMPTY,
    MEMORY_ON_THE_WEB,
    type MemoryRow,
    memoryView,
    OPEN_ON_THE_WEB,
    radarView,
    SECTION_LOADING,
    type SectionStatus,
    sectionStatus,
    SPACE_TABS,
    spaceSectionPath,
    type SpaceTab,
} from '../shell/space-sections';
import type { SpaceSectionName } from '../sync/space-sections';
import { Button, SegmentedControl, Text } from '../ui';
import { cx } from '../ui/cx';

import { useOpenLink } from './open-link';
import { ListRow, Section } from './shell-parts';

// A Space's tabs and its radar and memory (view models in
// src/shell/space-sections.ts), read-only. Each tab holds its section while it
// shows (`useSpaceSection`): the phone's last copy first, then the server's.

/** Pages, Memory and Radar, the web's space-tabs.tsx: the platform's segmented control. */
export function SpaceTabs({ tab, onTab }: { tab: SpaceTab; onTab: (tab: SpaceTab) => void }) {
    return (
        <SegmentedControl
            options={SPACE_TABS.map((item) => ({ value: item.id, label: item.label, testID: `space-tab-${item.id}` }))}
            selected={tab}
            onSelect={onTab}
            accessibilityLabel="Space"
            testID="space-tabs"
        />
    );
}

/** Loading or "Open it once you're online" while a section has no copy; null once it has one. */
function SectionPlaceholder(props: { section: SpaceSectionName; status: SectionStatus }) {
    const { status, section } = props;
    if (status.kind === 'loading') {
        return (
            <Text tone="muted" variant="footnote" testID={`space-${section}-loading`}>
                {SECTION_LOADING[section]}
            </Text>
        );
    }
    return status.kind === 'offline' ? (
        <Text variant="subheadline" tone="muted" testID={`space-${section}-offline`}>
            {status.line}
        </Text>
    ) : null;
}

/** "Updated …" over an older copy, when the last read failed. */
function UpdatedNote({ section, status }: { section: SpaceSectionName; status: SectionStatus }) {
    return status.kind === 'shown' && status.note !== null ? (
        <Text variant="footnote" tone="muted" testID={`space-${section}-updated`}>
            {status.note}
        </Text>
    ) : null;
}

/** The radar: recent changes, open decisions and stale pages, each row opening its page. */
export function RadarTab({
    spaceId,
    onOpen,
    folders,
}: {
    spaceId: string;
    onOpen: (pageId: string) => void;
    /** The Space's folders the phone holds (CB-426): no excerpt of their hidden bodies. */
    folders: ReadonlySet<string>;
}) {
    const state = useSpaceSection(spaceId, 'radar');
    const status = sectionStatus(state);
    const value = state.value;
    if (value?.section !== 'radar') {
        return <SectionPlaceholder section="radar" status={status} />;
    }
    const view = radarView(value.radar, folders);
    return (
        <>
            <UpdatedNote section="radar" status={status} />
            <Text variant="footnote" tone="muted" testID="space-radar-scope">
                {view.scope}
            </Text>
            {view.sections.map((section) =>
                section.rows.length === 0 ? (
                    <View key={section.id} className="gap-2" testID={`space-radar-${section.id}-empty`}>
                        <Text accessibilityRole="header" variant="footnote" weight="medium" tone="muted">
                            {section.title}
                        </Text>
                        <Text variant="footnote" tone="muted">
                            {section.empty}
                        </Text>
                    </View>
                ) : (
                    <Section key={section.id} title={section.title} testID={`space-radar-${section.id}`}>
                        {section.rows.map((row, index) => (
                            <ListRow
                                key={row.id}
                                first={index === 0}
                                testID={`space-radar-${section.id}-${row.id}`}
                                leadingSize={0}
                                title={row.title}
                                subtitle={row.excerpt}
                                subtitleLines={2}
                                meta={
                                    // Its own line, as a page's "Edited Nov 3" in Recent: a long excerpt can't push it out.
                                    <Text variant="footnote" tone="muted" numberOfLines={1}>
                                        {row.meta}
                                    </Text>
                                }
                                accessibilityLabel={row.accessibilityLabel}
                                accessibilityHint="Opens the page"
                                onPress={() => onOpen(row.id)}
                            />
                        ))}
                    </Section>
                ),
            )}
        </>
    );
}

function MemoryCard({ row, first, dashed }: { row: MemoryRow; first: boolean; dashed: boolean }) {
    return (
        <View
            accessible
            accessibilityLabel={row.accessibilityLabel}
            testID={`space-memory-${row.id}`}
            className={cx(
                'gap-1 p-3',
                !first && (dashed ? 'border-t border-dashed border-border' : 'border-t border-border'),
            )}
        >
            {row.changes === null ? null : (
                <Text variant="footnote" tone="muted">
                    {row.changes}
                </Text>
            )}
            <Text>{row.text}</Text>
            {row.version === null ? null : (
                <Text variant="footnote" weight="medium" tone="muted">
                    {row.version}
                </Text>
            )}
            <Text variant="footnote" tone="muted">
                {row.proposed}
            </Text>
            {row.approved === null ? null : (
                <Text variant="footnote" tone="muted">
                    {row.approved}
                </Text>
            )}
        </View>
    );
}

/** The memory: who reads it, the proposals waiting, the entries in use; its writes open the web. */
export function MemoryTab({ spaceId, isPrivate }: { spaceId: string; isPrivate: boolean }) {
    const state = useSpaceSection(spaceId, 'memory');
    const openLink = useOpenLink();
    const status = sectionStatus(state);
    const value = state.value;
    if (value?.section !== 'memory') {
        return <SectionPlaceholder section="memory" status={status} />;
    }
    const view = memoryView(value.memory, isPrivate);
    return (
        <>
            <UpdatedNote section="memory" status={status} />
            <Text variant="footnote" tone="muted" testID="space-memory-audience">
                {view.audience}
            </Text>
            {view.proposals.length === 0 ? null : (
                <Section title={view.proposalsTitle} testID="space-memory-proposals">
                    {view.proposals.map((row, index) => (
                        <MemoryCard key={row.id} row={row} first={index === 0} dashed />
                    ))}
                </Section>
            )}
            {view.entries.length === 0 ? (
                <View className="gap-2" testID="space-memory-empty">
                    <Text accessibilityRole="header" variant="footnote" weight="medium" tone="muted">
                        In use
                    </Text>
                    <Text variant="footnote" tone="muted">
                        {MEMORY_EMPTY}
                    </Text>
                </View>
            ) : (
                <Section title="In use" testID="space-memory-entries">
                    {view.entries.map((row, index) => (
                        <MemoryCard key={row.id} row={row} first={index === 0} dashed={false} />
                    ))}
                </Section>
            )}
            <View className="items-start gap-2">
                <Text variant="footnote" tone="muted">
                    {MEMORY_ON_THE_WEB}
                </Text>
                <Button
                    variant="secondary"
                    label={OPEN_ON_THE_WEB}
                    onPress={() => openLink(spaceSectionPath(spaceId, 'memory'))}
                    testID="space-memory-web"
                />
            </View>
        </>
    );
}
