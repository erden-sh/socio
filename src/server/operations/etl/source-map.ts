/**
 * Every SQLite column the Operations ETL reads (CB-187), with its declared
 * type. Its bulk reads of other modules' tables are a documented exception
 * to "one owner per table" (CB-164): read-only replication, like a
 * backup. `tests/operations-etl.test.ts` checks this map against
 * `PRAGMA table_info` of a database the modules' own migrations made, so a
 * migration that renames, drops or retypes one of these fails it until the
 * ETL (and `ETL_VERSION`) follow.
 */
export const ETL_SOURCE_MAP = {
    // Turns: by `seq`; a running row is read again until it finishes.
    agent_runs: {
        seq: 'INTEGER',
        threadId: 'TEXT',
        runId: 'TEXT',
        status: 'TEXT',
        events: 'TEXT',
        startedAt: 'INTEGER',
        finishedAt: 'INTEGER',
        source: 'TEXT',
        trace: 'TEXT',
        // Only whether it is there (CB-189's taxonomy), never its text.
        errorDetail: 'TEXT',
    },
    // Small tables, read whole each cycle (dimensions).
    thread_bindings: {
        id: 'TEXT',
        dotId: 'TEXT',
        ownerId: 'TEXT',
        createdAt: 'INTEGER',
        archivedAt: 'INTEGER',
        deletedAt: 'INTEGER',
        // Rooms (CB-207, CB-218): the kind, a room's name (never a private
        // chat's title), who made or converted it and when.
        kind: 'TEXT',
        title: 'TEXT',
        createdBy: 'TEXT',
        convertedAt: 'INTEGER',
    },
    // A room a Telegram topic became (CB-214): whether one is bound.
    room_source_bindings: {
        roomId: 'TEXT',
    },
    // Work cycles (CB-211), by (startedAt, id); one not ended is read again.
    // Never its dispatch key or the tools left running.
    work_cycles: {
        id: 'TEXT',
        conversationId: 'TEXT',
        kind: 'TEXT',
        initiatorKind: 'TEXT',
        initiatorId: 'TEXT',
        actingUserId: 'TEXT',
        dotId: 'TEXT',
        billingKind: 'TEXT',
        billingUserId: 'TEXT',
        status: 'TEXT',
        startedAt: 'INTEGER',
        endedAt: 'INTEGER',
        elapsedMs: 'INTEGER',
        steps: 'INTEGER',
        handoffs: 'INTEGER',
        tokensUsed: 'INTEGER',
        costUsd: 'REAL',
        costKnown: 'INTEGER',
        limits: 'TEXT',
        endReason: 'TEXT',
    },
    dots: {
        id: 'TEXT',
        spaceId: 'TEXT',
        name: 'TEXT',
        ownerId: 'TEXT',
        createdAt: 'INTEGER',
        archivedAt: 'INTEGER',
        deletedAt: 'INTEGER',
    },
    spaces: {
        id: 'TEXT',
        name: 'TEXT',
        createdAt: 'INTEGER',
        deletedAt: 'INTEGER',
    },
    users: { id: 'TEXT', name: 'TEXT', role: 'TEXT', createdAt: 'INTEGER' },
    // The Improvements board (CB-189), read whole each cycle in pages; a
    // capability request's item by its number and title (CB-191).
    issues: {
        id: 'TEXT',
        number: 'INTEGER',
        title: 'TEXT',
        kind: 'TEXT',
        priority: 'TEXT',
        status: 'TEXT',
        reporterId: 'TEXT',
        createdAt: 'INTEGER',
        closedAt: 'INTEGER',
        deletedAt: 'INTEGER',
    },
    // A registered source's chats (`run-sources.ts`), for turns with none.
    telegram_threads: { threadId: 'TEXT' },
    // Health (CB-192): job runs by `queuedAt`, schedules' runs by
    // `startedAt` (open ones read again), and the rest whole each cycle.
    job_runs: {
        id: 'TEXT',
        jobId: 'TEXT',
        dotId: 'TEXT',
        userId: 'TEXT',
        trigger: 'TEXT',
        scheduleId: 'TEXT',
        longRunId: 'TEXT',
        status: 'TEXT',
        queuedAt: 'INTEGER',
        startedAt: 'INTEGER',
        wakeMs: 'INTEGER',
        finishedAt: 'INTEGER',
    },
    runs: {
        id: 'TEXT',
        taskId: 'TEXT',
        status: 'TEXT',
        dueAt: 'INTEGER',
        startedAt: 'INTEGER',
        finishedAt: 'INTEGER',
    },
    tasks: {
        id: 'TEXT',
        title: 'TEXT',
        dotId: 'TEXT',
        userId: 'TEXT',
        kind: 'TEXT',
        status: 'TEXT',
        cadence: 'TEXT',
        intervalSeconds: 'INTEGER',
        nextRunAt: 'INTEGER',
        lastRunAt: 'INTEGER',
        updatedAt: 'INTEGER',
        error: 'TEXT',
        deletedAt: 'INTEGER',
    },
    goals: {
        id: 'TEXT',
        dotId: 'TEXT',
        userId: 'TEXT',
        scheduleId: 'TEXT',
        status: 'TEXT',
        createdAt: 'INTEGER',
        updatedAt: 'INTEGER',
        closedAt: 'INTEGER',
    },
    jobs: { id: 'TEXT', name: 'TEXT' },
    job_long_runs: {
        id: 'TEXT',
        jobId: 'TEXT',
        dotId: 'TEXT',
        userId: 'TEXT',
        status: 'TEXT',
        batches: 'INTEGER',
        retries: 'INTEGER',
        createdAt: 'INTEGER',
        updatedAt: 'INTEGER',
        finishedAt: 'INTEGER',
        waitReason: 'TEXT',
        lastError: 'TEXT',
    },
    job_items: { longRunId: 'TEXT', status: 'TEXT' },
    // Activity and Value (CB-190): approvals by (createdAt, id), with their
    // request's chat; page writes; reactions and chats' memories read whole.
    approval_audit: {
        id: 'TEXT',
        createdAt: 'INTEGER',
        requestId: 'TEXT',
        dotId: 'TEXT',
        userId: 'TEXT',
        capability: 'TEXT',
        event: 'TEXT',
    },
    approval_requests: { id: 'TEXT', threadId: 'TEXT' },
    // Space pages (CB-191): live ones listed from `pages_live_keys`, read
    // in full only when they changed; never their text, only its length.
    // Activity (CB-190) reads pages made by (createdAt, id), with the chat a
    // person saved one from.
    pages: {
        id: 'TEXT',
        spaceId: 'TEXT',
        title: 'TEXT',
        content: 'TEXT',
        revision: 'INTEGER',
        createdAt: 'INTEGER',
        updatedAt: 'INTEGER',
        createdBy: 'TEXT',
        deletedAt: 'INTEGER',
        sourceThreadId: 'TEXT',
    },
    page_use: { pageId: 'TEXT', usedAt: 'INTEGER' },
    page_revisions: {
        id: 'INTEGER',
        pageId: 'TEXT',
        spaceId: 'TEXT',
        authorId: 'TEXT',
        replacedAt: 'INTEGER',
    },
    // A socio's draft a person approved: the socio wrote that page.
    page_reviews: { pageId: 'TEXT' },
    message_reactions: {
        threadId: 'TEXT',
        messageId: 'TEXT',
        userId: 'TEXT',
        kind: 'TEXT',
        createdAt: 'INTEGER',
    },
    memories: {
        id: 'TEXT',
        threadId: 'TEXT',
        userId: 'TEXT',
        status: 'TEXT',
        createdAt: 'INTEGER',
        confirmedAt: 'INTEGER',
        deletedAt: 'INTEGER',
    },
    page_search_daily: {
        day: 'TEXT',
        queries: 'INTEGER',
        empty: 'INTEGER',
        corrected: 'INTEGER',
        trigram: 'INTEGER',
        maxMs: 'REAL',
        histogram: 'TEXT',
    },
    // Datasets, files, attachments and apps: sizes and lifetimes (CB-191).
    data_audit: {
        id: 'TEXT',
        ownerUserId: 'TEXT',
        actorKind: 'TEXT',
        actorId: 'TEXT',
        dotId: 'TEXT',
        datasetId: 'TEXT',
        action: 'TEXT',
        outcome: 'TEXT',
        createdAt: 'INTEGER',
        // The chat a socio's tool acted in (CB-194).
        threadId: 'TEXT',
    },
    data_datasets: {
        id: 'TEXT',
        ownerUserId: 'TEXT',
        name: 'TEXT',
        scratchForDotId: 'TEXT',
        sizeBytes: 'INTEGER',
        historyBytes: 'INTEGER',
        tableCount: 'INTEGER',
        createdAt: 'INTEGER',
        updatedAt: 'INTEGER',
        deletedAt: 'INTEGER',
    },
    data_dataset_days: {
        datasetId: 'TEXT',
        day: 'INTEGER',
        sizeBytes: 'INTEGER',
        historyBytes: 'INTEGER',
        tableCount: 'INTEGER',
        measuredAt: 'INTEGER',
    },
    data_files: {
        ownerUserId: 'TEXT',
        size: 'INTEGER',
        storedSize: 'INTEGER',
        createdAt: 'INTEGER',
        deletedAt: 'INTEGER',
    },
    media_attachments: {
        size: 'INTEGER',
        createdAt: 'INTEGER',
        deletedAt: 'INTEGER',
    },
    apps: { id: 'TEXT', deletedAt: 'INTEGER' },
    app_versions: { appId: 'TEXT', sizeBytes: 'INTEGER', createdAt: 'INTEGER' },
    // Capability requests and their board items (CB-191); not their wording.
    dot_requests: {
        issueId: 'TEXT',
        capability: 'TEXT',
        createdAt: 'INTEGER',
    },
    dot_request_requesters: {
        id: 'TEXT',
        issueId: 'TEXT',
        dotId: 'TEXT',
        userId: 'TEXT',
        createdAt: 'INTEGER',
    },
    // Grounding (CB-194): what each turn read, by id, and the turns items
    // were filed from, read whole.
    run_refs: {
        id: 'INTEGER',
        runId: 'TEXT',
        threadId: 'TEXT',
        kind: 'TEXT',
        spaceId: 'TEXT',
        refId: 'TEXT',
        at: 'INTEGER',
    },
    issue_runs: {
        issueId: 'TEXT',
        runId: 'TEXT',
        threadId: 'TEXT',
        via: 'TEXT',
        createdAt: 'INTEGER',
    },
    // Failure labels in force (CB-198), and sessions' intent and themes
    // (CB-199), by `seq`; never their input text.
    classify_labels: {
        seq: 'INTEGER',
        use: 'TEXT',
        runId: 'TEXT',
        idx: 'INTEGER',
        label: 'TEXT',
        source: 'TEXT',
        provider: 'TEXT',
        applied: 'INTEGER',
    },
    // The admins' settings: retention, memory and the reporting time zone.
    settings: { id: 'INTEGER', value: 'TEXT' },
    // What turns cost (CB-195, CB-196): prices, pools, readings and the
    // app's copy of the backends, whole (Operations' own tables).
    model_prices: {
        id: 'TEXT',
        provider: 'TEXT',
        model: 'TEXT',
        modelKey: 'TEXT',
        inputPerM: 'REAL',
        cachedInputPerM: 'REAL',
        outputPerM: 'REAL',
        reasoningPerM: 'REAL',
        effectiveFrom: 'INTEGER',
        source: 'TEXT',
        fetchedAt: 'INTEGER',
    },
    cost_pools: {
        id: 'TEXT',
        name: 'TEXT',
        kind: 'TEXT',
        category: 'TEXT',
        amount: 'REAL',
        period: 'TEXT',
        depreciationMonths: 'INTEGER',
        startsAt: 'INTEGER',
        endsAt: 'INTEGER',
        backendIds: 'TEXT',
        allocation: 'TEXT',
        weights: 'TEXT',
        createdAt: 'INTEGER',
        updatedAt: 'INTEGER',
    },
    cost_meter_readings: {
        id: 'TEXT',
        poolId: 'TEXT',
        at: 'INTEGER',
        quantity: 'REAL',
        unit: 'TEXT',
        unitPrice: 'REAL',
    },
    cost_backends: {
        id: 'TEXT',
        kind: 'TEXT',
        provider: 'TEXT',
        model: 'TEXT',
    },
} as const satisfies Record<string, Record<string, string>>;

export type EtlSourceTable = keyof typeof ETL_SOURCE_MAP;
