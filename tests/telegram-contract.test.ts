import { Context } from 'effect';
import { expect, it } from 'vitest';

import * as buttons from '@socio/foundation/telegram/buttons';
import * as replies from '@socio/foundation/telegram/replies';
import { teamOwner } from '@socio/foundation/telegram/team-owner';
import { isTeamOwnerId } from '@socio/shared/rooms/rooms';

import * as contract from '../src/server/telegram/contract.js';

// The buttons and the team owner moved into packages; a later change
// dropped the old paths and moved `NO_TEXT_REPLY` into a package too,
// which the contract re-exports.
it('re-exports the no-text reply from its package, unchanged', () => {
    expect(contract.NO_TEXT_REPLY).toBe(replies.NO_TEXT_REPLY);
    expect(contract.NO_TEXT_REPLY).toBe('The socio finished without a text reply.');
});

it('keeps the team owner id and the buttons as they were', () => {
    expect(teamOwner('-100123')).toBe('telegram-team:-100123');
    expect(isTeamOwnerId(teamOwner('-100123'))).toBe(true);
    expect(buttons.approvalButtons('a1')).toEqual({
        inline_keyboard: [
            [
                { text: 'Approve', callback_data: 'sb1:a+:a1' },
                { text: 'Deny', callback_data: 'sb1:a-:a1' },
            ],
        ],
    });
});

it('names its tags socio/telegram/<Name>', () => {
    expect([contract.Channel.key, contract.Links.key, contract.TelegramConfig.key]).toEqual([
        'socio/telegram/Channel',
        'socio/telegram/Links',
        'socio/telegram/TelegramConfig',
    ]);
});

it('has no channel unless one is provided, as when Telegram is not configured', () => {
    expect(Context.get(Context.empty(), contract.Channel)).toBeUndefined();
});
