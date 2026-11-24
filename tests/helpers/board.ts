import type { AppWorkspace as WorkspaceStore } from '../../src/server/composition/workspace-parts.js';
import { sqliteBoard, type SqliteBoard } from '../../src/server/issues/services.js';
import { peopleSync } from '../../src/server/workspace/layer.js';

const boards = new WeakMap<WorkspaceStore, SqliteBoard>();

/**
 * The Board over a workspace's database, for tests that have no Platform.
 * Memoized per WorkspaceStore so repeated calls in one test share one
 * instance (and its listeners). Tests with a Platform use `platform.board`.
 */
export function boardOf(workspace: WorkspaceStore): SqliteBoard {
    let board = boards.get(workspace);
    if (!board) {
        board = sqliteBoard(workspace.db, peopleSync(workspace));
        boards.set(workspace, board);
    }
    return board;
}
