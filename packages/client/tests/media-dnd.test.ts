import { expect, it } from 'vitest';

import { dropPath, fileDrag, folderDrag, movableFolder } from '../src/modules/media/media-dnd';

const file = fileDrag({
    id: 'f1',
    path: 'work/q3/report.pdf',
    folder: 'work/q3/',
    name: 'Report (final).pdf',
});

it('lands a dropped file in the folder, under its path name (CB-255)', () => {
    expect(dropPath(file, 'archive/')).toBe('archive/report.pdf');
    expect(dropPath(file, 'work/')).toBe('work/report.pdf');
    // Back to the top level, from a breadcrumb or the tree's root.
    expect(dropPath(file, '')).toBe('report.pdf');
    expect(dropPath(file, 'dots/d1/')).toBe('dots/d1/report.pdf');
    // Where it already is: nothing to drop.
    expect(dropPath(file, 'work/q3/')).toBeUndefined();
});

it('never drops a folder into itself or one of its subfolders (CB-255)', () => {
    const work = folderDrag('work/q3/');
    expect(dropPath(work, 'archive/')).toBe('archive/q3/');
    expect(dropPath(work, '')).toBe('q3/');
    expect(dropPath(work, 'workshop/')).toBe('workshop/q3/');
    expect(dropPath(work, 'work/q3/')).toBeUndefined();
    expect(dropPath(work, 'work/q3/deep/')).toBeUndefined();
    // Its own parent: it is there already.
    expect(dropPath(work, 'work/')).toBeUndefined();
    // Not straight into Socios, where it would pass for a socio's folder.
    expect(dropPath(work, 'dots/')).toBeUndefined();
    expect(dropPath(work, 'dots/d1/')).toBe('dots/d1/q3/');
});

it('keeps the root, Socios and a socio’s own folder in place (CB-255)', () => {
    for (const folder of ['', 'dots/', 'dots/d1/']) {
        expect(movableFolder(folder)).toBe(false);
        expect(dropPath(folderDrag(folder), 'archive/')).toBeUndefined();
    }
    expect(movableFolder('dots/d1/notes/')).toBe(true);
    expect(movableFolder('attachments/')).toBe(true);
});
