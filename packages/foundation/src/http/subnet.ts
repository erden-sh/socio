import { isIPv4 } from 'node:net';

const ipv4 = (address: string) => address.split('.').reduce((value, part) => (value << 8) + Number(part), 0) >>> 0;

/** An IPv4 CIDR as a base and mask; undefined when malformed. */
export function parseSubnet(cidr: string) {
    const match = /^(\d{1,3}(?:\.\d{1,3}){3})\/(\d{1,2})$/.exec(cidr.trim());
    if (!match || !isIPv4(match[1])) {
        return undefined;
    }
    const bits = Number(match[2]);
    if (bits > 32) {
        return undefined;
    }
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    return { base: (ipv4(match[1]) & mask) >>> 0, mask };
}

/** Whether a peer address is inside the subnet (IPv4, or IPv4-mapped IPv6). */
export function inSubnet(subnet: { base: number; mask: number } | undefined, address: string | undefined) {
    if (!subnet || !address) {
        return false;
    }
    const plain = address.startsWith('::ffff:') ? address.slice(7) : address;
    if (!isIPv4(plain)) {
        return false;
    }
    return (ipv4(plain) & subnet.mask) >>> 0 === subnet.base;
}
