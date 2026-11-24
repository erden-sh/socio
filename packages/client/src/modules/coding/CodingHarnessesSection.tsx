import { useEffect, useState } from 'react';

import type { CodingHarnessView } from '@socio/shared/coding/coding-sessions';

import { api } from '../../lib/api';
import { SettingsCard } from '../settings/AccountSettings';

import { Badge } from '@/components/ui/badge';

/**
 * Settings → Coding → Coding agents (CB-326), for admins: the coding
 * agents (harnesses) sessions may run, each with how it reaches models,
 * whether it may run on a person's own plan, whether the server's kill
 * switch (`CODING_HARNESSES_DISABLED`) turned it off, and its terms
 * record: the plan types the integration is built for, when its terms
 * were last checked, and a link to them. Read only. The server answers
 * 404 while the flag `coding-sessions` is off for the admin; then nothing
 * shows.
 */
export function CodingHarnessesSection() {
    const [harnesses, setHarnesses] = useState<CodingHarnessView[]>();
    useEffect(() => {
        const controller = new AbortController();
        api<{ harnesses: CodingHarnessView[] }>('/gateway/harnesses', 'GET', undefined, controller.signal)
            // Only a list answer: anything else shows nothing.
            .then((next) => {
                if (Array.isArray(next?.harnesses)) {
                    setHarnesses(next.harnesses);
                }
            })
            .catch(() => undefined);
        return () => controller.abort();
    }, []);
    if (!harnesses?.length) {
        return null;
    }
    return (
        <SettingsCard>
            <section className="grid gap-3" data-slot="coding-harnesses">
                <div className="grid gap-1">
                    <h3 className="font-medium">Coding agents</h3>
                    <p className="text-muted-foreground">
                        The coding agents a socio may start a session with. Each runs in the session’s sandbox and
                        reaches models only through Socio’s model gateway, with the session’s own short-lived
                        credential, so the models, budgets and limits above apply to all of them. The person’s card
                        names the agent. To turn one off, list it in <code>CODING_HARNESSES_DISABLED</code> on the
                        server.
                    </p>
                </div>
                <ul className="m-0 grid list-none gap-3 p-0">
                    {harnesses.map((harness) => (
                        <li
                            key={harness.id}
                            className="grid gap-1 border-t pt-3 first:border-t-0 first:pt-0"
                            data-slot="coding-harness"
                            data-harness={harness.id}
                        >
                            <div className="flex flex-wrap items-center gap-2">
                                <strong>{harness.label}</strong>
                                <code className="text-xs text-muted-foreground">{harness.id}</code>
                                {harness.default && <Badge variant="secondary">Default</Badge>}
                                {harness.disabled ? (
                                    <Badge variant="destructive">Turned off</Badge>
                                ) : (
                                    <Badge variant="outline">Available</Badge>
                                )}
                            </div>
                            <dl className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-0.5 text-xs">
                                <dt className="text-muted-foreground">Models</dt>
                                <dd className="m-0">
                                    {harness.route === 'gateway'
                                        ? 'Through Socio’s model gateway'
                                        : 'Directly with a subscription, outside Socio’s gateway'}
                                    {harness.personalPlans ? '; may run on a person’s own plan' : ''}
                                </dd>
                                <dt className="text-muted-foreground">Built for</dt>
                                <dd className="m-0">{harness.terms.plans}</dd>
                                <dt className="text-muted-foreground">Terms checked</dt>
                                <dd className="m-0" data-slot="coding-harness-checked">
                                    {harness.terms.checkedAt ?? 'Not checked yet'}
                                </dd>
                                <dt className="text-muted-foreground">Terms</dt>
                                <dd className="m-0 [overflow-wrap:anywhere]">
                                    {harness.terms.url.startsWith('https://') ? (
                                        <a
                                            href={harness.terms.url}
                                            target="_blank"
                                            rel="noreferrer noopener"
                                            className="underline underline-offset-3"
                                        >
                                            {harness.terms.url}
                                        </a>
                                    ) : (
                                        harness.terms.url
                                    )}
                                </dd>
                            </dl>
                        </li>
                    ))}
                </ul>
            </section>
        </SettingsCard>
    );
}
