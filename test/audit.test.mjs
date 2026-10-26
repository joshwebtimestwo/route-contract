import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { audit, validateContract, validateBase } from '../src/audit.mjs';

const contract = routes => ({ version: 1, routes });
const base = 'https://example.test';

test('matches exact, substring and absent headers; cancels bodies', async () => {
  let cancelled = false;
  const report = await audit(contract([{ path: '/', status: 200, headers: { 'X-Test': 'yes', 'cache-control': { includes: 'no-store' }, 'x-absent': null } }]), {
    base, fetch: async (url, options) => {
      assert.equal(url.href, base + '/');
      assert.equal(options.redirect, 'manual');
      assert.equal(options.method, 'GET');
      return { status: 200, headers: new Headers({ 'x-test': 'yes', 'cache-control': 'private, no-store' }), body: { cancel() { cancelled = true; } } };
    },
  });
  assert.equal(report.passed, true);
  assert.equal(cancelled, true);
});

test('reports all mismatches, including missing headers', async () => {
  const report = await audit(contract([{ path: '/', status: 301, headers: { location: '/new', 'x-test': { includes: 'yes' } } }]), { base, fetch: async () => new Response('', { status: 200 }) });
  assert.equal(report.passed, false);
  assert.equal(report.results[0].failures.length, 3);
});

test('continues after a network failure', async () => {
  let calls = 0;
  const report = await audit(contract([{ path: '/one', status: 200 }, { path: '/two', status: 200 }]), { base, fetch: async () => { if (++calls === 1) throw new TypeError('network'); return new Response(''); } });
  assert.equal(report.results[0].error, 'request_failed');
  assert.equal(report.results[1].passed, true);
});

for (const path of ['//evil.test/', '/\\evil.test', '/#fragment', '/bad path', 'https://evil.test', '/\nfoo']) {
  test(`rejects invalid route ${JSON.stringify(path)} before fetching`, async () => {
    let calls = 0;
    await assert.rejects(audit(contract([{ path: '/', status: 200 }, { path, status: 200 }]), { base, fetch: async () => { calls++; } }));
    assert.equal(calls, 0);
  });
}

for (const value of ['file:///tmp/', 'https://user:password@example.test', 'https://example.test/path', 'https://example.test?q=secret', 'https://example.test#x']) {
  test(`rejects invalid base ${value.split(':')[0]}`, () => assert.throws(() => validateBase(value)));
}

test('rejects unknown schema fields and malformed expectations', () => {
  for (const data of [
    { version: 2, routes: [] }, contract([]), contract([{ path: '/', status: '200' }]),
    contract([{ path: '/', status: 200, typo: true }]),
    contract([{ path: '/', status: 200, headers: { 'x-test': { includes: '' } } }]),
    contract([{ path: '/', status: 200, headers: { 'X-Test': 'a', 'x-test': 'b' } }]),
  ]) assert.throws(() => validateContract(data));
});

test('rejects timeout values outside the documented range', async () => {
  for (const timeout of [0, -1, 0.5, NaN, 300001]) await assert.rejects(audit(contract([{ path: '/', status: 200 }]), { base, timeout }));
});

test('unsupported request methods fail before fetching any route', async () => {
  for (const method of ['POST', 'head', '', null, 1]) {
    let calls = 0;
    await assert.rejects(audit(contract([{ path: '/', status: 200 }, { path: '/asset', status: 200, method }]), { base, fetch: async () => { calls++; } }), /method must be GET or HEAD/);
    assert.equal(calls, 0);
  }
});

test('real HTTP: explicit HEAD checks headers and default routes still use GET', async t => {
  const methods = [];
  const server = createServer((req, res) => {
    methods.push(req.method);
    res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': '1000000' });
    if (req.method === 'HEAD') res.end();
    else res.end(Buffer.alloc(1000000));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const report = await audit(contract([
    { path: '/asset', status: 200, method: 'HEAD', headers: { 'content-length': '1000000' } },
    { path: '/asset', status: 200 },
  ]), { base: `http://127.0.0.1:${server.address().port}` });
  assert.equal(report.passed, true);
  assert.deepEqual(methods, ['HEAD', 'GET']);
  assert.deepEqual(report.results.map(result => result.method), ['HEAD', 'GET']);
});

test('real HTTP: inspects redirects, does not follow external targets, handles timeouts', async t => {
  let targetHits = 0;
  const server = createServer((req, res) => {
    if (req.url === '/redirect') { res.writeHead(301, { location: '/target' }); res.end(); }
    else if (req.url === '/external') { res.writeHead(302, { location: 'https://external.invalid/' }); res.end(); }
    else if (req.url === '/slow') { /* closed by test cleanup */ }
    else { targetHits++; res.writeHead(200, { 'x-robots-tag': 'noindex, nofollow' }); res.end('fixture'); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const local = `http://127.0.0.1:${server.address().port}`;
  const report = await audit(contract([
    { path: '/redirect', status: 301, headers: { location: '/target' } },
    { path: '/external', status: 302, headers: { location: 'https://external.invalid/' } },
  ]), { base: local });
  assert.equal(report.passed, true);
  assert.equal(targetHits, 0);
  const slow = await audit(contract([{ path: '/slow', status: 200 }]), { base: local, timeout: 25 });
  assert.equal(slow.results[0].error, 'timeout');
});

test('CLI: help, invalid options and exit codes with real responses', async t => {
  const folder = await mkdtemp(join(tmpdir(), 'route-contract-test-'));
  t.after(() => rm(folder, { recursive: true, force: true }));
  const file = join(folder, 'contract.json');
  const server = createServer((req, res) => { res.writeHead(200); res.end('ok'); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const local = `http://127.0.0.1:${server.address().port}`;
  const cli = fileURLToPath(new URL('../bin/route-contract.mjs', import.meta.url));
  const run = args => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, ...args]);
    let out = '', err = '';
    child.stdout.on('data', data => { out += data; });
    child.stderr.on('data', data => { err += data; });
    child.on('error', reject);
    child.on('close', code => resolve({ code, out, err }));
  });
  assert.match((await run(['--help'])).out, /Usage:/);
  assert.equal((await run(['--unknown'])).code, 2);
  await writeFile(file, JSON.stringify(contract([{ path: '/', status: 200 }])));
  const good = await run([file, '--base', local, '--json']);
  assert.equal(good.code, 0, good.err);
  assert.equal(JSON.parse(good.out).passed, true);
  await writeFile(file, JSON.stringify(contract([{ path: '/', status: 404 }])));
  assert.equal((await run([file, '--base', local])).code, 1);
  await writeFile(file, '{bad');
  assert.equal((await run([file, '--base', local])).code, 2);
});
