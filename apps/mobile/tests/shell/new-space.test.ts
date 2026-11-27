import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { SPACE_NAME_ERROR } from '@socio/shared/spaces/create-input';
import { SPACE_CREATE_REFUSED } from '@socio/shared/spaces/create-permission';

import { ROUTES } from '../../src/navigation/routes';
import {
    AUDIENCE_LEGEND,
    audienceChoices,
    canCreateSpace,
    canSubmitSpace,
    DESCRIPTION_LABEL,
    NEW_SPACE_TITLE,
    newSpaceStart,
    PRIVATE_SPACE_COVERS,
    SPACE_NEEDS_CONNECTION,
    SPACE_NO_ANSWER,
    spaceCreateCopy,
} from '../../src/shell/new-space';

// New Space (CB-410): the web's create dialog on a phone. The screens draw
// on React Native, so they're read as source; the view model runs under Node,
// and its words are held to the web's files.

const app = (file: string) => readFileSync(new URL(`../../src/${file}`, import.meta.url), 'utf8');
const web = (file: string) => readFileSync(new URL(`../../../../packages/client/src/${file}`, import.meta.url), 'utf8');

const admin = { user: { id: 'u-ada', role: 'admin' } } as never;
const member = { user: { id: 'u-ben', role: 'member' } } as never;

describe('who sees New Space', () => {
    it('follows the server’s permission, never a role check of its own', () => {
        expect(canCreateSpace({ permissions: { createSpaces: true } })).toBe(true);
        expect(canCreateSpace({ permissions: { createSpaces: false } })).toBe(false);
        // An older server, or before the first answer: hidden.
        expect(canCreateSpace({})).toBe(false);
        expect(canCreateSpace(null)).toBe(false);
        expect(web('modules/spaces/module.tsx')).toContain('workspace.permissions?.createSpaces &&');
    });

    it('puts New Space in the Spaces list’s bar only when it may, opening the NewSpace modal', () => {
        const screen = app('screens/spaces.tsx');
        expect(screen).toContain('const workspace = shellRows(shell).workspace;');
        expect(screen).toContain('const creates = canCreateSpace(workspace);');
        // In the bar (CB-420): a native "+" item, only for whom the server lets in.
        expect(screen).toMatch(
            /right: creates\s+\? \[\s+\{\s+id: 'spaces-new',\s+label: NEW_SPACE_LABEL,\s+symbol: 'plus',[^]*?navigate\('NewSpace'\)/,
        );
        expect(ROUTES.NewSpace).toEqual({ gates: ['shell'], preset: ROUTES.FileIssue.preset });
        expect('linking' in ROUTES.NewSpace).toBe(false);
        expect(app('navigation/root-stack.tsx')).toContain('NewSpace: NewSpaceScreen,');
    });
});

describe('the form', () => {
    it('has the web dialog’s title, fields and audience words', () => {
        const dialog = web('modules/settings/WorkspaceDialog.tsx');
        // The dialog's words are its en-US dictionary's (settings.dialogs).
        const words = readFileSync(
            new URL('../../../../packages/i18n/locales/en-US/settings.dialogs.json', import.meta.url),
            'utf8',
        );
        expect(words).toContain(`"${NEW_SPACE_TITLE}"`);
        expect(words).toContain(`"${DESCRIPTION_LABEL}"`);
        expect(dialog).toContain('body = { name, description: text, private: privateSpace };');
        const settings = web('modules/spaces/SpaceAudienceField.tsx');
        expect(settings).toContain(`legend = '${AUDIENCE_LEGEND}'`);
        const [whole, mine] = audienceChoices(false);
        expect(settings).toContain(whole!.title);
        expect(settings).toContain('Everyone in the workspace sees it and everything in it.');
        expect(settings).toContain("' Only workspace admins make a Space for everyone.'");
        expect(mine!.detail).toContain(PRIVATE_SPACE_COVERS);
        expect(web('components/private-space.tsx')).toContain(`'${PRIVATE_SPACE_COVERS}'`);
    });

    it('opens an admin’s Space to the whole workspace, anyone else’s private, which only admins can change', () => {
        expect(newSpaceStart(admin)).toEqual({ admin: true, private: false });
        expect(newSpaceStart(member)).toEqual({ admin: false, private: true });
        expect(audienceChoices(true).map((choice) => choice.disabled)).toEqual([false, false]);
        expect(audienceChoices(false).map((choice) => choice.disabled)).toEqual([true, false]);
        expect(audienceChoices(true)[0]!.detail).not.toContain('Only workspace admins');
    });

    it('creates only with a name, nothing in flight and a connection', () => {
        expect(canSubmitSpace('Launch', false, null)).toBe(true);
        expect(canSubmitSpace('   ', false, null)).toBe(false);
        expect(canSubmitSpace('Launch', true, null)).toBe(false);
        expect(canSubmitSpace('Launch', false, 'offline')).toBe(false);
    });

    it('words each outcome by status, never the server’s text', () => {
        expect(spaceCreateCopy({ kind: 'done', space: { id: 's' } as never })).toBeNull();
        expect(spaceCreateCopy({ kind: 'blocked', reason: 'offline' })).toBe(SPACE_NEEDS_CONNECTION);
        expect(spaceCreateCopy({ kind: 'refused', reason: 'http-403' })).toBe(SPACE_CREATE_REFUSED);
        expect(spaceCreateCopy({ kind: 'refused', reason: 'http-400' })).toBe(SPACE_NAME_ERROR);
        expect(spaceCreateCopy({ kind: 'no-answer' })).toBe(SPACE_NO_ANSWER);
    });

    it('opens the new Space in the modal’s place once created', () => {
        expect(app('screens/new-space.tsx')).toContain(
            "navigation.dispatch(StackActions.replace('Space', { spaceId: outcome.space.id }));",
        );
    });
});
