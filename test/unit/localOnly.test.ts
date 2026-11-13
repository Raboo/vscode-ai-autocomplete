import { describe, expect, test } from 'vitest';
import { isLocalEndpoint, isObviouslyLocal, isPrivateAddress } from '../../src/config/localOnly';

describe('isPrivateAddress', () => {
  test.each(['127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.5', '169.254.1.1', '100.64.0.1', '::1', 'fd12::1', 'fe80::1', '::ffff:192.168.0.2'])('%s private', (ip) => expect(isPrivateAddress(ip)).toBe(true));
  test.each(['8.8.8.8', '172.32.0.1', '100.128.0.1', '2001:4860::8888', '::ffff:8.8.8.8'])('%s public', (ip) => expect(isPrivateAddress(ip)).toBe(false));
});

describe('isLocalEndpoint', () => {
  test('localhost needs no DNS', async () => expect(await isLocalEndpoint('http://localhost:8012', () => { throw new Error('no dns'); })).toBe(true));
  test('*.localhost needs no DNS', async () => expect(await isLocalEndpoint('http://api.localhost:8012', () => { throw new Error('no dns'); })).toBe(true));
  test('IPv4 literal is range-checked', async () => {
    expect(await isLocalEndpoint('http://127.0.0.1:8012', () => { throw new Error('no dns'); })).toBe(true);
    expect(await isLocalEndpoint('http://8.8.8.8', () => { throw new Error('no dns'); })).toBe(false);
  });
  test('IPv6 literal is range-checked', async () => {
    expect(await isLocalEndpoint('http://[::1]:8012', () => { throw new Error('no dns'); })).toBe(true);
    expect(await isLocalEndpoint('http://[2001:4860::8888]:8012', () => { throw new Error('no dns'); })).toBe(false);
  });
  test('hostname resolving to LAN is local', async () => expect(await isLocalEndpoint('http://gpu-box:8000/v1', async () => ['192.168.1.20'])).toBe(true));
  test('mixed resolution is not local', async () => expect(await isLocalEndpoint('http://x', async () => ['192.168.1.2', '8.8.8.8'])).toBe(false));
  test('empty resolution is not local', async () => expect(await isLocalEndpoint('http://x', async () => [])).toBe(false));
  test('dns failure is not local', async () => expect(await isLocalEndpoint('http://nope.invalid', async () => { throw new Error('ENOTFOUND'); })).toBe(false));
  test('invalid url is not local', async () => expect(await isLocalEndpoint('not a url', async () => ['127.0.0.1'])).toBe(false));
  test('codestral is not local', async () => expect(await isLocalEndpoint('https://codestral.mistral.ai', async () => ['104.18.1.1'])).toBe(false));
});

describe('isObviouslyLocal', () => {
  test.each([
    ['http://localhost:8012', true],
    ['http://foo.localhost', true],
    ['http://127.0.0.1:8012', true],
    ['http://192.168.1.5', true],
    ['http://[::1]:80', true],
    ['https://example.com', false],
    ['http://8.8.8.8', false],
    ['http://my-box.lan', false],
    ['not a url', false],
  ])('%s -> %s', (url, want) => {
    expect(isObviouslyLocal(url)).toBe(want);
  });
});
