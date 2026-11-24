import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { isIssueFileScope } from '../../src/sync/attachments';
import { issueAttachTray } from '../../src/sync/issue-attachments';

// The issue page's attachments and vote chip (CB-411), read as source: the
// screens draw on React Native, which the Node tests can't load.
// - The web's Attachments section on the issue, shown even with none,
//   with an Attach button that picks as a comment's "+" does and attaches to
//   the issue itself through the outbox.
// - The vote chip shows "0" when nobody has voted.

const read = (file: string) => readFileSync(join(import.meta.dirname, '../../src', file), 'utf8');
const web = (file: string) => readFileSync(join(import.meta.dirname, '../../../../packages/client/src', file), 'utf8');

/** A function's source, from its declaration to the next top-level declaration. */
function body(source: string, start: string): string {
    const from = source.indexOf(start);
    expect(from, start).toBeGreaterThanOrEqual(0);
    const next = source.slice(from + start.length).search(/\n(?:export )?(?:function|const) /);
    return next < 0 ? source.slice(from) : source.slice(from, from + start.length + next);
}

describe('the issue’s Attachments section', () => {
    const issue = read('screens/issue.tsx');
    const section = body(issue, 'function IssueAttachments');

    it('is the web’s: titled Attachments, with Attach beside the title, shown even with no files', () => {
        const client = web('modules/issues/IssueDetail.tsx');
        expect(client).toContain('title="Attachments"');
        expect(client).toContain('label="Attach files to the issue"');
        expect(client).toContain('None yet.');
        expect(body(issue, 'function Detail')).toContain('<IssueAttachments key={section}');
        expect(section).toContain('<SectionTitle>Attachments</SectionTitle>');
        expect(section).toContain('testID="issue-attach"');
        expect(section).toContain('accessibilityLabel={ATTACH_TO_ISSUE}');
        expect(section).toContain('<AppSymbol name="paperclip"');
        // No early return: with no files, the section says so.
        expect(section).not.toMatch(/return null/);
        expect(section).toContain('{NO_FILES}');
        expect(section).toContain('testID="issue-files-empty"');
    });

    it('picks through the comment box’s choices and tray, into the issue’s own tray', () => {
        expect(section).toContain('<AttachMenu');
        expect(section).toContain('tray.add(source)');
        expect(section).toContain('const draft = issueAttachTray(key);');
        expect(section).toMatch(/useTray\(draft, \{\s*existing: view\.fileCount,/);
        // A file that couldn't be queued stays, to remove or retry, with the pick's problems.
        expect(section).toContain('<AttachmentTray tray={tray} testID="issue-attach-tray" />');
        expect(section).toContain('{tray.notice}');
        // Two menus on one screen: the section's own test ids.
        expect(section).toContain('testID="issue-attach"\n');
        expect(read('screens/attachments.tsx')).toContain('testID={`${testID}-${source}`}');
    });

    it('attaches to the issue itself through the outbox, with no comment, as soon as a pick is copied', () => {
        expect(section).toMatch(/onAdded: \(\) => \{\s*attachToIssue\(\{/);
        expect(section).toContain('issue: key,');
        expect(section).toContain('seen: seenAttachments(detail),');
        expect(section).toContain('draft,');
        expect(section).not.toContain('commentWithFiles');
    });

    it('keeps the section’s tray an issue’s, so nothing uploads to media', () => {
        expect(issueAttachTray('12')).toBe('issue:attach:12');
        expect(isIssueFileScope(issueAttachTray('12'))).toBe(true);
        expect(isIssueFileScope(issueAttachTray('local-abc'))).toBe(true);
    });
});

describe('the issue’s vote chip at zero', () => {
    it('shows the count always, "0" too, never hidden while nobody has voted', () => {
        const chip = body(read('screens/issue.tsx'), 'function VoteChip');
        expect(chip).toContain('{String(vote.votes)}');
        expect(chip).not.toMatch(/vote\.votes\s*(?:>|===|!==|&&|\?)/);
        expect(chip).not.toMatch(/votes\s*>\s*0/);
    });
});
