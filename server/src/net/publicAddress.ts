import dns from 'node:dns';
import net from 'node:net';

type Lookup = (host: string, options: { all: true }) => Promise<{ address: string }[]>;

const blocked = new net.BlockList();
for (const [base, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.168.0.0', 16],
] as const) {
  blocked.addSubnet(base, prefix, 'ipv4');
}
blocked.addAddress('::', 'ipv6');
blocked.addAddress('::1', 'ipv6');
blocked.addSubnet('fc00::', 7, 'ipv6');
blocked.addSubnet('fe80::', 10, 'ipv6');

/** The IPv4 inside an IPv4-mapped IPv6 address (`::ffff:a.b.c.d` or `::ffff:aabb:ccdd`), if it is one. */
function mappedIPv4(ip: string): string | null {
  const dotted = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  if (dotted) return dotted[1]!;
  const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(ip);
  if (!hex) return null;
  const high = parseInt(hex[1]!, 16);
  const low = parseInt(hex[2]!, 16);
  return `${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`;
}

/** True for a routable address; false for loopback, private, link-local, CGNAT, unspecified (also IPv4-mapped) or not an IP at all. */
export function isPublicAddress(ip: string): boolean {
  const family = net.isIP(ip);
  if (family === 0) return false;
  if (family === 6) {
    const v4 = mappedIPv4(ip);
    if (v4) return isPublicAddress(v4);
  }
  return !blocked.check(ip, family === 4 ? 'ipv4' : 'ipv6');
}

/** True only for an http(s) URL whose host is, or resolves entirely to, public addresses. */
export async function checkPublicUrl(url: string, lookup: Lookup = dns.promises.lookup as Lookup): Promise<boolean> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
  const host = parsed.hostname.replace(/^\[|\]$/g, '');
  if (net.isIP(host)) return isPublicAddress(host);
  try {
    const addresses = await lookup(host, { all: true });
    return addresses.length > 0 && addresses.every((a) => isPublicAddress(a.address));
  } catch {
    return false;
  }
}
