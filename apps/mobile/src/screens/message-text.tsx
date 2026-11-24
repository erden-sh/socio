import { useEffect, useSyncExternalStore } from 'react';
import { View } from 'react-native';

import type { BubbleSurface } from '../chat/bubble-style';
import { type ChatSkills, createChatSkills, messageSkill, namesUnknownSkill } from '../chat/chat-skills';
import { safeMarkdown } from '../chat/markdown';
import { useWorkspaceScope } from '../live';
import type { WorkspaceScope } from '../sync/scope';
import { useScheme } from '../theme/scheme';
import { colorsOf } from '../theme/theme';
import { Text } from '../ui';

import { MarkdownBlock } from './chat-markdown';

// A person's message in its bubble (CB-415), as the web's MessageView draws
// it: Markdown in the bubble's colors (`MarkdownBlock`'s `surface`, made safe
// by markdown.ts as a reply is: nothing fetches), its links tapping as a
// reply's do; and a message that invoked a chat skill (`/grill-me …`) the
// skill as a chip above the rest of its words (the web's SkillChip). The
// workspace's skills are read only when a message names one the built-in
// ones don't have (chat-skills.ts), once per scope.

const skillsOfScope = new WeakMap<WorkspaceScope, ChatSkills>();

function useChatSkills(): ChatSkills {
    const scope = useWorkspaceScope();
    let skills = skillsOfScope.get(scope);
    if (skills === undefined) {
        skills = createChatSkills({
            fetch: scope.fetch,
            signal: scope.signal,
            onError: (error) => console.warn('[chat] the workspace’s skills did not load', error),
        });
        skillsOfScope.set(scope, skills);
    }
    return skills;
}

export function MessageText({
    text,
    surface,
    selectable = false,
    testID,
}: {
    text: string;
    surface: BubbleSurface;
    selectable?: boolean;
    testID?: string;
}) {
    const skills = useChatSkills();
    const known = useSyncExternalStore(skills.subscribe, skills.known);
    const skill = messageSkill(text, known);
    const unknown = namesUnknownSkill(text, known);
    useEffect(() => {
        if (unknown) {
            skills.load();
        }
    }, [skills, unknown]);
    const words = skill === null ? text : skill.rest;
    return (
        <View className="gap-1" {...(testID === undefined ? {} : { testID })}>
            {skill === null ? null : <SkillChip name={skill.name} surface={surface} />}
            {words.trim() === '' ? null : (
                <MarkdownBlock markdown={safeMarkdown(words)} surface={surface} selectable={selectable} />
            )}
        </View>
    );
}

/** The web's SkillChip: `/name` in a pill of the bubble's own word color at 15%. */
function SkillChip({ name, surface }: { name: string; surface: BubbleSurface }) {
    const colors = colorsOf(useScheme());
    const words =
        surface === 'own'
            ? colors['user-bubble-foreground']
            : surface === 'pending'
              ? colors['user-bubble-pending-foreground']
              : colors.foreground;
    return (
        <View
            testID="chat-skill-chip"
            accessibilityLabel={`Skill: ${name}`}
            className="self-start rounded-full px-2"
            style={{ backgroundColor: `${words}26` }}
        >
            <Text variant="footnote" weight="medium" style={{ color: words }}>
                /{name}
            </Text>
        </View>
    );
}
