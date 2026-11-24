import { Pressable, View } from 'react-native';

import { LEGAL_ROWS, LEGAL_SECTION, PRIVACY_FOOTER } from '../net/legal-links';
import { openLegalPage } from '../platform/legal-links';
import { AppSymbol, ROW_INSET, RowSeparator, Text } from '../ui';

import { Section } from './shell-parts';

// socio.sh's legal pages (src/net/legal-links.ts): Settings' Legal section, with
// or without a workspace open, and the Privacy Policy link at the foot of the
// first screen and the sign-in screen, before signing in. Each opens in the
// in-app browser.

/** Settings' Legal rows: Privacy Policy, Terms of Service, Delete your account, Help & support. */
export function LegalSection() {
    return (
        <View className="gap-2">
            <Section title={LEGAL_SECTION.title} testID={LEGAL_SECTION.testID}>
                {LEGAL_ROWS.map((row, index) => (
                    <Pressable
                        key={row.id}
                        testID={row.testID}
                        accessibilityRole="link"
                        accessibilityLabel={row.title}
                        accessibilityHint={LEGAL_SECTION.hint}
                        onPress={() => openLegalPage(row.href)}
                        className="flex-row items-center gap-3 p-3 active:bg-accent"
                        style={{ minHeight: 48 }}
                    >
                        {index > 0 ? <RowSeparator inset={ROW_INSET} /> : null}
                        <Text weight="medium" className="min-w-0 flex-1">
                            {row.title}
                        </Text>
                        <AppSymbol name="external-link" color="muted-foreground" />
                    </Pressable>
                ))}
            </Section>
            <Text variant="footnote" tone="muted" className="px-3" testID="settings-legal-publisher">
                {LEGAL_SECTION.publisher}
            </Text>
        </View>
    );
}

/** A small Privacy Policy link for the screens before sign-in. */
export function PrivacyLink({ testID }: { testID: string }) {
    return (
        <Pressable
            testID={testID}
            accessibilityRole="link"
            accessibilityLabel={PRIVACY_FOOTER.label}
            accessibilityHint={PRIVACY_FOOTER.hint}
            onPress={() => openLegalPage(PRIVACY_FOOTER.href)}
            hitSlop={8}
            className="min-h-11 items-center justify-center px-3"
        >
            <Text variant="footnote" tone="muted" className="underline">
                {PRIVACY_FOOTER.label}
            </Text>
        </Pressable>
    );
}
