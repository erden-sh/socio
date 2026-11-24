import type { PluginManifest } from '@socio/shared/plugins/plugins';

/**
 * The social planner, the first plugin. It is not in the catalog unless
 * this instance sets `PLUGIN_CATALOGS=bundled:social-strategy`. The image
 * is built as the `plugin-social-strategy` stage and is not pulled. One
 * replica by default; more than one is safe because the posts live in
 * Socio and the service holds no session.
 */
export const socialStrategyManifest: PluginManifest = {
    id: 'social-strategy',
    name: 'Social strategy',
    version: '1.0.0',
    author: 'Socio',
    description: 'Plan, edit and curate X posts. Socio never posts them; Open in X hands the text to you.',
    entry: { path: '/' },
    display: 'embed',
    permissions: ['social:read', 'social:write'],
    // Open in X hands the post to X's composer; nothing else opens.
    bridge: {
        open: ['https://x.com/intent/post', 'https://twitter.com/intent/post'],
    },
    mcp: {
        tools: [
            {
                name: 'list_planned_posts',
                description: 'List planned posts in a time range, optionally by status. Does not post to X.',
                scope: 'social:read',
            },
            {
                name: 'create_planned_post',
                description: 'Add a planned post. Does not post to X; a person publishes it from X.',
                scope: 'social:write',
            },
            {
                name: 'update_planned_post',
                description: 'Update a planned post’s text, time, status, account, topic or notes. Does not post to X.',
                scope: 'social:write',
            },
            {
                name: 'list_reply_queue',
                description: 'List reply-queue items, optionally by status. Does not post to X.',
                scope: 'social:read',
            },
            {
                name: 'create_reply_item',
                description: 'Add a reply to draft. Does not post to X.',
                scope: 'social:write',
            },
            {
                name: 'update_reply_item',
                description: 'Update a reply draft or its status. Does not post to X.',
                scope: 'social:write',
            },
        ],
    },
    service: {
        image: 'company-brain-plugin-social-strategy',
        port: 8080,
        // It calls back with its own identity token, which the runtime
        // mounts and names in SOCIO_IDENTITY_FILE: no shared token and no
        // Swarm secret in the manifest.
        env: {
            SOCIO_API_URL: 'http://app:4310',
        },
        healthcheck: { path: '/healthz', intervalSeconds: 10, timeoutSeconds: 3 },
        resources: { cpus: 0.5, memoryMb: 256 },
        replicas: 1,
    },
};
