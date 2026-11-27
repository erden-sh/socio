import { useEffect, useSyncExternalStore } from 'react';
import { View } from 'react-native';

import type { BubbleSurface } from '../chat/bubble-style';
import { type ChatSkills, createChatSkills, messageSkill, namesUnknownSkill } from '../chat/chat-skills';
import { safeMarkdown } from '../chat/markdown';
import { type Quote, quoting, splitQuote } from '../chat/quote-reply';
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
// ones don't have (chat-skills.ts), once per scope. A message that starts
// with a quote-reply's quote (CB-571, quote-reply.ts) draws it as a quote of
// its own above the rest: Markdown's blockquote would do, but on iOS its view
// takes a long-press for a menu of its own (Copy, Copy as Markdown) in place
// of the bubble's Reply, Copy and Share.

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
    const { quote, rest } = splitQuote(text);
    // The whole message, as the server reads it: one that starts with a quote is never a
    // command, so a `/done` after the quote is its words, not a skill chip (Sol's review of #57).
    const skill = messageSkill(text, known);
    const unknown = namesUnknownSkill(text, known);
    useEffect(() => {
        if (unknown) {
            skills.load();
        }
    }, [skills, unknown]);
    const words = skill === null ? rest : skill.rest;
    return (
        <View className="gap-1" {...(testID === undefined ? {} : { testID })}>
            {quote === null ? null : <QuoteBlock quote={quote} surface={surface} />}
            {skill === null ? null : <SkillChip name={skill.name} surface={surface} />}
            {words.trim() === '' ? null : (
                <MarkdownBlock markdown={safeMarkdown(words)} surface={surface} selectable={selectable} />
            )}
        </View>
    );
}

/**
 * A quote-reply's quote in the bubble, as a Markdown blockquote looks there (bubble-style.ts): a bar
 * in the bubble's line color, then "Author:" in bold and the excerpt, in the bubble's muted words.
 */
function QuoteBlock({ quote, surface }: { quote: Quote; surface: BubbleSurface }) {
    const colors = colorsOf(useScheme());
    const words =
        surface === 'own'
            ? colors['user-bubble-foreground']
            : surface === 'pending'
              ? colors['user-bubble-pending-foreground']
              : colors.foreground;
    const muted = surface === 'own' ? words : colors['muted-foreground'];
    const line = surface === 'own' ? '#ffffff40' : colors.border;
    return (
        // A border, not a bar beside a flex-1 Text: in a bubble that sizes to its words, a row's
        // flex-1 Text is measured on one line and a long quote was cut off with what followed it.
        <View
            testID="chat-quote"
            accessibilityLabel={`${quoting(quote.author)}: ${quote.excerpt}`}
            className="my-0.5 pl-3"
            style={{ borderLeftWidth: 3, borderLeftColor: line }}
        >
            <Text style={{ color: muted }}>
                <Text weight="semibold" style={{ color: muted }}>
                    {quote.author}:
                </Text>{' '}
                {quote.excerpt}
            </Text>
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
