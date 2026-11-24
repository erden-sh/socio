import {
    CLOSED_ISSUE_STATUSES,
    ISSUE_PRIORITIES,
    issueKey,
    type Issue,
    type IssueArea,
    type IssueKind,
    type IssueLabel,
    type IssuePriority,
    type IssueStatus,
} from '@socio/shared/issues/issue-types';

import { IssueError } from './contract.js';
import type { IssueImport } from './store.js';

/**
 * An ISSUES.md file in and out: a table (ID, Issue, Severity, Status, Owner)
 * plus one `## CB-<n> <title>` section per issue. Parsing is pure; the
 * export writes the same shape (formatted as the repo's formatter, oxfmt, writes it) so that
 * parse(export(issues)) gives the issues back.
 */
const STATUS_WORDS: Record<string, IssueStatus> = {
    triage: 'triage',
    open: 'open',
    ready: 'ready',
    'in progress': 'in_progress',
    'in review': 'in_review',
    blocked: 'blocked',
    done: 'done',
    "won't fix": 'wont_fix',
    'wont fix': 'wont_fix',
};
const statusWord = (status: IssueStatus) => (status === 'wont_fix' ? "won't fix" : status.replace('_', ' '));
// The release-1 file has no kind column; these were not bugs.
const KIND_OVERRIDES: Record<number, IssueKind> = {
    10: 'chore',
    11: 'improvement',
    16: 'chore',
};
// First match on the title wins.
const AREA_HINTS: Array<[RegExp, IssueArea]> = [
    [/attachment/i, 'server'],
    [/\bruns?\b|failed turns?/i, 'runs'],
    [/telegram|topic|mention|sticker/i, 'telegram'],
    [/qwen|model/i, 'model'],
    [/certificate|proxy|image|build|deploy/i, 'deploy'],
    [/release guide|\bdocs?\b/i, 'docs'],
    [/smoke|exit test/i, 'tests'],
    [/space|page/i, 'spaces'],
];
const HASHES = /^[0-9a-f]{7,40}(?:,\s*[0-9a-f]{7,40})*$/;
const FIXED_IN = /^Fixed in ([0-9a-f]{7,40}(?:, [0-9a-f]{7,40})*)$/;
const COLUMNS = ['id', 'issue', 'severity', 'status', 'owner'] as const;

const cells = (line: string) =>
    line
        .trim()
        .replace(/^\||\|$/g, '')
        .split(/(?<!\\)\|/)
        .map((cell) => cell.trim().replace(/\\\|/g, '|'));
const fail = (message: string) => {
    throw new IssueError(message);
};

function owner(number: number, cell: string): { labels: IssueLabel[]; resolution: string | null } {
    if (!cell) {
        return { labels: [], resolution: null };
    }
    if (HASHES.test(cell)) {
        return {
            labels: [],
            resolution: `Fixed in ${cell.split(/,\s*/).join(', ')}`,
        };
    }
    // "user (proxy)": the qualifier has no field and is dropped.
    const who = /^(lead|user)(?:\s*\(.*\))?$/i.exec(cell)?.[1]?.toLowerCase();
    if (who) {
        return { labels: [`owner:${who}` as IssueLabel], resolution: null };
    }
    return fail(`${issueKey(number)}: unknown owner “${cell}”.`);
}

/** The issues in an `ISSUES.md` file, in table order. */
export function parseIssuesMarkdown(markdown: string): IssueImport[] {
    const lines = markdown.replace(/\r\n?/g, '\n').split('\n');
    const start = lines.findIndex((line) => /^\|\s*ID\s*\|/i.test(line));
    if (start < 0) {
        fail('No issue table found (a row starting “| ID |”).');
    }
    const header = cells(lines[start]).map((cell) => cell.toLowerCase());
    const column = Object.fromEntries(
        COLUMNS.map((name) => {
            const index = header.indexOf(name);
            if (index < 0) {
                fail(`The issue table has no “${name}” column.`);
            }
            return [name, index];
        }),
    ) as Record<(typeof COLUMNS)[number], number>;
    const rows: string[][] = [];
    for (let i = start + 2; i < lines.length && lines[i].startsWith('|'); i++) {
        rows.push(cells(lines[i]));
    }

    // Section bodies, keyed by number: everything up to the next `## ` heading.
    const sections = new Map<number, string>();
    let current: number | undefined;
    let body: string[] = [];
    const flush = () => {
        if (current !== undefined) {
            if (sections.has(current)) {
                fail(`${issueKey(current)} has two sections.`);
            }
            sections.set(current, body.join('\n').trim());
        }
    };
    for (const line of lines.slice(start)) {
        if (/^#{1,2} /.test(line)) {
            flush();
            current = Number(/^## CB-(\d+)\b/.exec(line)?.[1]) || undefined;
            body = [];
        } else {
            body.push(line);
        }
    }
    flush();

    const seen = new Set<number>();
    const issues = rows.map((row): IssueImport => {
        const id = row[column.id];
        const number = Number(/^CB-(\d+)$/.exec(id)?.[1]);
        if (!number) {
            fail(`Unknown issue ID “${id}”; use CB-<number>.`);
        }
        if (seen.has(number)) {
            fail(`${id} appears twice in the table.`);
        }
        seen.add(number);
        const title = row[column.issue];
        if (title.length < 3 || title.length > 200) {
            fail(`${id}: the title must be 3 to 200 characters.`);
        }
        const priority = row[column.severity].toLowerCase() as IssuePriority;
        if (!ISSUE_PRIORITIES.includes(priority)) {
            fail(`${id}: unknown severity “${row[column.severity]}”.`);
        }
        const status = STATUS_WORDS[row[column.status].toLowerCase()];
        if (!status) {
            fail(`${id}: unknown status “${row[column.status]}”.`);
        }
        return {
            number,
            title,
            body: sections.get(number) ?? '',
            status,
            priority,
            kind: KIND_OVERRIDES[number] ?? 'bug',
            area: AREA_HINTS.find(([pattern]) => pattern.test(title))?.[1] ?? null,
            ...owner(number, row[column.owner] ?? ''),
        };
    });
    for (const number of sections.keys()) {
        if (!seen.has(number)) {
            fail(`${issueKey(number)} has a section but no table row.`);
        }
    }
    return issues;
}

/** Cell width as the formatter measures it for plain text. */
const width = (text: string) => [...text].length;
function table(rows: string[][]) {
    const widths = rows[0].map((_, i) => Math.max(3, ...rows.map((row) => width(row[i]))));
    const line = (row: string[]) =>
        `| ${row.map((cell, i) => cell + ' '.repeat(widths[i] - width(cell))).join(' | ')} |`;
    return [line(rows[0]), line(widths.map((n) => '-'.repeat(n))), ...rows.slice(1).map(line)].join('\n');
}

/** The Owner cell: commit hashes from the resolution, else an owner label. */
function ownerCell(issue: Issue) {
    const fixed = FIXED_IN.exec(issue.resolution ?? '')?.[1];
    if (fixed) {
        return fixed;
    }
    if (issue.labels.includes('owner:lead')) {
        return 'lead';
    }
    if (issue.labels.includes('owner:user')) {
        return 'user';
    }
    return '';
}

/** A markdown snapshot of the tracker in the `ISSUES.md` format. */
export function issuesMarkdown(issues: Issue[]): string {
    const sorted = [...issues].sort((a, b) => a.number - b.number);
    const escape = (text: string) => text.replace(/\|/g, '\\|');
    const rows = [
        ['ID', 'Issue', 'Severity', 'Status', 'Owner'],
        ...sorted.map((issue) => [
            issueKey(issue.number),
            escape(issue.title),
            issue.priority,
            statusWord(issue.status),
            ownerCell(issue),
        ]),
    ];
    const sections = sorted.map((issue) => {
        const closed = CLOSED_ISSUE_STATUSES.includes(issue.status) ? ` (${statusWord(issue.status)})` : '';
        const heading = `## ${issueKey(issue.number)} ${issue.title}${closed}`;
        return issue.body.trim() ? `${heading}\n\n${issue.body.trim()}` : heading;
    });
    return `${[
        '# Issues',
        "A snapshot of Socio's issue tracker, which is the tracker of record: file and edit issues in the app's Issues view. One row per issue; details below the table. Status: `triage`, `open`, `ready`, `in progress`, `in review`, `blocked`, `done`, `won't fix`.",
        table(rows),
        ...sections,
    ].join('\n\n')}\n`;
}
