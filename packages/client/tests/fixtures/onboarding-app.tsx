import { BookOpen } from 'lucide-react';
import { useMemo } from 'react';
import { BrowserRouter, MemoryRouter, useLocation } from 'react-router';

import type { OnboardingPreferences } from '@socio/shared/onboarding';
import type { Role, State, WorkspaceState } from '@socio/shared/types';

import { ModulesProvider } from '../../src/modules/context';
import { openGuides } from '../../src/modules/onboarding/events';
import { Onboarding } from '../../src/modules/onboarding/Onboarding';
import type { ClientModule } from '../../src/modules/types';
import type { Shell } from '../../src/shell/shell-context';
import { ShellContext } from '../../src/shell/shell-context';

export function exampleWorkspace(role: Role = 'member', onboarding?: OnboardingPreferences): WorkspaceState {
    return {
        user: { id: role, role, name: 'Guide fixture' },
        preferences: { dictation: null, onboarding },
        spaces: [
            {
                id: 'fixture-space',
                name: 'Example Space',
                description: '',
                createdAt: 1,
            },
        ],
        dots: [
            {
                id: 'fixture-socio',
                name: 'Example socio',
                spaceId: 'fixture-space',
                spaceIds: ['fixture-space'],
                instructions: 'Example',
                researchAllowed: false,
                memoryAllowed: false,
                createdAt: 1,
            },
        ],
        conversations: [],
        setup: {
            model: true,
            voice: false,
            telegram: 'not_configured',
            missing: [],
        },
        calls: [],
    };
}
export const exampleState: State = {
    settings: {
        name: 'Guide fixture',
        paused: false,
        researchAllowed: false,
        memoryAllowed: true,
    },
    mode: 'live',
    configured: true,
    tasks: [],
    memories: [],
};
export const exampleModules: ClientModule[] = [
    'chat',
    'spaces',
    'approvals',
    'schedules',
    'issues',
    'learning',
    'dots',
    'operator',
].map((id) => ({
    id: id as ClientModule['id'],
    title: id,
    description: id,
    icon: BookOpen,
    tone: 'sky',
    order: 1,
    opens: { path: '/' },
}));
function Screen({ workspace }: { workspace: WorkspaceState }) {
    const location = useLocation();
    const shell = useMemo(
        () =>
            ({
                state: exampleState,
                workspace,
                admin: workspace.user.role !== 'member',
                configured: true,
                homeDot: workspace.dots[0],
            }) as Shell,
        [workspace],
    );
    return (
        <ShellContext.Provider value={shell}>
            <ModulesProvider modules={exampleModules}>
                <button data-tour="help" onClick={() => openGuides()}>
                    Help & guides
                </button>
                <button onClick={() => openGuides('getting-started')}>Replay Getting started</button>
                <main data-tour="workspace-view">
                    <p data-testid="fixture-path">{location.pathname}</p>
                    {location.pathname === '/' && (
                        <section data-tour="home">
                            <div data-tour="socios">Your socios</div>
                        </section>
                    )}
                    {location.pathname.endsWith('/new') && (
                        <form
                            data-tour="new-chat-composer"
                            onSubmit={(e) => {
                                e.preventDefault();
                                throw Error('Guide must never submit content');
                            }}
                        >
                            <textarea aria-label="Message your socio" />
                            <button type="submit">Send</button>
                        </form>
                    )}
                    {location.pathname.startsWith('/spaces/') && (
                        <section data-tour="space-library">
                            <button
                                data-tour="new-page"
                                onClick={() => {
                                    throw Error('Guide must never create content');
                                }}
                            >
                                New page
                            </button>
                        </section>
                    )}
                    {location.pathname === '/issues' && <section data-tour="issues">Improvements board</section>}
                </main>
                <Onboarding key={workspace.user.id} />
            </ModulesProvider>
        </ShellContext.Provider>
    );
}
export function OnboardingFixture({
    workspace = exampleWorkspace(),
    browser = false,
    path = '/',
}: {
    workspace?: WorkspaceState;
    browser?: boolean;
    /** Where the memory router starts. */
    path?: string;
}) {
    return browser ? (
        <BrowserRouter>
            <Screen workspace={workspace} />
        </BrowserRouter>
    ) : (
        <MemoryRouter initialEntries={[path]}>
            <Screen workspace={workspace} />
        </MemoryRouter>
    );
}
