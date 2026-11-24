import { ScrollView, View } from 'react-native';

import { MODULE_IDS } from '@socio/shared/modules';
import { normalizeRole } from '@socio/shared/roles';

import { useCollections, useHasWorkspaceScope, useKindAnswered, useLiveQuery, useSyncOnFocus } from '../live';
import { useNativeBar } from '../navigation/native-bar';
import { useFirstFrameWithData } from '../platform/cold-start';
import {
    LEARNING_HREF,
    learningIntro,
    REVIEW_ON_WEB,
    SKILLS_HEADING,
    SKILLS_LINE,
    skillRows,
    skillsEmpty,
} from '../shell/learning';
import { moduleEntry, moduleTitle } from '../shell/modules';
import { shellQuery, shellRows, skillsQuery } from '../shell/queries';
import { SKILLS_KIND } from '../sync/kinds';
import { skillsRow } from '../sync/skills';
import { Text } from '../ui';

import { MODULE_ICONS } from './module-icons';
import { Card, SectionTitle, WebRow } from './schedule-parts';
import { PageIntro, StatusBanners, useRememberScreen } from './shell-parts';

// Learning, the `Learning` route at the web's /learning,
// "Skills" for members, from More, Home and Search, in the module's emerald:
// the published skills from the `skills` kind, read on view (the web reads
// them once as its page opens; the kind has no poll). Admins review what the
// socios propose on the web: "Review what your socios are learning" opens it
// through useOpenLink. Nothing is written here.

const MODULE = moduleEntry(MODULE_IDS.learning);

/** The page's big title, the web LearningPage's: Learning's for admins, Skills' for members. */
export const learningHeading = (admin: boolean): string => (admin ? 'What your socios are learning.' : 'Skills.');

export function LearningScreen() {
    return useHasWorkspaceScope() ? <Learning /> : <Unscoped />;
}

function Unscoped() {
    useNativeBar({ title: MODULE.title, tone: MODULE.tone });
    return <View testID="learning-screen" className="flex-1 bg-screen" collapsable={false}></View>;
}

function Learning() {
    const collections = useCollections();
    useRememberScreen('Learning');
    useSyncOnFocus(SKILLS_KIND.collections);
    const { data } = useLiveQuery({ query: skillsQuery(collections) });
    const { data: shell } = useLiveQuery({ query: shellQuery(collections) });
    const role = shellRows(shell).workspace?.user.role;
    // An older server may still send the retired `operator` role (CB-390).
    const admin = normalizeRole(role) === 'admin';
    const answered = useKindAnswered(SKILLS_KIND.definition);
    const rows = skillRows(data.map((row) => skillsRow(row.containerId, row)));
    useFirstFrameWithData('Learning', answered || rows.length > 0);
    useNativeBar({ title: moduleTitle(MODULE, admin), tone: MODULE.tone });
    return (
        <View testID="learning-screen" className="flex-1 bg-screen" collapsable={false}>
            <ScrollView
                contentInsetAdjustmentBehavior="automatic"
                className="flex-1"
                contentContainerClassName="gap-4 p-4"
            >
                <StatusBanners />
                <PageIntro
                    subtitle={learningIntro(admin)}
                    subtitleLines={0}
                    tile={{ tone: MODULE.tone, icon: MODULE_ICONS[MODULE.icon] }}
                    testID="learning-heading"
                />
                {admin ? <WebRow label={REVIEW_ON_WEB} href={LEARNING_HREF} testID="learning-review-web" /> : null}
                <View className="gap-2" testID="skill-list">
                    <SectionTitle>{SKILLS_HEADING}</SectionTitle>
                    <Text variant="footnote" tone="muted">
                        {SKILLS_LINE}
                    </Text>
                    {rows.length === 0 ? (
                        <Text variant="subheadline" tone="muted" testID="skills-empty">
                            {skillsEmpty(answered)}
                        </Text>
                    ) : null}
                    {rows.map((row) => (
                        <Card key={row.key} testID={`skill-${row.key}`}>
                            <View accessible className="gap-1">
                                <Text weight="medium">{row.name}</Text>
                                <Text variant="footnote" tone="muted">
                                    {row.container}
                                </Text>
                                <Text>{row.description}</Text>
                            </View>
                        </Card>
                    ))}
                </View>
            </ScrollView>
        </View>
    );
}
