import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { parseEnv } from 'node:util';
import { fileURLToPath } from 'node:url';
import { environmentHash } from './backend-chat-env.mjs';
import { assertScopedS3Principals } from './backend-s3-principals.mjs';

export const riskControlsFields = Object.freeze({ MARKETING_EMAIL_ENABLED: 'true', MARKETING_PUBLIC_ORIGIN: 'https://aerocrm.space' });
export const riskControlsMarketingRoles = ['identity-api.env', 'notification-delivery-worker.env'];
export const riskControlsRoles = [...riskControlsMarketingRoles, 'api-gateway.env'];
export const riskControlsRoutes = [
  { id: 'identity-marketing-unsubscribe', pathPrefix: '/api/v1/marketing/email/unsubscribe', upstreamUrl: 'http://127.0.0.1:4900', authPolicy: 'optional', timeoutMs: 15000 },
  { id: 'billing-crm-refunds', pathPrefix: '/api/v1/payments/admin/crm-refunds', upstreamUrl: 'http://127.0.0.1:4800', authPolicy: 'required', timeoutMs: 60000 }
];
export function riskControlsGatewayRoutes(existing) {
  assert(Array.isArray(existing) && existing.every(route => route && typeof route === 'object' && !Array.isArray(route)));
  assert(new Set(existing.map(route => route.id)).size === existing.length, 'Duplicate gateway route ID');
  const result = existing.slice();
  for (const route of riskControlsRoutes) {
    const matches = existing.filter(value => value.id === route.id || value.pathPrefix === route.pathPrefix);
    assert(matches.length <= 1, 'Ambiguous risk controls route');
    if (matches.length) assert.deepEqual(matches[0], route, 'Risk controls route collision/drift');
    else result.push(route);
  }
  return result;
}
export const campaignsMigrationEnvSha256 = 'a16a70456ddb96257dba7ae299de4b8b8d2c64acf7372439749f82c3d5d8a80e';
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
export function validateCampaignsMigrationEnv(bytes, expectedHash = campaignsMigrationEnvSha256) {
  assert(Buffer.isBuffer(bytes) && /^[a-f0-9]{64}$/.test(expectedHash) && digest(bytes) === expectedHash,
    'Campaigns migration env bytes differ from approved credential');
  const values = parseEnv(bytes.toString('utf8'));
  assert.deepEqual(Object.keys(values).sort(), ['CAMPAIGNS_DATABASE_URL', 'NODE_ENV']);
  assert.equal(values.NODE_ENV, 'production');
  const url = new URL(values.CAMPAIGNS_DATABASE_URL);
  assert(url.protocol === 'postgresql:' && url.hostname === '127.0.0.1' && (!url.port || url.port === '5432') &&
    url.pathname === '/aerocrm_campaigns' && decodeURIComponent(url.username) === 'aerocrm_campaigns_migration' &&
    url.password && !url.hash && [...url.searchParams].length === 4 &&
    Object.entries({schema:'campaigns',connection_limit:'1',pool_timeout:'10',connect_timeout:'10'}).every(([key,value]) =>
      url.searchParams.getAll(key).length === 1 && url.searchParams.get(key) === value), 'Campaigns migration credential scope differs');
  return { values, password: decodeURIComponent(url.password) };
}
export function proveCampaignsMigrationIdentity({ password }) {
  let output;
  try {
    output = execFileSync('docker', ['run','--rm','--network','host','--env','PGPASSWORD','--env','PGOPTIONS',
      '--entrypoint','psql','postgres:18','-XqAt','-v','ON_ERROR_STOP=1','-h','127.0.0.1','-p','5432',
      '-U','aerocrm_campaigns_migration','-d','aerocrm_campaigns','-c',
      `SELECT json_build_object('currentRole',current_user,'sessionRole',session_user,'database',current_database(),
        'schemaOwner',(SELECT pg_get_userbyid(nspowner) FROM pg_namespace WHERE nspname='campaigns'),
        'unprivileged',(SELECT NOT(rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls OR rolinherit)
          AND NOT EXISTS(SELECT 1 FROM pg_auth_members WHERE member=pg_roles.oid) FROM pg_roles WHERE rolname=current_user),
        'readOnly',current_setting('transaction_read_only'))::text;`],
    { env: {...process.env,PGPASSWORD:password,PGOPTIONS:'-c default_transaction_read_only=on -c statement_timeout=10000 -c lock_timeout=5000'},
      encoding:'utf8',stdio:['ignore','pipe','pipe'],timeout:60000,maxBuffer:65536 }).trim();
  } catch { throw new Error('Scoped Campaigns migration login failed; private details withheld'); }
  assert.deepEqual(JSON.parse(output), {currentRole:'aerocrm_campaigns_migration',sessionRole:'aerocrm_campaigns_migration',
    database:'aerocrm_campaigns',schemaOwner:'aerocrm_campaigns_migration',unprivileged:true,readOnly:'on'});
}
export function installCampaignsMigrationEnv({ sourceFile, targetFile, prove = proveCampaignsMigrationIdentity,
  expectedHash = campaignsMigrationEnvSha256 }) {
  const bytes = privateBytes(sourceFile), identity = validateCampaignsMigrationEnv(bytes, expectedHash);
  const parent = path.dirname(targetFile), directory = fs.lstatSync(parent);
  assert(directory.isDirectory() && !directory.isSymbolicLink() && fs.realpathSync(parent) === parent);
  prove(identity);
  if (fs.existsSync(targetFile) || fs.lstatSync(targetFile, {throwIfNoEntry:false})) {
    assert.equal(digest(privateBytes(targetFile)), expectedHash, 'Existing Campaigns env differs; never overwrite or rotate');
    return { installed:false, sha256:expectedHash };
  }
  const temporary = path.join(parent, `.campaigns-env-${randomUUID()}`);
  try {
    fs.writeFileSync(temporary, bytes, {mode:0o600,flag:'wx'});
    const fd=fs.openSync(temporary,'r');try{fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
    fs.linkSync(temporary,targetFile); // Atomic create-only; a concurrent existing file always fails closed.
    const directoryFd=fs.openSync(parent,'r');try{fs.fsyncSync(directoryFd);}finally{fs.closeSync(directoryFd);}
  } finally { fs.rmSync(temporary,{force:true}); }
  return { installed:true, sha256:expectedHash };
}
function privateBytes(file) {
  const stat = fs.lstatSync(file);
  assert(stat.isFile() && !stat.isSymbolicLink() && (stat.mode & 0o777) === 0o600 && stat.uid === process.getuid() &&
    fs.realpathSync(file) === file, 'Risk controls require canonical private regular env files');
  return fs.readFileSync(file);
}
export function riskControlsEnvironmentCandidate({ sourceDirectory }) {
  const stat = fs.lstatSync(sourceDirectory);
  assert(stat.isDirectory() && !stat.isSymbolicLink() && fs.realpathSync(sourceDirectory) === sourceDirectory);
  const source = new Map(fs.readdirSync(sourceDirectory).filter(name => name.endsWith('.env')).sort()
    .map(name => [name, privateBytes(path.join(sourceDirectory, name))]));
  const parsed = new Map([...source].map(([name, bytes]) => [name, parseEnv(bytes.toString('utf8'))]));
  for (const values of parsed.values()) assertScopedS3Principals(values);
  assert(riskControlsRoles.every(name => source.has(name)), 'Marketing and Gateway env roles are required');
  const tokens = riskControlsMarketingRoles.map(name => parsed.get(name).IDENTITY_NOTIFICATION_DELIVERY_TOKEN);
  assert(tokens[0] && tokens[0] === tokens[1] && tokens[0].length >= 32 && tokens[0].length <= 4096 &&
    !/[\s\x00-\x1f\x7f]/.test(tokens[0]) && !/^(?:change|replace|example|placeholder|ci_)/i.test(tokens[0]),
  'Preserved Identity and Notification Delivery token pair differs');
  const candidate = new Map(source);
  for (const name of riskControlsMarketingRoles) {
    const original = source.get(name).toString('utf8');
    assert(Buffer.from(original).equals(source.get(name)), 'Marketing environment must be UTF-8');
    assert(!Object.keys(parsed.get(name)).some(key => /ONE_CLICK|ONECLICK/.test(key)),
      'RFC8058 activation is outside this reviewed release');
    const seen = new Set();
    let text = (original.match(/[^\n]*\n|[^\n]+$/g) || []).map(line => {
      const match = /^(?:export[ \t]+)?([A-Z][A-Z0-9_]*)[ \t]*=/.exec(line);
      if (!match || !Object.hasOwn(riskControlsFields, match[1])) return line;
      assert(!seen.has(match[1]), 'Duplicate marketing env field');
      seen.add(match[1]);
      return `${match[1]}='${riskControlsFields[match[1]]}'${line.endsWith('\r\n') ? '\r\n' : line.endsWith('\n') ? '\n' : ''}`;
    }).join('');
    for (const [key, value] of Object.entries(riskControlsFields)) if (!seen.has(key))
      text += `${text && !text.endsWith('\n') ? '\n' : ''}${key}='${value}'\n`;
    const next = parseEnv(text);
    assert.deepEqual(next, { ...parsed.get(name), ...riskControlsFields }, 'Marketing delta modified unrelated values');
    candidate.set(name, Buffer.from(text));
  }
  const gatewayName = 'api-gateway.env';
  const original = source.get(gatewayName).toString('utf8');
  assert(Buffer.from(original).equals(source.get(gatewayName)), 'Gateway environment must be UTF-8');
  const currentGateway = parsed.get(gatewayName);
  const nextRoutes = JSON.stringify(riskControlsGatewayRoutes(JSON.parse(currentGateway.GATEWAY_ROUTES_JSON)));
  assert(!/['\r\n\0]/.test(nextRoutes), 'Gateway routes require safe env representation');
  let seenRoutes = false;
  const text = (original.match(/[^\n]*\n|[^\n]+$/g) || []).map(line => {
    if (!/^(?:export[ \t]+)?GATEWAY_ROUTES_JSON[ \t]*=/.test(line)) return line;
    assert(!seenRoutes, 'Duplicate gateway route environment field');
    seenRoutes = true;
    return `GATEWAY_ROUTES_JSON='${nextRoutes}'${line.endsWith('\r\n') ? '\r\n' : line.endsWith('\n') ? '\n' : ''}`;
  }).join('');
  assert(seenRoutes, 'Existing gateway route contract is required');
  assert.deepEqual(parseEnv(text), { ...currentGateway, GATEWAY_ROUTES_JSON: nextRoutes });
  candidate.set(gatewayName, Buffer.from(text));
  return { source, candidate };
}
export function stageRiskControlsEnvironment(options) {
  const { candidate } = riskControlsEnvironmentCandidate(options);
  fs.mkdirSync(options.candidateDirectory, { mode: 0o700 });
  try {
    for (const [name, bytes] of candidate)
      fs.writeFileSync(path.join(options.candidateDirectory, name), bytes, { mode: 0o600, flag: 'wx' });
    return options.candidateDirectory;
  } catch (error) { fs.rmSync(options.candidateDirectory, { recursive: true, force: true }); throw error; }
}
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  try {
    assert.equal(process.argv.length, 4);
    const [mode, file] = process.argv.slice(2);
    if (mode === '--stage-campaigns-env') {
      assert.equal(process.env.GITHUB_ACTIONS, 'true');
      const secret = process.env.CRM_RISK_CAMPAIGNS_MIGRATION_ENV || '';
      const bytes = Buffer.from(secret.endsWith('\n') ? secret : secret + '\n');
      validateCampaignsMigrationEnv(bytes);
      fs.writeFileSync(file, bytes, {mode:0o600,flag:'wx'});
      console.log('Reviewed scoped Campaigns migration env staged; values withheld');
    } else if (mode === '--install-campaigns-env') {
      assert.equal(process.platform, 'linux'); assert.equal(fs.realpathSync('.'), '/opt/aerocrm');
      const lock='/opt/aerocrm/release.lock', info=fs.lstatSync(lock), opened=fs.fstatSync(9);
      assert(info.isFile() && !info.isSymbolicLink() && info.dev===opened.dev && info.ino===opened.ino,
        'Campaigns env installation requires inherited canonical release lock fd9');
      assert(fs.realpathSync(file).startsWith('/opt/aerocrm/releases/staging/') && path.basename(file)==='risk-controls-campaigns.env');
      console.log(JSON.stringify(installCampaignsMigrationEnv({sourceFile:file,targetFile:'/opt/aerocrm/env/migrations/campaigns.env'})));
    } else {
      assert.equal(mode, '--preview');
      const { source, candidate } = riskControlsEnvironmentCandidate({ sourceDirectory: file });
      console.log(JSON.stringify({ beforeHash: environmentHash(source), afterHash: environmentHash(candidate),
        changedRoles: riskControlsRoles, publicOrigin: riskControlsFields.MARKETING_PUBLIC_ORIGIN,
        tokenPairPreserved: true, oneClickEnabled: false }));
    }
  } catch { console.error('Risk controls private environment validation failed; values withheld'); process.exitCode = 1; }
}
