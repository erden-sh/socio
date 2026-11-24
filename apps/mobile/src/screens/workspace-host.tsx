import { hostParts } from '../net/address';
import { Text } from '../ui';

// A workspace's host as every add-workspace and sign-in screen
// shows it: from the URL, never from the workspace's branding,
// with its registrable domain emphasized
// (brain.**example.com**).
export function WorkspaceHost({ host, testID }: { host: string; testID?: string }) {
    const { lead, domain, port } = hostParts(host);
    return (
        <Text testID={testID} variant="callout" tone="muted" className="text-center" accessibilityLabel={host}>
            {lead}
            <Text variant="callout" weight="semibold">
                {domain}
            </Text>
            {port}
        </Text>
    );
}
