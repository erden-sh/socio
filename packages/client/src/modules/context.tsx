import { createContext, useContext, useMemo, type ReactNode } from 'react';

import { useShell } from '../shell/shell-context';

import { slotEntries, toolRenderers } from './derive';
import { clientModules } from './registry';
import type { ClientModule, ModuleContext, SlotName, SlotProps } from './types';

/**
 * The module list the shell derives its sidebar, launcher, palette and
 * slots from. The app uses the registry (the default); tests wrap the
 * router in `ModulesProvider` to add modules.
 */
const ModulesContext = createContext<readonly ClientModule[]>(clientModules);

export function ModulesProvider({ modules, children }: { modules: readonly ClientModule[]; children: ReactNode }) {
    return <ModulesContext.Provider value={modules}>{children}</ModulesContext.Provider>;
}

export const useModules = () => useContext(ModulesContext);

/** The module context for the signed-in user, from the shell. */
export function useModuleContext(): ModuleContext {
    const { admin, workspace, state, configured, homeDot } = useShell();
    return useMemo(
        () => ({ admin, workspace, state, configured, homeDot }),
        [admin, workspace, state, configured, homeDot],
    );
}

/**
 * A slot's contributions from the modules this user may use. Modules
 * contribute through their manifest's `slots`; the slot's owner renders
 * them without knowing who they are.
 */
export function useSlot<Name extends SlotName>(name: Name) {
    const modules = useModules();
    const context = useModuleContext();
    return useMemo(() => slotEntries(modules, context, name), [modules, context, name]);
}

/**
 * The modules' tool renderers (see `ToolRenderer`). Not filtered by who may
 * use a module: the server decides who gets its tools.
 */
export function useToolRenderers() {
    const modules = useModules();
    return useMemo(() => toolRenderers(modules), [modules]);
}

/** Renders every contribution to a slot with the slot's props. */
export function Slot<Name extends SlotName>({ name, props }: { name: Name; props: SlotProps[Name] }) {
    const entries = useSlot(name);
    return entries.map(({ key, Component }) => <Component key={key} {...props} />);
}
