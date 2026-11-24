import { crc32 } from 'node:zlib';

/**
 * A minimal, deterministic store-only zip writer (no compression, zeroed
 * timestamps, UTF-8 names, entries in the given order). Snapshot bytes, and
 * so their SHA-256 etag, depend only on the entries. The runtime reads these
 * with yauzl, which accepts method 0.
 */
export function storeZip(entries: Array<[name: string, data: Uint8Array]>) {
    const parts: Buffer[] = [];
    const central: Buffer[] = [];
    let offset = 0;
    for (const [name, data] of entries) {
        const nameBytes = Buffer.from(name, 'utf8');
        const body = Buffer.from(data);
        const crc = crc32(body) >>> 0;
        const local = Buffer.alloc(30);
        local.writeUInt32LE(0x04034b50, 0);
        local.writeUInt16LE(20, 4); // version needed
        local.writeUInt16LE(0x0800, 6); // UTF-8 names
        local.writeUInt16LE(0, 8); // stored
        local.writeUInt32LE(0, 10); // time and date
        local.writeUInt32LE(crc, 14);
        local.writeUInt32LE(body.length, 18);
        local.writeUInt32LE(body.length, 22);
        local.writeUInt16LE(nameBytes.length, 26);
        local.writeUInt16LE(0, 28);
        parts.push(local, nameBytes, body);
        const header = Buffer.alloc(46);
        header.writeUInt32LE(0x02014b50, 0);
        header.writeUInt16LE(20, 4); // version made by
        header.writeUInt16LE(20, 6);
        header.writeUInt16LE(0x0800, 8);
        header.writeUInt16LE(0, 10);
        header.writeUInt32LE(0, 12);
        header.writeUInt32LE(crc, 16);
        header.writeUInt32LE(body.length, 20);
        header.writeUInt32LE(body.length, 24);
        header.writeUInt16LE(nameBytes.length, 28);
        // extra, comment, disk, internal attributes: 0
        header.writeUInt32LE(0, 38); // external attributes
        header.writeUInt32LE(offset, 42);
        central.push(header, nameBytes);
        offset += local.length + nameBytes.length + body.length;
    }
    const directory = Buffer.concat(central);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(entries.length, 8);
    end.writeUInt16LE(entries.length, 10);
    end.writeUInt32LE(directory.length, 12);
    end.writeUInt32LE(offset, 16);
    return Buffer.concat([...parts, directory, end]);
}
