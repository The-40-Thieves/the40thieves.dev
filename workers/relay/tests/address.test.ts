import { expect, test } from 'vitest';

import { isPublicAddress } from '../src/address.ts';

test.each([
  ['172.15.255.255', true],
  ['172.16.0.0', false],
  ['172.31.255.255', false],
  ['172.32.0.0', true],
  ['100.63.255.255', true],
  ['100.64.0.0', false],
  ['100.127.255.255', false],
  ['100.128.0.0', true],
  ['0.0.0.0', false],
  ['0.255.255.255', false],
  ['1.1.1.1', true],
  ['8.8.8.8', true],
  ['10.0.0.1', false],
  ['127.0.0.1', false],
  ['169.254.169.254', false],
  ['192.0.0.1', false],
  ['192.0.2.1', false],
  ['192.168.1.1', false],
  ['198.17.255.255', true],
  ['198.18.0.0', false],
  ['198.19.255.255', false],
  ['198.20.0.0', true],
  ['198.51.100.7', false],
  ['203.0.113.7', false],
  ['223.255.255.255', true],
  ['224.0.0.1', false],
  ['240.0.0.1', false],
  ['255.255.255.255', false],
])('IPv4 %s public=%s', (ip, expected) => {
  expect(isPublicAddress(ip)).toBe(expected);
});

test.each([
  ['2606:4700::1111', true],
  ['2001:4860:4860::8888', true],
  ['::', false],
  ['::1', false],
  ['fc00::1', false],
  ['fdff::1', false],
  ['fe80::1', false],
  ['febf::1', false],
  ['ff02::1', false],
  ['2001:db8::1', false],
  ['2001:db9::1', true],
  ['100::1', false],
  ['100:0:0:1::1', true],
  ['::ffff:10.0.0.1', false],
  ['::ffff:a00:1', false],
  ['::ffff:8.8.8.8', true],
  ['64:ff9b::7f00:1', false],
  ['64:ff9b::127.0.0.1', false],
  ['64:ff9b::808:808', true],
  ['2002:7f00:1::1', false],
  ['2002:808:808::1', true],
  ['2606:4700:0:0:0:0:0:1111', true],
])('IPv6 %s public=%s', (ip, expected) => {
  expect(isPublicAddress(ip)).toBe(expected);
});

test.each([
  '',
  'example.com',
  '1.2.3',
  '1.2.3.4.5',
  '256.1.1.1',
  '01.2.3.4',
  '1.2.3.4 ',
  ' 1.2.3.4',
  '8.8.8.8/32',
  '1:2:3:4:5:6:7',
  '1:2:3:4:5:6:7:8:9',
  '1::2::3',
  ':::',
  '12345::1',
  'g::1',
  '[2606:4700::1111]',
  'fe80::1%eth0',
  '::ffff:1.2.3',
  '1.1.1.1:80',
])('does not parse as one address: %j is not public', (text) => {
  expect(isPublicAddress(text)).toBe(false);
});
