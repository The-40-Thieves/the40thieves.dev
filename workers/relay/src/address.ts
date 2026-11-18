/**
 * Address checks for the relay's DNS defence. The Workers runtime has no node:net, so IPv4 and IPv6 text
 * is parsed here. Anything that does not parse as exactly one address is not public.
 */

type V4 = readonly [number, number, number, number];

function parseV4(text: string): V4 | null {
  const parts = text.split('.');
  if (parts.length !== 4) return null;
  const octets: number[] = [];
  for (const part of parts) {
    // Plain decimal only: no signs, no spaces, no leading zeros (some stacks read those as octal).
    if (!/^(0|[1-9][0-9]{0,2})$/.test(part)) return null;
    const value = Number(part);
    if (value > 255) return null;
    octets.push(value);
  }
  return octets as unknown as V4;
}

/** Eight 16-bit groups, `::` expanded and an embedded dotted IPv4 tail folded into the last two groups. */
function parseV6(input: string): number[] | null {
  if (!/^[0-9a-fA-F:.]+$/.test(input)) return null;
  let text = input;
  if (text.includes('.')) {
    const cut = text.lastIndexOf(':');
    const tail = parseV4(text.slice(cut + 1));
    if (cut < 0 || tail === null) return null;
    const high = ((tail[0] << 8) | tail[1]).toString(16);
    const low = ((tail[2] << 8) | tail[3]).toString(16);
    text = `${text.slice(0, cut + 1)}${high}:${low}`;
  }
  const gap = text.indexOf('::');
  if (gap !== text.lastIndexOf('::') || text.includes(':::')) return null;

  const split = (part: string): string[] => (part === '' ? [] : part.split(':'));
  const head = split(gap < 0 ? text : text.slice(0, gap));
  const tail = gap < 0 ? [] : split(text.slice(gap + 2));
  const written = head.length + tail.length;
  if (gap < 0 ? written !== 8 : written > 7) return null;

  const groups: number[] = [];
  for (const group of [
    ...head,
    ...new Array<string>(gap < 0 ? 0 : 8 - written).fill('0'),
    ...tail,
  ]) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(group)) return null;
    groups.push(parseInt(group, 16));
  }
  return groups;
}

function isPublicV4([a, b, c]: V4): boolean {
  if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
  if (a === 100 && b >= 64 && b <= 127) return false;
  if (a === 169 && b === 254) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && b === 168) return false;
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return false;
  if (a === 192 && b === 88 && c === 99) return false; // 6to4 relay anycast (deprecated)
  if (a === 198 && (b === 18 || b === 19)) return false;
  if (a === 198 && b === 51 && c === 100) return false;
  if (a === 203 && b === 0 && c === 113) return false;
  return true;
}

function v4From(high: number, low: number): V4 {
  return [high >> 8, high & 0xff, low >> 8, low & 0xff];
}

function isPublicV6(g: readonly number[]): boolean {
  const [g0, g1, g2, g3, g4, g5, g6, g7] = g as [
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  const zeroTo = (end: number): boolean => g.slice(0, end).every((group) => group === 0);

  if (zeroTo(5)) {
    // ::/96 (unspecified, loopback, IPv4-compatible): never a public destination.
    if (g5 === 0) return false;
    // ::ffff:0:0/96 IPv4-mapped.
    if (g5 === 0xffff) return isPublicV4(v4From(g6, g7));
  }
  if (g0 === 0x64 && g1 === 0xff9b) {
    // 64:ff9b::/96 NAT64 carries an IPv4 address; the rest of 64:ff9b::/32 (incl. local-use /48) is refused.
    if (g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0) return isPublicV4(v4From(g6, g7));
    return false;
  }
  if (g0 === 0x2002) return isPublicV4(v4From(g1, g2)); // 6to4 embeds an IPv4 address
  if ((g0 & 0xfe00) === 0xfc00) return false; // fc00::/7 unique local
  if ((g0 & 0xffc0) === 0xfe80) return false; // fe80::/10 link local
  if ((g0 & 0xffc0) === 0xfec0) return false; // fec0::/10 site local (deprecated)
  if ((g0 & 0xff00) === 0xff00) return false; // ff00::/8 multicast
  // Everything else must be global unicast, 2000::/3. That one rule refuses the unassigned and
  // special-use space outside it without a list to keep current: 100::/64 discard, 100:0:0:1::/64
  // dummy, 5f00::/16 SRv6 SIDs, and whatever is assigned there next.
  if ((g0 & 0xe000) !== 0x2000) return false;
  // Inside 2000::/3, the IANA special-purpose registry's blocks.
  if (g0 === 0x2001 && g1 < 0x0200) return false; // 2001::/23 protocol assignments (Teredo, benchmarking, ORCHID)
  if (g0 === 0x2001 && g1 === 0x0db8) return false; // 2001:db8::/32 documentation
  if (g0 === 0x3fff && g1 < 0x1000) return false; // 3fff::/20 documentation
  return true;
}

/**
 * The network a client address counts as, for rate limits and visitor budgets. An IPv4 address
 * is itself. An IPv6 address is its /64: one subscriber usually holds at least that much and can
 * move between its addresses at no cost, so counting per address would count nothing. An
 * IPv4-mapped address is the IPv4 address. Text that is not an address is returned unchanged.
 */
export function clientNetwork(ip: string): string {
  if (!ip.includes(':')) return ip;
  const groups = parseV6(ip);
  if (groups === null) return ip;
  const [g0, g1, g2, g3, g4, g5, g6, g7] = groups as [
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0xffff) {
    return v4From(g6, g7).join('.');
  }
  return `${[g0, g1, g2, g3].map((group) => group.toString(16)).join(':')}::/64`;
}

/** True only when `ip` parses as exactly one IPv4 or IPv6 address that is not private, reserved or special-use. */
export function isPublicAddress(ip: string): boolean {
  if (ip.includes(':')) {
    const groups = parseV6(ip);
    return groups !== null && isPublicV6(groups);
  }
  const octets = parseV4(ip);
  return octets !== null && isPublicV4(octets);
}
