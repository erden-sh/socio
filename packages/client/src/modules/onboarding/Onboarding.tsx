import { useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router';

import {
    GUIDE_IDS,
    GUIDE_VERSION,
    type GuideId,
    type GuideProgress,
    type OnboardingPreferences,
} from '@socio/shared/onboarding';

import { api } from '../../lib/api';
import { useHydrated } from '../../lib/client-only';
import { navigateOrLoad } from '../../shell/build-skew';
import { useHelpAnchor } from '../../shell/help-anchor';
import { useShell } from '../../shell/shell-context';
import { useModuleContext, useModules } from '../context';

import { OPEN_GUIDES } from './events';
import { availableGuides } from './guides';
import { TourLayer } from './TourLayer';

import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Popover, PopoverAnchor, PopoverContent } from '@/components/ui/popover';

/**
 * A chat's or a room's own view, with its composer at the bottom: the
 * offer would cover the composer and the status line above it in the
 * bottom corner, or the conversation from the header. It waits for
 * another page (CB-219).
 */
export const chatView = (pathname: string) => /^\/(chats\/[^/]+|dots\/[^/]+\/new)\/?$/.test(pathname);

/** One controller per signed-in person; preferences, not a browser flag, own dismissal. */
export function Onboarding() {
    const shell = useShell();
    const context = useModuleContext();
    const modules = useModules();
    const hydrated = useHydrated();
    const navigate = useNavigate();
    const location = useLocation();
    // A step's page may name a tab (`?tab=`): the address with its query.
    const here = location.pathname + location.search;
    // The poll can replace context every 3s. Equivalent definitions must not
    // destroy/refocus a running guide (or steal focus from a person's draft).
    const definitions = JSON.stringify(availableGuides(context, modules));
    const guides = useMemo(() => JSON.parse(definitions) as ReturnType<typeof availableGuides>, [definitions]);
    const [progress, setProgress] = useState<OnboardingPreferences>(shell.workspace.preferences?.onboarding ?? {});
    const [menu, setMenu] = useState(false);
    const [active, setActive] = useState<{ id: GuideId; stepId: string }>();
    const [saveError, setSaveError] = useState('');
    // Put away with Escape, until the next page load.
    const [hidden, setHidden] = useState(false);
    // The offer opens from the header's Help button (CB-308), where it
    // stays reachable after Skip; without a header, the bottom corner.
    const helpButton = useHelpAnchor();
    const anchorRef = useMemo(() => ({ current: helpButton }), [helpButton]);
    const queue = useRef(Promise.resolve());
    const alive = useRef(true);
    useEffect(() => {
        alive.current = true;
        return () => {
            alive.current = false;
        };
    }, []);
    const go = navigateOrLoad((path: string) => void navigate(path));
    const remember = (id: GuideId, value: GuideProgress) => {
        setProgress((current) => ({ ...current, [id]: value }));
        queue.current = queue.current
            .catch(() => {})
            .then(async () => {
                if (!alive.current) {
                    return;
                }
                try {
                    await api('/preferences', 'PATCH', { onboarding: { [id]: value } });
                    if (alive.current) {
                        setSaveError('');
                    }
                } catch {
                    if (alive.current) {
                        setSaveError('Your guide progress could not be saved. Use Help to retry before signing out.');
                    }
                }
            });
    };
    const choose = (id: GuideId, restart = false) => {
        const guide = guides.find((g) => g.id === id);
        if (!guide) {
            return;
        }
        const saved = progress[id];
        const step =
            (!restart &&
                saved?.status !== 'completed' &&
                saved?.version === GUIDE_VERSION &&
                guide.steps.find((s) => s.id === saved.stepId)) ||
            guide.steps[0];
        setMenu(false);
        setActive({ id, stepId: step.id });
        remember(id, {
            version: GUIDE_VERSION,
            status: 'in_progress',
            stepId: step.id,
        });
        if (step.path && step.path !== here) {
            go(step.path);
        }
    };
    useEffect(() => {
        const open = (event: Event) => {
            const id: unknown = (event as CustomEvent).detail;
            // The menu is always accessible; role/feature checks are repeated on start.
            if (typeof id === 'string' && GUIDE_IDS.includes(id as GuideId)) {
                choose(id as GuideId);
            } else {
                setActive(undefined);
                setMenu(true);
            }
        };
        window.addEventListener(OPEN_GUIDES, open);
        return () => window.removeEventListener(OPEN_GUIDES, open);
    });
    const guide = active && guides.find((g) => g.id === active.id);
    const index = guide?.steps.findIndex((s) => s.id === active?.stepId) ?? -1;
    const stop = (status: 'dismissed' | 'completed') => {
        if (active) {
            remember(active.id, {
                version: GUIDE_VERSION,
                status,
                stepId: active.stepId,
            });
        }
        setActive(undefined);
    };
    const move = (next: number) => {
        if (!guide) {
            return;
        }
        const step = guide.steps[next];
        if (!step) {
            return stop('completed');
        }
        setActive({ id: guide.id, stepId: step.id });
        remember(guide.id, {
            version: GUIDE_VERSION,
            status: 'in_progress',
            stepId: step.id,
        });
        if (step.path && step.path !== here) {
            go(step.path);
        }
    };
    const unseen = progress['getting-started']?.version !== GUIDE_VERSION;
    const resumable = progress['getting-started']?.status === 'in_progress';
    const offer = (
        <>
            <strong className="font-medium">{resumable ? 'Continue your guide' : 'Find your way around Socio'}</strong>
            <p className="text-sm text-muted-foreground">
                An optional guide to socios, conversations and shared pages. You stay in control.
            </p>
            <div className="flex flex-wrap gap-2">
                <Button onClick={() => choose('getting-started')}>
                    {resumable ? 'Continue guide' : 'Start guide'}
                </Button>
                <Button
                    variant="ghost"
                    onClick={() => {
                        remember('getting-started', {
                            version: GUIDE_VERSION,
                            status: 'dismissed',
                            stepId: progress['getting-started']?.stepId ?? 'welcome',
                        });
                    }}
                >
                    Skip
                </Button>
            </div>
            {helpButton && <p className="text-xs text-muted-foreground">Later: Help → Help and guides</p>}
        </>
    );
    return (
        <>
            {hydrated &&
                !active &&
                !menu &&
                !hidden &&
                (unseen || resumable) &&
                !chatView(location.pathname) &&
                (helpButton ? (
                    // Under the header the offer covers the page's top-right controls
                    // (a board's view switch, New issue), so it opens by itself only
                    // on Home; elsewhere Help → Help and guides has it.
                    location.pathname === '/' && (
                        <Popover
                            open
                            onOpenChange={(open) => {
                                if (!open) {
                                    setHidden(true);
                                }
                            }}
                        >
                            <PopoverAnchor virtualRef={anchorRef} />
                            <PopoverContent
                                aria-label="Getting started guide"
                                data-tour="onboarding-offer"
                                align="end"
                                sideOffset={8}
                                collisionPadding={12}
                                className="grid w-[min(300px,calc(100vw-24px))] gap-2 rounded-xl bg-card p-4 text-card-foreground shadow-lg"
                                // An offer, not a question: it doesn't take the focus. Anchored
                                // under the header it sits over the page's own controls, so a
                                // click elsewhere (or Escape) puts it away until the next page
                                // load, and the click still reaches what it was aimed at.
                                onOpenAutoFocus={(event) => event.preventDefault()}
                            >
                                {offer}
                            </PopoverContent>
                        </Popover>
                    )
                ) : (
                    <section
                        aria-label="Getting started guide"
                        data-tour="onboarding-offer"
                        className="fixed right-3 bottom-3 z-30 grid w-[min(360px,calc(100vw-24px))] gap-2 rounded-xl border bg-card p-4 text-card-foreground shadow-lg"
                    >
                        {offer}
                    </section>
                ))}
            {saveError && (
                <div
                    role="alert"
                    className="fixed right-3 bottom-3 z-50 max-w-sm rounded-lg border bg-card p-3 text-sm"
                >
                    {saveError}
                    <Button
                        size="sm"
                        variant="outline"
                        onClick={() => {
                            for (const id of GUIDE_IDS) {
                                const p = progress[id];
                                if (p) {
                                    remember(id, p);
                                }
                            }
                        }}
                    >
                        Retry saving
                    </Button>
                </div>
            )}
            <Dialog open={menu} onOpenChange={setMenu}>
                <DialogContent className="max-h-[85dvh] overflow-y-auto">
                    <DialogHeader>
                        <DialogTitle>Help &amp; getting started</DialogTitle>
                        <DialogDescription>
                            Choose a short guide. Read More opens its article in a separate tab so your place stays
                            here.
                        </DialogDescription>
                    </DialogHeader>
                    <a className="text-sm underline" href="/docs" target="_blank" rel="noopener">
                        Open the help center
                    </a>
                    {guides.map((g) => (
                        <section key={g.id} className="grid gap-2 border-t pt-3" aria-label={g.title}>
                            <h3 className="font-medium">{g.title}</h3>
                            <p className="text-sm text-muted-foreground">{g.description}</p>
                            <div className="flex flex-wrap gap-2">
                                <Button onClick={() => choose(g.id)}>
                                    {progress[g.id]?.version === GUIDE_VERSION && progress[g.id]?.status !== 'completed'
                                        ? 'Continue'
                                        : 'Start'}{' '}
                                    {g.title}
                                </Button>
                                {progress[g.id] && (
                                    <Button variant="outline" onClick={() => choose(g.id, true)}>
                                        Restart {g.title}
                                    </Button>
                                )}
                            </div>
                        </section>
                    ))}
                </DialogContent>
            </Dialog>
            {hydrated && guide && index >= 0 && (
                <TourLayer
                    guide={guide}
                    index={index}
                    routeKey={location.key}
                    pathname={here}
                    move={move}
                    dismiss={() => stop('dismissed')}
                    complete={() => stop('completed')}
                    openPage={go}
                />
            )}
            {active && (!guide || index < 0) && (
                <section role="status" className="fixed right-3 bottom-3 z-50 rounded-lg border bg-card p-3">
                    This guide is no longer available for your account or this workspace.
                    <Button onClick={() => setActive(undefined)}>Close guide</Button>
                </section>
            )}
        </>
    );
}
