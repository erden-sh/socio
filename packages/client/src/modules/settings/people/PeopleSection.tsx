import { useCallback, useContext, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router';
import { toast } from 'sonner';

import type { Roster, RosterPerson } from '@socio/shared/auth';
import { ROLES } from '@socio/shared/roles';

import { api } from '../../../lib/api';
import { CurrentUser } from '../../../shell/current-user';
import { ServiceAccountsSection } from '../ServiceAccountsSection';

import { GroupsPanel } from './GroupsPanel';
import { InviteDialog } from './InviteDialog';
import { PeopleList } from './PeopleList';

import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';

/** The People section's tabs, by their `?tab=`. */
export const PEOPLE_TABS = ['people', 'groups', 'service-accounts'] as const;
export type PeopleTab = (typeof PEOPLE_TABS)[number];

const failed = (e: unknown, fallback: string) => toast.error(e instanceof Error ? e.message : fallback);

/**
 * Settings → People (CB-360): the People, Groups (CB-376) and Service
 * accounts tabs, with their counts, and Invite people. People and Groups
 * need real accounts (Better Auth); with the local sign-in picker their
 * tabs say so, and Service accounts still work. `?tab=groups` and
 * `?tab=service-accounts` open those tabs (Settings → Service accounts
 * redirects there), `&account=` at one account.
 */
export function PeopleSection({ signIn }: { signIn: boolean }) {
    const me = useContext(CurrentUser)?.id;
    const [params, setParams] = useSearchParams();
    const asked = params.get('tab');
    const tab: PeopleTab = PEOPLE_TABS.find((entry) => entry === asked) ?? 'people';
    const [people, setPeople] = useState<RosterPerson[]>();
    const [serviceCount, setServiceCount] = useState<number>();
    const [groupCount, setGroupCount] = useState<number>();
    const [inviting, setInviting] = useState(false);
    const load = useCallback(async () => {
        try {
            setPeople((await api<Roster>('/accounts/roster')).people);
        } catch (e) {
            failed(e, 'Could not load people.');
        }
    }, []);
    useEffect(() => {
        if (signIn) {
            void load();
        }
    }, [signIn, load]);
    // The tab's count before the tab is opened.
    useEffect(() => {
        const controller = new AbortController();
        api<unknown[]>('/service-accounts', 'GET', undefined, controller.signal)
            .then((list) => setServiceCount(Array.isArray(list) ? list.length : 0))
            .catch(() => {});
        return () => controller.abort();
    }, []);
    // Keys whose maker can't sign in any more (the Service accounts tab flags them).
    const gone = useCallback(
        (userId: string) => {
            if (!people) {
                return false;
            }
            const maker = people.find((person) => person.userId === userId);
            return !maker || maker.status === 'deactivated';
        },
        [people],
    );
    return (
        <Card className="gap-4 px-4 text-sm sm:px-6" data-slot="people-section">
            <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="grid gap-1">
                    <h3 className="font-medium">People</h3>
                    <p className="text-muted-foreground">
                        Who signs in, their role, and what they can reach. Open a person for everything about them.
                    </p>
                </div>
                {signIn && tab === 'people' && <Button onClick={() => setInviting(true)}>Invite people</Button>}
            </div>
            <Tabs
                value={tab}
                onValueChange={(value) =>
                    setParams(value === 'people' ? {} : { tab: value }, { replace: true, preventScrollReset: true })
                }
            >
                <TabsList>
                    <TabsTrigger value="people">People{people ? ` · ${people.length}` : ''}</TabsTrigger>
                    <TabsTrigger value="groups">Groups{groupCount === undefined ? '' : ` · ${groupCount}`}</TabsTrigger>
                    <TabsTrigger value="service-accounts">
                        Service accounts{serviceCount === undefined ? '' : ` · ${serviceCount}`}
                    </TabsTrigger>
                </TabsList>
                <TabsContent value="people" className="pt-2">
                    {signIn ? (
                        <PeopleList people={people} me={me} reload={load} />
                    ) : (
                        <p className="text-muted-foreground" data-slot="needs-sign-in">
                            This needs real accounts (Better Auth); this server signs in with the local picker.
                        </p>
                    )}
                </TabsContent>
                <TabsContent value="groups" className="pt-2">
                    {signIn ? (
                        <GroupsPanel people={people} onCount={setGroupCount} />
                    ) : (
                        <p className="text-muted-foreground" data-slot="needs-sign-in">
                            Groups need real accounts (Better Auth). With the local picker, admins may run code and
                            nobody else.
                        </p>
                    )}
                </TabsContent>
                <TabsContent value="service-accounts" className="pt-2">
                    <ServiceAccountsSection
                        focus={params.get('account') ?? undefined}
                        gone={people ? gone : undefined}
                        onCount={setServiceCount}
                    />
                </TabsContent>
            </Tabs>
            {inviting && (
                <InviteDialog grantable={ROLES} onClose={() => setInviting(false)} onAdded={() => void load()} />
            )}
        </Card>
    );
}
