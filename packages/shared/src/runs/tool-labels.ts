/*
 * The friendly names of the socios' tools (CB-72), shared by the web and
 * the app. A label names its icon; each client maps the names to
 * its own icon set (the web's lucide-react, the app's), so nothing here
 * imports one.
 */

/** The icons a step may show, by lucide name. */
export const TOOL_ICONS = [
    'app-window',
    'book-open',
    'calendar-clock',
    'chart-column',
    'circle-dot',
    'copy',
    'database',
    'file-check',
    'file-code',
    'file-pen',
    'file-plus',
    'file-text',
    'file-up',
    'files',
    'folder-input',
    'folder-open',
    'folder-plus',
    'globe',
    'key-round',
    'keyboard',
    'library',
    'lightbulb',
    'list-checks',
    'message-square',
    'monitor',
    'mouse-pointer-click',
    'paperclip',
    'play',
    'scroll-text',
    'search',
    'square-pen',
    'table',
    'target',
    'terminal',
    'thumbs-up',
    'wrench',
] as const;
export type ToolIcon = (typeof TOOL_ICONS)[number];

/** A tool call's arguments, parsed (empty while they stream). */
export type Args = Record<string, unknown>;

/** What a step does while it runs, and once done. */
type Verbs = readonly [doing: string, done: string];

interface ToolLabel {
    icon: ToolIcon;
    verbs: Verbs | ((args: Args) => Verbs);
    /**
     * What it acted on, finishing the sentence: "for “export”" after
     * "Searched the board". From the arguments, or the result's title.
     */
    detail?: (args: Args, result: Args) => string | undefined;
    /** The detail is code (a command): it shows in monospace. */
    code?: boolean;
}

const text = (value: unknown) => (typeof value === 'string' && value.trim() ? value.trim() : undefined);
const clip = (value: string, max = 60) => (value.length > max ? `${value.slice(0, max - 1)}…` : value);
const quote = (value: unknown) => {
    const found = text(value);
    return found ? `“${clip(found)}”` : undefined;
};
const prefixed = (word: string, value: unknown) => {
    const found = text(value);
    return found ? `${word} ${clip(found)}` : undefined;
};
const host = (value: unknown) => {
    const found = text(value);
    if (!found) {
        return undefined;
    }
    try {
        return new URL(found).host || clip(found);
    } catch {
        return clip(found);
    }
};
const titleOf = (args: Args, result: Args) => quote(result.title) ?? quote(args.title);

/**
 * An icon and plain verbs per tool,
 * so a step reads "Searched the board for “export”". A tool not listed
 * reads "Used <its name in words>".
 */
const labels: Record<string, ToolLabel> = {
    search_improvements: {
        icon: 'search',
        verbs: ['Searching the board', 'Searched the board'],
        detail: (args) => prefixed('for', quote(args.query)),
    },
    read_improvement: {
        icon: 'circle-dot',
        verbs: ['Reading', 'Read'],
        detail: (args) => text(args.issue) ?? 'an item on the board',
    },
    file_improvement: {
        icon: 'square-pen',
        verbs: ['Filing on the board', 'Filed on the board'],
        detail: (args) => quote(args.title),
    },
    vote_improvement: {
        icon: 'thumbs-up',
        verbs: (args) =>
            args.withdraw === true ? ['Withdrawing your vote on', 'Withdrew your vote on'] : ['Voting on', 'Voted on'],
        detail: (args) => text(args.issue),
    },
    comment_on_improvement: {
        icon: 'message-square',
        verbs: ['Commenting on', 'Commented on'],
        detail: (args) => text(args.issue),
    },
    set_improvement_status: {
        icon: 'circle-dot',
        verbs: ['Changing the status of', 'Changed the status of'],
        detail: (args) => text(args.issue),
    },
    list_authorized_spaces: {
        icon: 'library',
        verbs: ['Listing the Spaces', 'Listed the Spaces'],
    },
    create_space: {
        icon: 'folder-plus',
        verbs: ['Asking to create the Space', 'Asked to create the Space'],
        detail: (args) => quote(args.name),
    },
    rename_space: {
        icon: 'square-pen',
        verbs: ['Renaming the Space', 'Renamed the Space'],
        detail: (args) => prefixed('to', quote(args.name)),
    },
    list_space_pages: {
        icon: 'files',
        verbs: ['Listing pages', 'Listed pages'],
    },
    search_space_pages: {
        icon: 'search',
        verbs: ['Searching pages', 'Searched pages'],
        detail: (args) => prefixed('for', quote(args.query)),
    },
    read_space_page: {
        icon: 'file-text',
        verbs: ['Reading', 'Read'],
        detail: (args, result) => titleOf(args, result) ?? 'a page',
    },
    create_space_page: {
        icon: 'file-plus',
        verbs: ['Creating', 'Created'],
        detail: (args, result) => titleOf(args, result) ?? 'a page',
    },
    edit_space_page: {
        icon: 'file-pen',
        verbs: ['Editing', 'Edited'],
        detail: (args, result) => titleOf(args, result) ?? 'a page',
    },
    move_space_page: {
        icon: 'folder-input',
        verbs: ['Moving', 'Moved'],
        detail: (args, result) => titleOf(args, result) ?? 'a page',
    },
    review_space_page: {
        icon: 'file-check',
        verbs: ['Proposing changes to a page', 'Proposed changes to a page'],
    },
    insert_dataset_view: {
        icon: 'chart-column',
        verbs: ['Adding a view to a page', 'Added a view to a page'],
        detail: (args) => quote(args.title),
    },
    data_list: {
        icon: 'database',
        verbs: ['Listing datasets', 'Listed datasets'],
    },
    data_describe: {
        icon: 'database',
        verbs: ['Describing', 'Described'],
        detail: (args) => text(args.dataset) ?? 'a dataset',
    },
    data_create_table: {
        icon: 'table',
        verbs: ['Creating the table', 'Created the table'],
        detail: (args) => text(args.table),
    },
    data_add_column: {
        icon: 'table',
        verbs: ['Adding a column', 'Added a column'],
        detail: (args) => prefixed('to', args.table),
    },
    data_create_index: {
        icon: 'table',
        verbs: ['Adding an index', 'Added an index'],
        detail: (args) => prefixed('to', args.table),
    },
    data_drop_index: {
        icon: 'table',
        verbs: ['Removing an index', 'Removed an index'],
        detail: (args) => prefixed('from', args.table),
    },
    data_analyze: {
        icon: 'table',
        verbs: ['Refreshing query statistics', 'Refreshed query statistics'],
        detail: (args) => prefixed('for', args.table),
    },
    data_insert: {
        icon: 'table',
        verbs: ['Adding rows', 'Added rows'],
        detail: (args) => prefixed('to', args.table),
    },
    data_upsert: {
        icon: 'table',
        verbs: ['Saving rows', 'Saved rows'],
        detail: (args) => prefixed('to', args.table),
    },
    data_query: {
        icon: 'database',
        verbs: ['Querying', 'Queried'],
        detail: (args) => text(args.dataset) ?? 'a dataset',
    },
    data_create_dataset: {
        icon: 'database',
        verbs: ['Creating the dataset', 'Created the dataset'],
        detail: (args) => quote(args.name),
    },
    data_request_access: {
        icon: 'key-round',
        verbs: ['Asking for access', 'Asked for access'],
        detail: (args) => prefixed('to', args.dataset ?? args.folder),
    },
    files_put: {
        icon: 'file-up',
        verbs: ['Saving', 'Saved'],
        detail: (args) => text(args.path) ?? 'a file',
    },
    files_get: {
        icon: 'file-text',
        verbs: ['Reading', 'Read'],
        detail: (args) => text(args.path) ?? 'a file',
    },
    space_media_upload: {
        icon: 'file-up',
        verbs: ['Uploading to a Space', 'Uploaded to a Space'],
        detail: (args) =>
            Array.isArray(args.files) ? `${args.files.length} file${args.files.length === 1 ? '' : 's'}` : 'files',
    },
    files_copy: {
        icon: 'copy',
        verbs: ['Copying', 'Copied'],
        detail: (args) => text(args.from) ?? 'a file',
    },
    files_list: {
        icon: 'folder-open',
        verbs: ['Listing files', 'Listed files'],
        detail: (args) => prefixed('in', args.prefix),
    },
    attachments_list: {
        icon: 'paperclip',
        verbs: ['Listing attachments', 'Listed attachments'],
    },
    search_web: {
        icon: 'globe',
        verbs: ['Searching the web', 'Searched the web'],
        detail: (args) =>
            prefixed('for', quote(Array.isArray(args.search_queries) ? args.search_queries[0] : args.objective)),
    },
    read_public_page: {
        icon: 'globe',
        verbs: ['Reading', 'Read'],
        detail: (args) => host(args.url) ?? 'a web page',
    },
    http_get: {
        icon: 'globe',
        verbs: ['Fetching', 'Fetched'],
        detail: (args) => host(args.url) ?? 'a web address',
    },
    http_json: {
        icon: 'globe',
        verbs: ['Fetching', 'Fetched'],
        detail: (args) => host(args.url) ?? 'a web address',
    },
    request_capability: {
        icon: 'lightbulb',
        verbs: ['Asking the team for a capability', 'Asked the team for a capability'],
    },
    job_save: {
        icon: 'file-code',
        verbs: ['Saving the job', 'Saved the job'],
        detail: (args) => quote(args.name),
    },
    job_run: { icon: 'play', verbs: ['Running a job', 'Ran a job'] },
    job_list: { icon: 'list-checks', verbs: ['Listing jobs', 'Listed jobs'] },
    job_logs: {
        icon: 'scroll-text',
        verbs: ['Reading a job’s logs', 'Read a job’s logs'],
    },
    job_status: {
        icon: 'list-checks',
        verbs: ['Checking on a job', 'Checked on a job'],
    },
    job_inspect: {
        icon: 'list-checks',
        verbs: ['Inspecting a job', 'Inspected a job'],
    },
    job_retry: { icon: 'play', verbs: ['Retrying a job', 'Retried a job'] },
    schedule_create: {
        icon: 'calendar-clock',
        verbs: ['Scheduling', 'Scheduled'],
        detail: (args) => quote(args.title) ?? 'a task',
    },
    schedule_list: {
        icon: 'calendar-clock',
        verbs: ['Listing schedules', 'Listed schedules'],
    },
    goal_set: {
        icon: 'target',
        verbs: ['Setting a goal', 'Set a goal'],
        detail: (args) => quote(args.title),
    },
    goal_list: { icon: 'target', verbs: ['Listing goals', 'Listed goals'] },
    goal_comment: {
        icon: 'target',
        verbs: ['Commenting on a goal', 'Commented on a goal'],
    },
    goal_update: { icon: 'target', verbs: ['Updating a goal', 'Updated a goal'] },
    app_register: {
        icon: 'app-window',
        verbs: ['Registering the app', 'Registered the app'],
        detail: (args) => quote(args.name),
    },
    app_list: { icon: 'app-window', verbs: ['Listing apps', 'Listed apps'] },
    app_logs: {
        icon: 'app-window',
        verbs: ['Reading the app’s logs', 'Read the app’s logs'],
        detail: (args) => quote(args.app),
    },
    app_unregister: {
        icon: 'app-window',
        verbs: ['Removing the app', 'Removed the app'],
        detail: (args) => quote(args.app),
    },
    app_package: {
        icon: 'app-window',
        verbs: ['Packaging the app', 'Packaged the app'],
        detail: (args) => quote(args.app),
    },
    app_promote: {
        icon: 'app-window',
        verbs: ['Promoting an app', 'Promoted an app'],
    },
    app_update: {
        icon: 'app-window',
        verbs: ['Updating an app', 'Updated an app'],
    },
    app_combine: {
        icon: 'app-window',
        verbs: ['Combining apps', 'Combined apps'],
    },
    copilotkit_load_skill: {
        icon: 'book-open',
        verbs: ['Loading the skill', 'Loaded the skill'],
        detail: (args) => quote(args.skill_name),
    },
    copilotkit_read_skill_file: {
        icon: 'book-open',
        verbs: ['Reading', 'Read'],
        detail: (args) => text(args.path) ?? 'a skill file',
    },
    // The socio's computer (CB-72: the inline computer card's labels).
    computer_navigate: {
        icon: 'globe',
        verbs: ['Opening', 'Opened'],
        detail: (args) => host(args.url) ?? 'a website',
    },
    computer_snapshot: {
        icon: 'monitor',
        verbs: ['Inspecting the browser', 'Inspected the browser'],
    },
    computer_read: {
        icon: 'monitor',
        verbs: ['Reading the page', 'Read the page'],
    },
    computer_screenshot: {
        icon: 'monitor',
        verbs: ['Looking at the browser', 'Looked at the browser'],
    },
    computer_click: {
        icon: 'mouse-pointer-click',
        verbs: ['Clicking in the browser', 'Clicked in the browser'],
    },
    computer_type: {
        icon: 'keyboard',
        verbs: ['Typing in the browser', 'Typed in the browser'],
    },
    computer_key: {
        icon: 'keyboard',
        verbs: ['Pressing', 'Pressed'],
        detail: (args) => text(args.key) ?? 'a key',
    },
    computer_scroll: {
        icon: 'monitor',
        verbs: ['Scrolling the page', 'Scrolled the page'],
    },
    computer_files_write: {
        icon: 'file-up',
        verbs: ['Saving', 'Saved'],
        detail: (args) => text(args.path) ?? 'a file',
    },
    computer_files_read: {
        icon: 'file-text',
        verbs: ['Reading', 'Read'],
        detail: (args) => text(args.path) ?? 'a file',
    },
    computer_files_list: {
        icon: 'folder-open',
        verbs: ['Listing files', 'Listed files'],
        detail: (args) => prefixed('in', args.path),
    },
    computer_exec: {
        icon: 'terminal',
        // A command of several lines is a script.
        verbs: (args) =>
            text(args.command)?.includes('\n')
                ? ['Running a script', 'Ran a script']
                : ['Running a command', 'Ran a command'],
        detail: (args) => text(args.command)?.split('\n')[0],
        code: true,
    },
};

/** A step's label as it shows. */
export interface ToolLabelText {
    icon: ToolIcon;
    verb: string;
    detail?: string;
    code?: boolean;
}

/** "data_create_table" in words: "data create table". */
const words = (name: string) =>
    name
        .replace(/[_-]+/g, ' ')
        .replace(/([a-z])([A-Z])/g, '$1 $2')
        .toLowerCase()
        .trim();

/**
 * A step's icon (by name) and sentence, split as it shows: the verb, then
 * what it acted on (muted). `done` picks the past tense.
 */
export function toolLabel(name: string, args: Args, result: Args, done: boolean): ToolLabelText {
    const label = labels[name];
    if (!label) {
        const named = words(name) || 'a tool';
        return { icon: 'wrench', verb: done ? `Used ${named}` : `Using ${named}` };
    }
    const verbs = typeof label.verbs === 'function' ? label.verbs(args) : label.verbs;
    return {
        icon: label.icon,
        verb: verbs[done ? 1 : 0],
        detail: label.detail?.(args, result),
        code: label.code,
    };
}
