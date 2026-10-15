import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import https from 'node:https';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const infra = path.dirname(fileURLToPath(import.meta.url));
const project = path.dirname(infra);
const nginxImage = 'nginx:1.18.0';
const nodeImage = 'node:22-alpine';
const objectPath = '/content-files/aerocrm/android/1.0.0/aeroCRM.apk';
const objectBytes = Buffer.from('synthetic-aeroCRM-apk-object-v1\n');
const objectSha = crypto.createHash('sha256').update(objectBytes).digest('hex');
const run = (command, args, options = {}) => spawnSync(command, args, {
  encoding: 'utf8', maxBuffer: 2 * 1024 * 1024, ...options,
});

function docker(args, options = {}) {
  const result = run('docker', args, options);
  if (result.status !== 0) {
    throw new Error(`docker ${args.join(' ')} failed: ${result.stderr || result.stdout || result.error}`);
  }
  return result.stdout.trim();
}

function command(commandName, args) {
  const result = run(commandName, args);
  assert.equal(result.status, 0, `${commandName} ${args.join(' ')} failed: ${result.stderr || result.stdout}`);
  return result.stdout.trim();
}

function createCertificates(directory) {
  const tlsDir = path.join(directory, 'tls');
  fs.mkdirSync(tlsDir);
  const san = 'subjectAltName=DNS:aerocrm.space,DNS:workspace.aerocrm.space,DNS:admin.aerocrm.space,DNS:www.aerocrm.space,DNS:s3.twcstorage.ru\nextendedKeyUsage=serverAuth\nbasicConstraints=CA:FALSE\n';
  fs.writeFileSync(path.join(tlsDir, 'server.ext'), san);
  fs.writeFileSync(path.join(tlsDir, 'wrong.ext'), 'subjectAltName=DNS:untrusted.invalid\nextendedKeyUsage=serverAuth\nbasicConstraints=CA:FALSE\n');
  command('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', path.join(tlsDir, 'ca.key'),
    '-out', path.join(tlsDir, 'ca.crt'), '-subj', '/CN=aeroCRM synthetic test CA', '-days', '2']);
  command('openssl', ['req', '-newkey', 'rsa:2048', '-nodes', '-keyout', path.join(tlsDir, 'server.key'),
    '-out', path.join(tlsDir, 'server.csr'), '-subj', '/CN=aerocrm.space']);
  command('openssl', ['x509', '-req', '-in', path.join(tlsDir, 'server.csr'), '-CA', path.join(tlsDir, 'ca.crt'),
    '-CAkey', path.join(tlsDir, 'ca.key'), '-CAcreateserial', '-out', path.join(tlsDir, 'server.crt'),
    '-days', '2', '-extfile', path.join(tlsDir, 'server.ext')]);
  command('openssl', ['req', '-newkey', 'rsa:2048', '-nodes', '-keyout', path.join(tlsDir, 'wrong.key'),
    '-out', path.join(tlsDir, 'wrong.csr'), '-subj', '/CN=untrusted.invalid']);
  command('openssl', ['x509', '-req', '-in', path.join(tlsDir, 'wrong.csr'), '-signkey', path.join(tlsDir, 'wrong.key'),
    '-out', path.join(tlsDir, 'wrong.crt'), '-days', '2', '-extfile', path.join(tlsDir, 'wrong.ext')]);
  return tlsDir;
}

function writeSyntheticService(directory) {
  fs.writeFileSync(path.join(directory, 'synthetic.mjs'), String.raw`
import dgram from 'node:dgram';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import os from 'node:os';
import tls from 'node:tls';

const tlsDir = '/fixture/tls';
const valid = tls.createSecureContext({ key: fs.readFileSync(tlsDir + '/server.key'), cert: fs.readFileSync(tlsDir + '/server.crt') });
const wrong = tls.createSecureContext({ key: fs.readFileSync(tlsDir + '/wrong.key'), cert: fs.readFileSync(tlsDir + '/wrong.crt') });
let dnsMode = process.env.INITIAL_DNS_MODE || 'nxdomain';
let originMode = 'valid';
const dnsQueries = [];
const originRequests = [];
const tlsSni = [];
const ip = Object.values(os.networkInterfaces()).flat().find(row => row && row.family === 'IPv4' && !row.internal)?.address;
if (!ip) throw new Error('Synthetic service could not locate its Docker network IP');
const dns = dgram.createSocket('udp4');
dns.on('message', (query, remote) => {
  let offset = 12;
  const labels = [];
  while (query[offset] && offset < query.length) {
    const size = query[offset++];
    labels.push(query.subarray(offset, offset + size).toString('ascii'));
    offset += size;
  }
  offset++;
  const type = query.readUInt16BE(offset);
  const name = labels.join('.').toLowerCase();
  dnsQueries.push({ name, type, mode: dnsMode });
  if (dnsMode === 'timeout' || type !== 1 || name !== 's3.twcstorage.ru') return;
  const question = query.subarray(12, offset + 4);
  const answer = dnsMode === 'good' ? Buffer.alloc(16) : Buffer.alloc(0);
  const response = Buffer.alloc(12 + question.length + answer.length);
  query.copy(response, 0, 0, 2);
  response.writeUInt16BE(dnsMode === 'good' ? 0x8180 : 0x8183, 2);
  response.writeUInt16BE(1, 4);
  response.writeUInt16BE(dnsMode === 'good' ? 1 : 0, 6);
  question.copy(response, 12);
  if (dnsMode === 'good') {
    let cursor = 12 + question.length;
    response.writeUInt16BE(0xc00c, cursor); cursor += 2;
    response.writeUInt16BE(1, cursor); cursor += 2;
    response.writeUInt16BE(1, cursor); cursor += 2;
    response.writeUInt32BE(1, cursor); cursor += 4;
    response.writeUInt16BE(4, cursor); cursor += 2;
    ip.split('.').forEach(part => { response[cursor++] = Number(part); });
  }
  dns.send(response, remote.port, remote.address);
});
dns.bind(53, '0.0.0.0');

http.createServer((req, res) => {
  const url = new URL(req.url, 'http://synthetic.invalid');
  if (url.pathname === '/dns') dnsMode = url.searchParams.get('mode');
  if (url.pathname === '/origin') originMode = url.searchParams.get('mode');
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ dnsMode, originMode, dnsQueries, originRequests, tlsSni }));
}).listen(8080, '0.0.0.0');

const origin = https.createServer({
  key: fs.readFileSync(tlsDir + '/server.key'),
  cert: fs.readFileSync(tlsDir + '/server.crt'),
  SNICallback(servername, callback) {
    tlsSni.push(servername);
    callback(null, originMode === 'wrong-cert' ? wrong : valid);
  },
}, (req, res) => {
  const chunks = [];
  req.on('data', chunk => chunks.push(chunk));
  req.on('end', () => {
    const body = Buffer.concat(chunks);
    originRequests.push({ method: req.method, url: req.url, headers: req.headers, bodyBytes: body.length });
    if (originMode === 'redirect') {
      res.writeHead(302, { location: 'https://redirect-target.invalid/collect', 'set-cookie': 'origin=private',
        'cache-control': 'private', 'content-disposition': 'attachment; filename=origin.apk' });
      return res.end();
    }
    if (req.url !== '/content-files/aerocrm/android/1.0.0/aeroCRM.apk') {
      res.writeHead(404); return res.end();
    }
    if (req.method === 'HEAD') {
      res.writeHead(200, responseHeaders({ 'content-length': String(objectLength) }));
      return res.end();
    }
    const range = req.headers.range;
    const ifRange = req.headers['if-range'];
    if (range?.startsWith('bytes=')) {
      const [startText, endText] = range.slice(6).split('-');
      const start = Number(startText); const end = Math.min(Number(endText || objectLength - 1), objectLength - 1);
      const part = objectBytes.subarray(start, end + 1);
      res.writeHead(206, responseHeaders({ 'content-length': String(part.length),
        'content-range': 'bytes ' + start + '-' + end + '/' + objectLength, 'accept-ranges': 'bytes', etag }));
      return res.end(part);
    }
    res.writeHead(200, responseHeaders({ 'content-length': String(objectLength), 'accept-ranges': 'bytes', etag }));
    res.end(objectBytes);
  });
});
const objectBytes = Buffer.from('synthetic-aeroCRM-apk-object-v1\n');
const objectLength = objectBytes.length;
const etag = '"' + objectLength + '"';
function responseHeaders(extra) {
  return { 'content-type': 'application/vnd.android.package-archive', 'set-cookie': 'origin=private',
    'cache-control': 'private', 'content-disposition': 'attachment; filename=origin.apk', ...extra };
}
origin.listen(443, '0.0.0.0');

for (const [port, app] of [[3100, 'landing'], [3200, 'crm'], [3300, 'admin-panel']]) {
  http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ application: app, path: req.url, status: 'ok' }));
  }).listen(port, '0.0.0.0');
}
`);
}

function configureNginx(directory, resolverIp) {
  let config = fs.readFileSync(path.join(project, 'nginx', 'frontends.conf'), 'utf8');
  const fixedUpstream = 'set $aerocrm_apk_upstream https://s3.twcstorage.ru/content-files/aerocrm/android/1.0.0/aeroCRM.apk;';
  assert(config.includes(fixedUpstream), 'production fixture must use the fixed versioned APK URL');
  assert(config.includes('proxy_pass $aerocrm_apk_upstream;'), 'APK proxy must use the variable upstream');
  assert.match(config, /resolver 127\.0\.0\.53 valid=30s ipv6=off;/);
  assert(config.includes('resolver_timeout 5s;'));
  assert(config.includes('proxy_ssl_verify on;'));
  assert(config.includes('proxy_ssl_server_name on;'));
  assert(config.includes('proxy_ssl_name s3.twcstorage.ru;'));

  config = config.replaceAll('resolver 127.0.0.53', `resolver ${resolverIp}`)
    .replaceAll('/etc/letsencrypt/live/aerocrm.space/fullchain.pem', '/fixture/tls/server.crt')
    .replaceAll('/etc/letsencrypt/live/aerocrm.space/privkey.pem', '/fixture/tls/server.key')
    .replaceAll('/etc/ssl/certs/ca-certificates.crt', '/fixture/tls/ca.crt')
    .replaceAll('127.0.0.1:3100', 'synthetic:3100')
    .replaceAll('127.0.0.1:3200', 'synthetic:3200')
    .replaceAll('127.0.0.1:3300', 'synthetic:3300');
  const configFile = path.join(directory, 'default.conf');
  fs.writeFileSync(configFile, config);
  return configFile;
}

async function waitFor(assertion, { timeout = 15_000, interval = 250 } = {}) {
  const end = Date.now() + timeout;
  let lastError;
  while (Date.now() < end) {
    try { return await assertion(); } catch (error) { lastError = error; }
    await new Promise(resolve => setTimeout(resolve, interval));
  }
  throw lastError || new Error('Timed out waiting for condition');
}

function requestTls({ port, host, path: requestPath = '/', method = 'GET', headers = {}, ca, timeout = 7000 }) {
  return new Promise((resolve, reject) => {
    const request = https.request({ host: '127.0.0.1', port, servername: host,
      path: requestPath, method, headers: { host, ...headers }, ca, rejectUnauthorized: true, timeout }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers,
        body: Buffer.concat(chunks), elapsedMs: Date.now() - started }));
    });
    const started = Date.now();
    request.on('timeout', () => request.destroy(new Error(`HTTPS request timed out after ${timeout}ms`)));
    request.on('error', reject);
    request.end();
  });
}

function publishedPort(container, port) {
  const value = docker(['port', container, `${port}/tcp`]).split('\n')[0];
  const match = value.match(/:(\d+)$/);
  assert(match, `Could not parse published port ${value}`);
  return Number(match[1]);
}

async function control(port, endpoint) {
  const response = await fetch(`http://127.0.0.1:${port}${endpoint}`);
  assert.equal(response.status, 200);
  return response.json();
}

function workerPids(container) {
  const script = [
    'for file in /proc/[0-9]*/cmdline; do',
    '  pid=$(echo "$file" | cut -d/ -f3)',
    '  cmd=$(tr "\\000" " " < "$file" 2>/dev/null || true)',
    '  case "$cmd" in "nginx: worker process"*) echo "$pid" ;; esac',
    'done | sort -n',
  ].join('\n');
  return docker(['exec', container, 'sh', '-c', script]).split('\n').filter(Boolean);
}

function nginxLogs(container) {
  const result = run('docker', ['logs', container]);
  return `${result.stdout || ''}${result.stderr || ''}`;
}

test('Nginx 1.18 cold-starts without S3 DNS and recovers fixed APK requests after DNS returns', { timeout: 240_000 }, async t => {
  const available = run('docker', ['info', '--format', '{{.ServerVersion}}']);
  if (available.status !== 0) {
    if (process.env.AEROCRM_REQUIRE_DOCKER === '1') assert.fail(`Docker daemon required: ${available.stderr}`);
    t.skip(`Docker daemon unavailable: ${available.stderr.trim()}`);
    return;
  }
  const directory = fs.mkdtempSync(path.join(infra, '.nginx-s3-dns-test-'));
  const token = `${process.pid}-${crypto.randomBytes(5).toString('hex')}`;
  const network = `aerocrm-s3-dns-${token}`;
  const containers = [];
  let tlsDir;
  try {
    for (const image of [nginxImage, nodeImage]) {
      if (run('docker', ['image', 'inspect', image]).status !== 0) docker(['pull', image]);
    }
    const nginxVersionResult = run('docker', ['run', '--rm', nginxImage, 'nginx', '-v']);
    assert.equal(nginxVersionResult.status, 0, nginxVersionResult.stderr || nginxVersionResult.stdout);
    const nginxVersion = `${nginxVersionResult.stdout}${nginxVersionResult.stderr}`;
    assert.match(nginxVersion, /nginx\/1\.18\./, `Expected real Nginx 1.18, got ${nginxVersion}`);
    tlsDir = createCertificates(directory);
    writeSyntheticService(directory);
    docker(['network', 'create', network]);

    const syntheticName = `aerocrm-synthetic-${token}`;
    containers.push(syntheticName);
    docker(['run', '-d', '--name', syntheticName, '--network', network, '--network-alias', 'synthetic',
      '-p', '127.0.0.1::8080', nodeImage, 'node', '-e', 'setInterval(() => {}, 1 << 30)']);
    docker(['exec', syntheticName, 'mkdir', '-p', '/fixture/tls']);
    docker(['cp', path.join(directory, 'synthetic.mjs'), `${syntheticName}:/fixture/synthetic.mjs`]);
    docker(['cp', `${tlsDir}/.`, `${syntheticName}:/fixture/tls/`]);
    docker(['exec', '-d', syntheticName, 'node', '/fixture/synthetic.mjs']);
    const syntheticIp = docker(['inspect', '-f', `{{with index .NetworkSettings.Networks "${network}"}}{{.IPAddress}}{{end}}`, syntheticName]);
    assert.match(syntheticIp, /^\d+\.\d+\.\d+\.\d+$/);
    const adminPort = publishedPort(syntheticName, 8080);
    await waitFor(() => control(adminPort, '/state'));
    const ca = fs.readFileSync(path.join(tlsDir, 'ca.crt'));
    const configFile = configureNginx(directory, syntheticIp);

    const startNginx = async label => {
      const name = `aerocrm-nginx-${label}-${token}`;
      containers.push(name);
      docker(['run', '-d', '--name', name, '--network', network, '--dns', syntheticIp,
        '-p', '127.0.0.1::443', nginxImage, 'sh', '-c', 'sleep infinity']);
      docker(['exec', name, 'mkdir', '-p', '/etc/nginx/conf.d', '/fixture/tls']);
      docker(['cp', configFile, `${name}:/etc/nginx/conf.d/default.conf`]);
      docker(['cp', `${tlsDir}/.`, `${name}:/fixture/tls/`]);
      const dnsBefore = (await control(adminPort, '/state')).dnsQueries.length;
      docker(['exec', name, 'nginx', '-t']);
      docker(['exec', '-d', name, 'sh', '-c', 'nginx -g "daemon off;" >/tmp/nginx-fixture.log 2>&1']);
      const port = publishedPort(name, 443);
      await waitFor(async () => {
        const inspect = JSON.parse(docker(['inspect', '-f', '{{json .State}}', name]));
        assert.equal(inspect.Running, true, `${label} Nginx exited: ${nginxLogs(name)}`);
        const health = await requestTls({ port, host: 'aerocrm.space', path: '/__fixture_wait__', ca });
        assert.equal(health.status, 200);
      });
      docker(['exec', name, 'nginx', '-t']);
      const dns = await control(adminPort, '/state');
      assert.equal(dns.dnsQueries.length, dnsBefore, 'Nginx performed DNS lookups while loading its config');
      return { name, port, pid: docker(['exec', name, 'sh', '-c', 'cat /run/nginx.pid']).trim() };
    };

    await control(adminPort, '/dns?mode=nxdomain');
    const nxdomain = await startNginx('nxdomain');
    const healthHosts = ['aerocrm.space', 'workspace.aerocrm.space', 'admin.aerocrm.space'];
    for (const host of healthHosts) {
      const health = await requestTls({ port: nxdomain.port, host, path: '/__frontend/health', ca });
      assert.equal(health.status, 200, `${host} failed while S3 DNS returned NXDOMAIN`);
      assert.match(health.body.toString(), /"status":"ok"/);
    }
    const nxStart = Date.now();
    const nxResponse = await requestTls({ port: nxdomain.port, host: 'aerocrm.space', path: '/downloads/aeroCRM.apk', ca });
    assert([502, 504].includes(nxResponse.status), `NXDOMAIN should be a bounded gateway error, got ${nxResponse.status}`);
    assert(nxResponse.elapsedMs < 8000, `NXDOMAIN APK error exceeded bound: ${nxResponse.elapsedMs}ms`);
    assert(Date.now() - nxStart < 8000);

    await control(adminPort, '/dns?mode=good');
    const workerBaseline = workerPids(nxdomain.name);
    assert(workerBaseline.length > 0, 'Expected Nginx worker processes before DNS recovery');
    const recovered = await waitFor(async () => {
      const response = await requestTls({ port: nxdomain.port, host: 'aerocrm.space', path: '/downloads/aeroCRM.apk', ca });
      assert.equal(response.status, 200);
      return response;
    }, { timeout: 40_000, interval: 1000 });
    assert.equal(recovered.body.byteLength, objectBytes.byteLength);
    assert.equal(crypto.createHash('sha256').update(recovered.body).digest('hex'), objectSha);
    assert.equal(await dockerExecText(nxdomain.name, 'cat', '/run/nginx.pid'), nxdomain.pid, 'Nginx master changed during recovery');
    assert.deepEqual(workerPids(nxdomain.name), workerBaseline, 'Nginx workers changed during DNS recovery');

    const credentialProbe = await requestTls({ port: nxdomain.port, host: 'aerocrm.space', path: '/downloads/aeroCRM.apk', ca,
      headers: { authorization: 'Bearer synthetic-secret', cookie: 'session=synthetic-secret', 'x-private-marker': 'must-not-forward' } });
    assert.equal(credentialProbe.status, 200);
    assert.equal(credentialProbe.headers['set-cookie'], undefined);
    assert.equal(credentialProbe.headers['cache-control'], 'no-store');
    assert.equal(credentialProbe.headers['content-disposition'], 'attachment; filename="aeroCRM.apk"');
    const head = await requestTls({ port: nxdomain.port, host: 'aerocrm.space', path: '/downloads/aeroCRM.apk', method: 'HEAD', ca });
    assert.equal(head.status, 200);
    assert.equal(Number(head.headers['content-length']), objectBytes.byteLength);
    const range = await requestTls({ port: nxdomain.port, host: 'aerocrm.space', path: '/downloads/aeroCRM.apk', ca,
      headers: { range: 'bytes=2-7', 'if-range': '"' + objectBytes.byteLength + '"' } });
    assert.equal(range.status, 206);
    assert.equal(range.headers['content-range'], `bytes 2-7/${objectBytes.byteLength}`);
    assert.deepEqual(range.body, objectBytes.subarray(2, 8));
    assert.equal(range.headers['set-cookie'], undefined);
    assert.equal(range.headers['cache-control'], 'no-store');
    assert.equal(range.headers['content-disposition'], 'attachment; filename="aeroCRM.apk"');

    let state = await control(adminPort, '/state');
    const originRows = state.originRequests;
    assert(originRows.length >= 4);
    for (const row of originRows) {
      assert.equal(row.url, objectPath, `Unexpected upstream URI: ${row.url}`);
      assert.equal(row.headers.host, 's3.twcstorage.ru');
      assert.equal(row.headers.authorization, undefined);
      assert.equal(row.headers.cookie, undefined);
      assert.equal(row.headers['x-private-marker'], undefined);
      assert.equal(row.bodyBytes, 0);
    }
    assert(originRows.some(row => row.method === 'HEAD'));
    assert(originRows.some(row => row.headers.range === 'bytes=2-7' && row.headers['if-range'] === `"${objectBytes.byteLength}"`));
    assert(state.tlsSni.includes('s3.twcstorage.ru'), 'S3 request did not use the configured TLS SNI');

    const dnsBeforeRejected = state.dnsQueries.length;
    const originBeforeRejected = state.originRequests.length;
    const post = await requestTls({ port: nxdomain.port, host: 'aerocrm.space', path: '/downloads/aeroCRM.apk', method: 'POST', ca });
    assert.equal(post.status, 405);
    const query = await requestTls({ port: nxdomain.port, host: 'aerocrm.space', path: '/downloads/aeroCRM.apk?download=1', ca });
    assert.equal(query.status, 400);
    state = await control(adminPort, '/state');
    assert.equal(state.dnsQueries.length, dnsBeforeRejected, 'Rejected method/query triggered S3 DNS');
    assert.equal(state.originRequests.length, originBeforeRejected, 'Rejected method/query reached S3');

    await control(adminPort, '/origin?mode=redirect');
    const redirect = await requestTls({ port: nxdomain.port, host: 'aerocrm.space', path: '/downloads/aeroCRM.apk', ca });
    assert.equal(redirect.status, 502);
    assert.equal(redirect.headers.location, undefined);
    await control(adminPort, '/origin?mode=wrong-cert');
    const wrongCert = await requestTls({ port: nxdomain.port, host: 'aerocrm.space', path: '/downloads/aeroCRM.apk', ca });
    assert.equal(wrongCert.status, 502, 'Untrusted S3 TLS certificate was not rejected');
    await control(adminPort, '/origin?mode=valid');
    const afterTlsRestore = await requestTls({ port: nxdomain.port, host: 'aerocrm.space', path: '/downloads/aeroCRM.apk', ca });
    assert.equal(afterTlsRestore.status, 200, 'TLS recovery required an Nginx reload or disabled verification');

    await control(adminPort, '/dns?mode=timeout');
    const timeoutCold = await startNginx('timeout');
    const timeoutWorkers = workerPids(timeoutCold.name);
    assert(timeoutWorkers.length > 0 && timeoutWorkers.every(pid => /^\d+$/.test(pid)), 'Expected numeric worker PIDs');
    for (const host of healthHosts) {
      const health = await requestTls({ port: timeoutCold.port, host, path: '/__frontend/health', ca });
      assert.equal(health.status, 200, `${host} failed during timeout-mode cold start`);
    }
    const coldTimeoutStarted = Date.now();
    const coldTimeout = await requestTls({ port: timeoutCold.port, host: 'aerocrm.space', path: '/downloads/aeroCRM.apk', ca, timeout: 9000 });
    assert([502, 504].includes(coldTimeout.status));
    const coldTimeoutElapsed = Date.now() - coldTimeoutStarted;
    assert(coldTimeoutElapsed >= 4000, `Silent DNS fixture unexpectedly returned early (${coldTimeoutElapsed}ms)`);
    assert(coldTimeoutElapsed < 8000, 'Cold-start timeout exceeded the resolver bound');
    let timeoutState = await control(adminPort, '/state');
    assert(timeoutState.dnsQueries.some(query => query.name === 's3.twcstorage.ru' && query.mode === 'timeout'),
      'Nginx never queried the silent DNS fixture for S3');
    const timeoutPid = timeoutCold.pid;
    await control(adminPort, '/dns?mode=good');
    const timeoutRecovery = await waitFor(async () => {
      const response = await requestTls({ port: timeoutCold.port, host: 'aerocrm.space', path: '/downloads/aeroCRM.apk', ca });
      assert.equal(response.status, 200);
      return response;
    }, { timeout: 12_000, interval: 500 });
    assert.deepEqual(timeoutRecovery.body, objectBytes);
    assert.equal(await dockerExecText(timeoutCold.name, 'cat', '/run/nginx.pid'), timeoutPid);
    assert.deepEqual(workerPids(timeoutCold.name), timeoutWorkers, 'Timeout recovery changed Nginx workers');
  } catch (error) {
    for (const name of containers) {
      const logs = run('docker', ['logs', name]);
      if (logs.status === 0 && (logs.stdout || logs.stderr)) error.message += `\n--- ${name} logs ---\n${logs.stdout || ''}${logs.stderr || ''}`;
      const processLog = run('docker', ['exec', name, 'cat', '/tmp/nginx-fixture.log']);
      if (processLog.status === 0 && processLog.stdout) error.message += `\n--- ${name} nginx ---\n${processLog.stdout}`;
    }
    throw error;
  } finally {
    for (const name of [...containers].reverse()) run('docker', ['rm', '-f', name]);
    run('docker', ['network', 'rm', network]);
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

async function dockerExecText(container, ...args) {
  return docker(['exec', container, ...args]);
}
