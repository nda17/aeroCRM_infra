import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import {
  mailEnvFiles,
  parseMailEnv,
  validateMailBundle,
  stageMailEnvironment,
} from './backend-mail-env.mjs';

const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const database =
  'postgresql://crm_user:synthetic-db-value@127.0.0.1:5432/aerocrm_crm_customers?schema=crm_customers&connection_limit=2&pool_timeout=10&connect_timeout=10';
const s3 = {
  CRM_MAIL_S3_ENDPOINT: 'https://storage.example.net',
  CRM_MAIL_S3_REGION: 'ru-1',
  CRM_MAIL_S3_BUCKET: 'private-mail-test',
  CRM_MAIL_S3_ACCESS_KEY_ID: 'synthetic-storage-access',
  CRM_MAIL_S3_SECRET_ACCESS_KEY: 'synthetic-storage-secret',
  CRM_MAIL_S3_FORCE_PATH_STYLE: 'true',
};
const credential = {
  CRM_MAIL_CREDENTIAL_KEY_ID: 'mail-key-v1',
  CRM_MAIL_CREDENTIAL_KEY: Buffer.alloc(32, 7).toString('base64'),
};
const quote = (value) => `'${value}'`;
const envText = (values) =>
  Object.entries(values)
    .map(([key, value]) => `${key}=${quote(value)}`)
    .join('\n') + '\n';

function apiEnv({
  enabled = false,
  secretStorage = false,
  key = credential,
  unrelated = {},
} = {}) {
  return {
    NODE_ENV: 'production',
    CRM_CUSTOMERS_PROCESS_ROLE: 'api',
    CRM_CUSTOMERS_PORT: '5320',
    CRM_CUSTOMERS_DATABASE_URL: database,
    CRM_CUSTOMERS_DADATA_API_KEY: 'synthetic-dadata-value',
    NODE_OPTIONS: '--max-old-space-size=256',
    CRM_MAIL_ENABLED: String(enabled),
    CRM_MAIL_SYNC_ENABLED: String(enabled),
    CRM_MAIL_SEND_ENABLED: String(enabled),
    ...(key ? key : {}),
    ...(secretStorage ? s3 : {}),
    ...unrelated,
  };
}

function workerEnv(api, role, port) {
  const values = { ...api };
  delete values.CRM_CUSTOMERS_DADATA_API_KEY;
  values.CRM_CUSTOMERS_PROCESS_ROLE = role;
  values.CRM_CUSTOMERS_PORT = String(port);
  values.CRM_CUSTOMERS_DATABASE_URL = database.replace(
    'connection_limit=2',
    'connection_limit=1'
  );
  return values;
}

function makeBundle(api = apiEnv()) {
  const values = [
    api,
    workerEnv(api, 'mail-sync', 5321),
    workerEnv(api, 'mail-send', 5322),
  ];
  const bundle = Buffer.from(
    JSON.stringify(
      Object.fromEntries(
        mailEnvFiles.map((name, index) => [name, envText(values[index])])
      )
    ) + '\n'
  );
  return {
    bundle,
    hash: digest(bundle),
    files: new Map(
      mailEnvFiles.map((name, index) => [name, envText(values[index])])
    ),
  };
}

function rejectedWithoutValues(
  action,
  values = ['synthetic-db-value', 'synthetic-storage-secret'],
  expectedMessage = null
) {
  assert.throws(action, (error) => {
    assert(error instanceof Error);
    if (expectedMessage) assert.equal(error.message, expectedMessage);
    for (const value of values) assert(!error.message.includes(value));
    return true;
  });
}

test('strict parser rejects duplicate, unquoted, malformed, and non-canonical env rows without echoing values', () => {
  assert.deepEqual(parseMailEnv("ONE='value'\nTWO='two'\n"), {
    ONE: 'value',
    TWO: 'two',
  });
  for (const value of [
    "ONE='first'\nONE='synthetic-secret'\n",
    'ONE=unquoted-secret\n',
    "ONE='value'\r\n",
    "ONE='line\nbreak'\n",
    '',
  ])
    rejectedWithoutValues(
      () => parseMailEnv(value),
      ['synthetic-secret', 'unquoted-secret'],
      value === ''
        ? 'Mail env must be canonical text'
        : 'Mail env has invalid or duplicate fields'
    );
});

test('bundle accepts a disabled configuration with no credential key or storage and creates paired workers from the reviewed API env', () => {
  const { bundle, hash, files } = makeBundle(apiEnv({ key: null }));
  assert.deepEqual([...validateMailBundle(bundle, hash)], [...files]);
  assert.throws(
    () =>
      validateMailBundle(
        bundle,
        hash,
        new Map([
          [
            mailEnvFiles[0],
            envText(
              apiEnv({ key: null, unrelated: { CRM_OTHER_SETTING: 'drift' } })
            ),
          ],
        ])
      ),
    /Unrelated Customers env changes are forbidden/
  );
});

test('bundle rejects incorrect hashes, extra or missing files, and worker role or pool drift', () => {
  const valid = makeBundle();
  assert.throws(
    () => validateMailBundle(valid.bundle, '0'.repeat(64)),
    /hash mismatch/
  );
  const base = JSON.parse(valid.bundle.toString());
  rejectedWithoutValues(
    () =>
      validateMailBundle(
        Buffer.from(
          JSON.stringify({
            ...base,
            extra: "CRM_MAIL_SECRET='synthetic-storage-secret'",
          }) + '\n'
        ),
        digest(
          Buffer.from(
            JSON.stringify({
              ...base,
              extra: "CRM_MAIL_SECRET='synthetic-storage-secret'",
            }) + '\n'
          )
        )
      ),
    undefined,
    'Private mail bundle must contain exactly three reviewed files'
  );
  const missing = { ...base };
  delete missing[mailEnvFiles[2]];
  const incomplete = Buffer.from(JSON.stringify(missing) + '\n');
  rejectedWithoutValues(
    () => validateMailBundle(incomplete, digest(incomplete)),
    undefined,
    'Private mail bundle must contain exactly three reviewed files'
  );
  const traversal = Buffer.from(
    JSON.stringify({ ...base, '../unexpected.env': "SAFE='value'\n" }) + '\n'
  );
  rejectedWithoutValues(
    () => validateMailBundle(traversal, digest(traversal)),
    undefined,
    'Private mail bundle must contain exactly three reviewed files'
  );
  for (const [file, replacement] of [
    [
      mailEnvFiles[1],
      base[mailEnvFiles[1]].replace(
        "CRM_CUSTOMERS_PORT='5321'",
        "CRM_CUSTOMERS_PORT='5322'"
      ),
    ],
    [
      mailEnvFiles[2],
      base[mailEnvFiles[2]].replace('connection_limit=1', 'connection_limit=2'),
    ],
    [
      mailEnvFiles[1],
      base[mailEnvFiles[1]].replace(
        "NODE_OPTIONS='--max-old-space-size=256'",
        "NODE_OPTIONS='--max-old-space-size=512'"
      ),
    ],
  ]) {
    const changed = Buffer.from(
      JSON.stringify({ ...base, [file]: replacement }) + '\n'
    );
    rejectedWithoutValues(() => validateMailBundle(changed, digest(changed)));
  }
});

test('mail gates are uniform and enabling mail requires a valid key and complete private object storage', () => {
  const disabled = makeBundle(apiEnv({ key: null }));
  assert.doesNotThrow(() => validateMailBundle(disabled.bundle, disabled.hash));
  const incompleteStorage = apiEnv({ enabled: true, secretStorage: true });
  delete incompleteStorage.CRM_MAIL_S3_SECRET_ACCESS_KEY;
  for (const [api, message] of [
    [
      { ...apiEnv({ key: null }), CRM_MAIL_SYNC_ENABLED: 'true' },
      'Mail workers require the mail API gate',
    ],
    [
      { ...apiEnv({ key: null }), CRM_MAIL_ENABLED: 'maybe' },
      'Mail gates must be explicit booleans',
    ],
    [
      apiEnv({ enabled: true, key: null }),
      'Invalid mail encryption key configuration',
    ],
    [
      apiEnv({ enabled: true }),
      'Enabled mail requires private attachment storage',
    ],
    [incompleteStorage, 'Mail storage configuration must be complete'],
  ]) {
    const bundle = makeBundle(api);
    rejectedWithoutValues(
      () => validateMailBundle(bundle.bundle, bundle.hash),
      undefined,
      message
    );
  }
  const active = makeBundle(apiEnv({ enabled: true, secretStorage: true }));
  assert.doesNotThrow(() => validateMailBundle(active.bundle, active.hash));
  const unknownMailSetting = makeBundle({
    ...apiEnv({ key: null }),
    CRM_MAIL_UNREVIEWED: 'synthetic-unknown-value',
  });
  rejectedWithoutValues(
    () =>
      validateMailBundle(unknownMailSetting.bundle, unknownMailSetting.hash),
    ['synthetic-unknown-value'],
    'Unreviewed mail configuration fields are forbidden'
  );
});

test('mail activation requires a key provisioned during an earlier disabled release and preserves that key', () => {
  const previousWithoutKey = new Map([
    [mailEnvFiles[0], envText(apiEnv({ key: null }))],
  ]);
  const firstEnable = makeBundle(apiEnv({ enabled: true, secretStorage: true }));
  rejectedWithoutValues(
    () =>
      validateMailBundle(
        firstEnable.bundle,
        firstEnable.hash,
        previousWithoutKey
      ),
    [credential.CRM_MAIL_CREDENTIAL_KEY],
    'Mail enable requires the same encryption key and id in the previous disabled snapshot'
  );
  const temp = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'mail-env-first-enable-'))
  );
  const source = path.join(temp, 'source');
  const candidate = path.join(temp, 'candidate');
  const bundleFile = path.join(temp, 'bundle.json');
  fs.mkdirSync(source, { mode: 0o700 });
  const oldApi = envText(apiEnv({ key: null }));
  fs.writeFileSync(path.join(source, mailEnvFiles[0]), oldApi, { mode: 0o600 });
  fs.writeFileSync(bundleFile, firstEnable.bundle, { mode: 0o600 });
  rejectedWithoutValues(
    () =>
      stageMailEnvironment({
        bundleFile,
        bundleHash: firstEnable.hash,
        sourceDirectory: source,
        candidateDirectory: candidate,
      }),
    [credential.CRM_MAIL_CREDENTIAL_KEY],
    'Mail enable requires the same encryption key and id in the previous disabled snapshot'
  );
  assert.equal(fs.readFileSync(path.join(source, mailEnvFiles[0]), 'utf8'), oldApi);
  assert.equal(fs.existsSync(candidate), false);
  fs.rmSync(temp, { recursive: true, force: true });

  const provisioned = makeBundle(apiEnv({ key: credential }));
  assert.doesNotThrow(() =>
    validateMailBundle(provisioned.bundle, provisioned.hash, previousWithoutKey)
  );
  const previousProvisioned = new Map([
    [mailEnvFiles[0], provisioned.files.get(mailEnvFiles[0])],
  ]);
  const enabledWithSameKey = makeBundle(
    apiEnv({ enabled: true, secretStorage: true, key: credential })
  );
  assert.doesNotThrow(() =>
    validateMailBundle(
      enabledWithSameKey.bundle,
      enabledWithSameKey.hash,
      previousProvisioned
    )
  );

  const nextKey = {
    CRM_MAIL_CREDENTIAL_KEY_ID: 'mail-key-v2',
    CRM_MAIL_CREDENTIAL_KEY: Buffer.alloc(32, 9).toString('base64'),
  };
  const rollbackEnable = makeBundle(
    apiEnv({ enabled: true, secretStorage: true, key: nextKey })
  );
  rejectedWithoutValues(
    () =>
      validateMailBundle(
        rollbackEnable.bundle,
        rollbackEnable.hash,
        previousWithoutKey
      ),
    [nextKey.CRM_MAIL_CREDENTIAL_KEY],
    'Mail enable requires the same encryption key and id in the previous disabled snapshot'
  );

  const partialPrevious = new Map([
    [
      mailEnvFiles[0],
      envText({
        ...apiEnv({ key: null }),
        CRM_MAIL_CREDENTIAL_KEY_ID: credential.CRM_MAIL_CREDENTIAL_KEY_ID,
      }),
    ],
  ]);
  rejectedWithoutValues(
    () =>
      validateMailBundle(
        enabledWithSameKey.bundle,
        enabledWithSameKey.hash,
        partialPrevious
      ),
    [credential.CRM_MAIL_CREDENTIAL_KEY],
    'Mail enable requires the same encryption key and id in the previous disabled snapshot'
  );
});

test('existing encryption key identity and unrelated API settings cannot be removed, changed, or rotated', () => {
  const priorApi = apiEnv({
    key: credential,
    unrelated: { CRM_CUSTOMERS_FEATURE_FLAG: 'stable' },
  });
  const previous = new Map([[mailEnvFiles[0], envText(priorApi)]]);
  const accepted = makeBundle(
    apiEnv({
      key: credential,
      unrelated: { CRM_CUSTOMERS_FEATURE_FLAG: 'stable' },
    })
  );
  assert.doesNotThrow(() =>
    validateMailBundle(accepted.bundle, accepted.hash, previous)
  );

  const rotated = {
    ...credential,
    CRM_MAIL_CREDENTIAL_KEY_ID: 'mail-key-v2',
    CRM_MAIL_CREDENTIAL_KEY: Buffer.alloc(32, 8).toString('base64'),
  };
  for (const [changedApi, message] of [
    [
      apiEnv({
        key: rotated,
        unrelated: { CRM_CUSTOMERS_FEATURE_FLAG: 'stable' },
      }),
      'Existing mail encryption key removal or rotation is forbidden',
    ],
    [
      apiEnv({
        key: null,
        unrelated: { CRM_CUSTOMERS_FEATURE_FLAG: 'stable' },
      }),
      'Existing mail encryption key removal or rotation is forbidden',
    ],
    [
      apiEnv({
        key: credential,
        unrelated: { CRM_CUSTOMERS_FEATURE_FLAG: 'changed' },
      }),
      'Unrelated Customers env changes are forbidden',
    ],
  ]) {
    const candidate = makeBundle(changedApi);
    rejectedWithoutValues(
      () => validateMailBundle(candidate.bundle, candidate.hash, previous),
      [credential.CRM_MAIL_CREDENTIAL_KEY, rotated.CRM_MAIL_CREDENTIAL_KEY],
      message
    );
  }
});

test('an existing mail worker cannot drift during env staging', () => {
  const prior = makeBundle(apiEnv({ key: null }));
  const previous = new Map(prior.files);
  previous.set(
    mailEnvFiles[1],
    previous.get(mailEnvFiles[1]).replace('256', '384')
  );
  const candidate = makeBundle(apiEnv({ key: null }));
  rejectedWithoutValues(
    () => validateMailBundle(candidate.bundle, candidate.hash, previous),
    undefined,
    'Unrelated Customers env changes are forbidden'
  );
});

test('staging writes a private candidate and leaves the source snapshot bytes and permissions unchanged', () => {
  const temp = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'mail-env-contract-'))
  );
  const source = path.join(temp, 'source');
  const candidate = path.join(temp, 'candidate');
  const bundleFile = path.join(temp, 'bundle.json');
  fs.mkdirSync(source, { mode: 0o700 });
  const oldApi = envText(apiEnv({ key: null }));
  fs.writeFileSync(path.join(source, mailEnvFiles[0]), oldApi, { mode: 0o600 });
  fs.writeFileSync(
    path.join(source, 'billing.env'),
    "BILLING_MODE='stable'\n",
    { mode: 0o600 }
  );
  const before = new Map(
    fs
      .readdirSync(source)
      .map((name) => [name, fs.readFileSync(path.join(source, name))])
  );
  const next = makeBundle(apiEnv({ key: null }));
  fs.writeFileSync(bundleFile, next.bundle, { mode: 0o600 });

  assert.equal(
    stageMailEnvironment({
      bundleFile,
      bundleHash: next.hash,
      sourceDirectory: source,
      candidateDirectory: candidate,
    }),
    candidate
  );
  for (const [name, bytes] of before)
    assert.deepEqual(fs.readFileSync(path.join(source, name)), bytes);
  for (const name of fs.readdirSync(candidate))
    assert.equal(fs.statSync(path.join(candidate, name)).mode & 0o777, 0o600);
  assert.deepEqual(
    new Set(fs.readdirSync(candidate)),
    new Set([...before.keys(), ...mailEnvFiles])
  );
  assert.deepEqual(
    fs.readFileSync(path.join(candidate, mailEnvFiles[0])),
    Buffer.from(next.files.get(mailEnvFiles[0]))
  );
  assert.equal(fs.statSync(candidate).mode & 0o777, 0o700);
  fs.rmSync(temp, { recursive: true, force: true });
});

test('staging rejects unsafe source and bundle files before writing a candidate', () => {
  const temp = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'mail-env-invalid-'))
  );
  const source = path.join(temp, 'source');
  const candidate = path.join(temp, 'candidate');
  const bundleFile = path.join(temp, 'bundle.json');
  fs.mkdirSync(source, { mode: 0o700 });
  const next = makeBundle(apiEnv({ key: null }));
  fs.writeFileSync(bundleFile, next.bundle, { mode: 0o600 });
  fs.chmodSync(bundleFile, 0o644);
  rejectedWithoutValues(() =>
    stageMailEnvironment({
      bundleFile,
      bundleHash: next.hash,
      sourceDirectory: source,
      candidateDirectory: candidate,
    })
  );
  assert.equal(fs.existsSync(candidate), false);
  fs.rmSync(temp, { recursive: true, force: true });
});

test('mail object storage cannot reuse a backup, support, or avatar access key', () => {
  const temp = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'mail-env-shared-key-'))
  );
  const source = path.join(temp, 'source');
  const candidate = path.join(temp, 'candidate');
  const bundleFile = path.join(temp, 'bundle.json');
  fs.mkdirSync(source, { mode: 0o700 });
  fs.writeFileSync(
    path.join(source, mailEnvFiles[0]),
    envText(apiEnv({ key: credential })),
    { mode: 0o600 }
  );
  fs.writeFileSync(
    path.join(source, 'backup.env'),
    envText({ CRM_BACKUP_S3_ACCESS_KEY_ID: s3.CRM_MAIL_S3_ACCESS_KEY_ID }),
    { mode: 0o600 }
  );
  const next = makeBundle(
    apiEnv({ enabled: true, secretStorage: true, key: credential })
  );
  fs.writeFileSync(bundleFile, next.bundle, { mode: 0o600 });
  rejectedWithoutValues(
    () =>
      stageMailEnvironment({
        bundleFile,
        bundleHash: next.hash,
        sourceDirectory: source,
        candidateDirectory: candidate,
      }),
    [s3.CRM_MAIL_S3_ACCESS_KEY_ID],
    'Mail storage requires an independent access key'
  );
  assert.equal(fs.existsSync(candidate), false);
  fs.rmSync(temp, { recursive: true, force: true });
});
