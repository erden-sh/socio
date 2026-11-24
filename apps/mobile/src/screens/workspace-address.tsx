import { useNavigation } from '@react-navigation/native';
import { useEffect, useRef, useState } from 'react';
import { View } from 'react-native';

import { type AddProblem, addByAddress } from '../data/first-screen';
import { routeInVariant } from '../navigation/routes';
import { ADDRESS_COPY } from '../net/first-screen';
import { openKnown, probe, stage } from '../platform/add-workspace';
import { BUILD_VARIANT } from '../platform/variant';
import { Banner, Button, Field, Screen, Text, ToneTile } from '../ui';

// The workspace's address, typed, from the
// first screen's "Enter your workspace address". Continue probes it (data/first-screen.ts);
// a workspace found goes to Confirm with its logo staged, one already on the device opens, and
// anything else gets its line (net/probe-copy.ts). Test builds add the answer's status and origin
// under the line, for whoever is testing a server. Back returns to the first screen.

/** This build is a test build (development or preview), which has Diagnostics. */
const TEST_BUILD = routeInVariant('Diagnostics', BUILD_VARIANT);

export function WorkspaceAddressScreen() {
    const navigation = useNavigation();
    const [text, setText] = useState('');
    const [busy, setBusy] = useState(false);
    const [problem, setProblem] = useState<AddProblem | null>(null);
    const [failure, setFailure] = useState<string | null>(null);
    const controller = useRef<AbortController | null>(null);

    useEffect(() => () => controller.current?.abort(), []);

    const submit = async () => {
        controller.current?.abort();
        const own = new AbortController();
        controller.current = own;
        setBusy(true);
        setProblem(null);
        setFailure(null);
        const outcome = await addByAddress(text, own.signal, { probe, stage, openKnown, testBuild: TEST_BUILD });
        if (controller.current !== own) {
            return;
        }
        setBusy(false);
        if (outcome.kind === 'problem') {
            setProblem(outcome.problem);
        } else if (outcome.kind === 'failure') {
            setFailure(ADDRESS_COPY.failure);
        } else if (outcome.kind === 'found') {
            navigation.navigate('ConfirmWorkspace', outcome.workspace);
        }
    };

    return (
        // Top-aligned, not centered: Continue stays just under the field, above the keyboard.
        <Screen testID="workspace-address-screen" edges={['right', 'bottom', 'left']}>
            <View className="items-center">
                <ToneTile tone="emerald" icon="globe" />
            </View>
            <Text accessibilityRole="header" variant="heading" className="text-center">
                {ADDRESS_COPY.title}
            </Text>
            <Text variant="subheadline" tone="muted" className="text-center">
                {ADDRESS_COPY.lead}
            </Text>
            <Field
                label={ADDRESS_COPY.label}
                placeholder={ADDRESS_COPY.placeholder}
                value={text}
                onChangeText={setText}
                error={problem?.line}
                keyboardType="url"
                autoCapitalize="none"
                autoCorrect={false}
                autoComplete="url"
                textContentType="URL"
                returnKeyType="go"
                onSubmitEditing={() => void submit()}
                editable={!busy}
                testID="workspace-address"
            />
            {problem?.detail == null ? null : (
                <Text variant="footnote" tone="muted" className="self-stretch" testID="probe-detail">
                    {problem.detail}
                </Text>
            )}
            {failure === null ? null : <Banner tone="error">{failure}</Banner>}
            <Button
                label="Continue"
                onPress={() => void submit()}
                busy={busy}
                disabled={text.trim() === ''}
                testID="add-workspace-continue"
            />
        </Screen>
    );
}
