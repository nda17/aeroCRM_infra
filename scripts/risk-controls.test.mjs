import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { parseEnv } from "node:util";
import {
  assertScopedS3PrincipalFingerprint,
  retiredAdministratorKeyIdSha256,
} from "./backend-s3-principals.mjs";
import {
  campaignsMigrationEnvSha256,
  installCampaignsMigrationEnv,
  riskControlsEnvironmentCandidate,
  riskControlsFields,
  riskControlsGatewayRoutes,
  riskControlsMarketingRoles,
  riskControlsRoles,
  riskControlsRoutes,
  stageRiskControlsEnvironment,
  validateCampaignsMigrationEnv,
} from "./backend-risk-controls-env.mjs";
import {
  assertRiskControlsCapability,
  prepareRiskControlsWriters,
  riskControlsImageCapable,
  riskControlsServices,
} from "./risk-controls-capabilities.mjs";
import {
  pendingGrantAcl,
  riskControlsInventory,
  schemaFingerprint,
  schemaQuery,
  verifyHistory,
  verifySchema,
} from "./risk-controls-migration.mjs";

function fixtureDirectory(t, changes = {}) {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "risk-controls-env-")),
  );
  fs.chmodSync(root, 0o700);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const routes = [
    {
      id: "existing-health",
      pathPrefix: "/health",
      upstreamUrl: "http://127.0.0.1:4000",
      authPolicy: "none",
      timeoutMs: 3000,
    },
  ];
  const token = changes.token ?? "local-test-token-0123456789abcdef0123456789";
  const s3Id = changes.s3Id ?? "scoped-test-access-key";
  const files = {
    "identity-api.env": `IDENTITY_NOTIFICATION_DELIVERY_TOKEN='${token}'\nMARKETING_EMAIL_ENABLED=false\nS3_ACCESS_KEY_ID='${s3Id}'\nIDENTITY_SECRET='keep-this-value'\n`,
    "notification-delivery-worker.env": `IDENTITY_NOTIFICATION_DELIVERY_TOKEN='${changes.deliveryToken ?? token}'\nMARKETING_PUBLIC_ORIGIN='https://old.example.test'\nS3_ACCESS_KEY_ID='${s3Id}'\nWORKER_SECRET='keep-worker-value'\n`,
    "api-gateway.env": `GATEWAY_ROUTES_JSON='${JSON.stringify(routes)}'\nGATEWAY_SECRET='keep-gateway-value'\n`,
  };
  for (const [name, value] of Object.entries(files))
    fs.writeFileSync(path.join(root, name), value, { mode: 0o600 });
  return { root, routes, files };
}

const parsedFile = (directory, file) =>
  parseEnv(fs.readFileSync(path.join(directory, file), "utf8"));

test("environment delta changes only the two marketing roles and additive gateway routes", (t) => {
  const { root, routes, files } = fixtureDirectory(t);
  const { source, candidate } = riskControlsEnvironmentCandidate({
    sourceDirectory: root,
  });
  assert.deepEqual(riskControlsMarketingRoles, [
    "identity-api.env",
    "notification-delivery-worker.env",
  ]);
  assert.deepEqual(riskControlsRoles, [
    ...riskControlsMarketingRoles,
    "api-gateway.env",
  ]);
  for (const name of riskControlsMarketingRoles) {
    const before = parseEnv(files[name]);
    const after = parseEnv(candidate.get(name).toString("utf8"));
    assert.deepEqual(after, { ...before, ...riskControlsFields });
    assert.equal(
      after.IDENTITY_NOTIFICATION_DELIVERY_TOKEN,
      before.IDENTITY_NOTIFICATION_DELIVERY_TOKEN,
    );
    assert.equal(after.S3_ACCESS_KEY_ID, before.S3_ACCESS_KEY_ID);
  }
  for (const [name, bytes] of source) {
    if (riskControlsRoles.includes(name)) continue;
    assert.deepEqual(candidate.get(name), bytes);
  }
  const gateway = parsedFileFromBytes(candidate.get("api-gateway.env"));
  assert.equal(gateway.GATEWAY_SECRET, "keep-gateway-value");
  const nextRoutes = JSON.parse(gateway.GATEWAY_ROUTES_JSON);
  assert.deepEqual(nextRoutes.slice(0, routes.length), routes);
  assert.deepEqual(nextRoutes.slice(routes.length), riskControlsRoutes);
});

test("environment staging writes private candidate files and leaves source bytes unchanged", (t) => {
  const { root, files } = fixtureDirectory(t);
  const candidateDirectory = path.join(root, "candidate");
  stageRiskControlsEnvironment({ sourceDirectory: root, candidateDirectory });
  assert.equal(fs.statSync(candidateDirectory).mode & 0o777, 0o700);
  for (const [name, before] of Object.entries(files)) {
    assert.equal(
      fs.statSync(path.join(candidateDirectory, name)).mode & 0o777,
      0o600,
    );
    assert.equal(fs.readFileSync(path.join(root, name), "utf8"), before);
  }
});

test("env candidate rejects missing roles and mismatched Identity/Delivery token pair", (t) => {
  const missing = fixtureDirectory(t);
  fs.unlinkSync(path.join(missing.root, "notification-delivery-worker.env"));
  assert.throws(() =>
    riskControlsEnvironmentCandidate({ sourceDirectory: missing.root }),
  );

  const mismatch = fixtureDirectory(t, {
    deliveryToken: "different-local-test-token-0123456789abcdef",
  });
  assert.throws(() =>
    riskControlsEnvironmentCandidate({ sourceDirectory: mismatch.root }),
  );
});

test("environment route reconciliation preserves old routes and rejects ambiguous or drifted collisions", () => {
  const old = {
    id: "keep",
    pathPrefix: "/old",
    upstreamUrl: "http://127.0.0.1:4100",
    authPolicy: "required",
    timeoutMs: 1000,
  };
  assert.deepEqual(riskControlsGatewayRoutes([old]).slice(0, 1), [old]);
  assert.deepEqual(
    riskControlsGatewayRoutes(riskControlsRoutes),
    riskControlsRoutes,
  );
  assert.throws(() => riskControlsGatewayRoutes([old, { ...old }]));
  assert.throws(() =>
    riskControlsGatewayRoutes([
      { ...riskControlsRoutes[0], upstreamUrl: "http://127.0.0.1:1" },
    ]),
  );
  assert.throws(() =>
    riskControlsGatewayRoutes([{ ...riskControlsRoutes[0], id: "another-id" }]),
  );
});

test("campaign migration env is pinned to one scoped role and rejects credential rotation", (t) => {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "risk-controls-campaign-env-")),
  );
  fs.chmodSync(root, 0o700);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const sourceFile = path.join(root, "risk-controls-campaigns.env");
  const targetFile = path.join(root, "campaigns.env");
  const bytes = Buffer.from(
    [
      "NODE_ENV='production'",
      "CAMPAIGNS_DATABASE_URL='postgresql://aerocrm_campaigns_migration:local-test-password@127.0.0.1:5432/aerocrm_campaigns?schema=campaigns&connection_limit=1&pool_timeout=10&connect_timeout=10'",
      "",
    ].join("\n"),
  );
  const expectedHash = createHash("sha256").update(bytes).digest("hex");
  fs.writeFileSync(sourceFile, bytes, { mode: 0o600 });
  const validated = validateCampaignsMigrationEnv(bytes, expectedHash);
  assert.equal(validated.values.NODE_ENV, "production");
  assert.equal(
    validated.values.CAMPAIGNS_DATABASE_URL.includes(
      "aerocrm_campaigns_migration",
    ),
    true,
  );
  assert.equal(campaignsMigrationEnvSha256.length, 64);
  assert.throws(() => validateCampaignsMigrationEnv(bytes, "0".repeat(64)));
  assert.throws(() =>
    validateCampaignsMigrationEnv(
      Buffer.from(
        bytes.toString().replace("schema=campaigns", "schema=identity"),
      ),
      expectedHash,
    ),
  );

  const proofCalls = [];
  const installed = installCampaignsMigrationEnv({
    sourceFile,
    targetFile,
    expectedHash,
    prove: (identity) => proofCalls.push(identity.values.NODE_ENV),
  });
  assert.deepEqual(installed, { installed: true, sha256: expectedHash });
  assert.deepEqual(proofCalls, ["production"]);
  assert.equal(fs.statSync(targetFile).mode & 0o777, 0o600);
  assert.deepEqual(fs.readFileSync(targetFile), bytes);
  assert.deepEqual(
    installCampaignsMigrationEnv({
      sourceFile,
      targetFile,
      expectedHash,
      prove: (identity) => proofCalls.push(identity.values.NODE_ENV),
    }),
    { installed: false, sha256: expectedHash },
  );
  assert.deepEqual(proofCalls, ["production", "production"]);
  assert.throws(() =>
    installCampaignsMigrationEnv({
      sourceFile,
      targetFile,
      expectedHash: "1".repeat(64),
      prove: () => assert.fail("Credential mismatch must fail before proof"),
    }),
  );
});

test("campaign migration env is not installed unless read-only identity proof succeeds", (t) => {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "risk-controls-campaign-proof-")),
  );
  fs.chmodSync(root, 0o700);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const sourceFile = path.join(root, "risk-controls-campaigns.env");
  const targetFile = path.join(root, "campaigns.env");
  const bytes = Buffer.from(
    "NODE_ENV='production'\nCAMPAIGNS_DATABASE_URL='postgresql://aerocrm_campaigns_migration:test@127.0.0.1/aerocrm_campaigns?schema=campaigns&connection_limit=1&pool_timeout=10&connect_timeout=10'\n",
  );
  const expectedHash = createHash("sha256").update(bytes).digest("hex");
  fs.writeFileSync(sourceFile, bytes, { mode: 0o600 });
  let proofAttempted = false;
  assert.throws(() =>
    installCampaignsMigrationEnv({
      sourceFile,
      targetFile,
      expectedHash,
      prove: () => {
        proofAttempted = true;
        throw new Error("read-only proof failed");
      },
    }),
  );
  assert.equal(proofAttempted, true);
  assert.equal(fs.existsSync(targetFile), false);
});

test("retired shared S3 administrator fingerprint is rejected without storing its key", () => {
  assert.equal(retiredAdministratorKeyIdSha256.length, 64);
  assertScopedS3PrincipalFingerprint("a".repeat(64));
  assert.throws(() =>
    assertScopedS3PrincipalFingerprint(retiredAdministratorKeyIdSha256),
  );
});

test("rollback floor requires compatible images across all five services once evidence is recorded", () => {
  assert.deepEqual(riskControlsServices, [
    "identity",
    "notification-delivery",
    "campaigns",
    "billing",
    "operations",
  ]);
  const clear = Object.fromEntries(
    riskControlsServices.map((service) => [
      service,
      { valid: true, recorded: false, completed: false },
    ]),
  );
  assertRiskControlsCapability(clear, {});
  const recorded = Object.fromEntries(
    riskControlsServices.map((service) => [
      service,
      { valid: true, recorded: true, completed: true },
    ]),
  );
  assertRiskControlsCapability(
    recorded,
    Object.fromEntries(riskControlsServices.map((service) => [service, true])),
  );
  for (const missing of riskControlsServices) {
    const capabilities = Object.fromEntries(
      riskControlsServices.map((service) => [service, true]),
    );
    delete capabilities[missing];
    assert.throws(() => assertRiskControlsCapability(recorded, capabilities));
  }
  assert.throws(() =>
    assertRiskControlsCapability(
      {
        ...recorded,
        campaigns: { valid: true, recorded: true, completed: false },
      },
      Object.fromEntries(
        riskControlsServices.map((service) => [service, true]),
      ),
    ),
  );
});

test("writer shutdown is ordered after successful preflight and rechecked before DDL", () => {
  const calls = [];
  let inspections = 0;
  prepareRiskControlsWriters({
    preflight: () => calls.push("preflight"),
    runtime: () => {
      inspections += 1;
      calls.push(`runtime-${inspections}`);
      return inspections === 1
        ? [
            { id: "api", running: true },
            { id: "worker", running: false },
          ]
        : [];
    },
    stop: (ids) => calls.push(["stop", ids]),
  });
  assert.deepEqual(calls, [
    "preflight",
    "runtime-1",
    ["stop", ["api"]],
    "runtime-2",
  ]);

  const rejected = [];
  assert.throws(() =>
    prepareRiskControlsWriters({
      preflight: () => {
        rejected.push("preflight");
        throw new Error("catalog drift");
      },
      runtime: () => {
        rejected.push("runtime");
        return [];
      },
      stop: () => rejected.push("stop"),
    }),
  );
  assert.deepEqual(rejected, ["preflight"]);

  let postStopInspections = 0;
  assert.throws(() =>
    prepareRiskControlsWriters({
      preflight: () => undefined,
      runtime: () => {
        postStopInspections += 1;
        return postStopInspections === 1
          ? [{ id: "writer", running: true }]
          : [{ id: "writer", running: true }];
      },
      stop: () => undefined,
    }),
  );
  assert.equal(postStopInspections, 2);
});

test("image capability requires the immutable revision label and semantic contract probe", () => {
  const calls = [];
  const execute = (_label, _binary, args) => {
    calls.push(args);
    if (args[0] === "image") return "deadbeef";
    return JSON.stringify({ capable: true });
  };
  assert.equal(
    riskControlsImageCapable(
      "operations",
      "aerocrm/operations:test",
      "deadbeef",
      null,
      execute,
    ),
    true,
  );
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1].slice(0, 5), [
    "run",
    "--rm",
    "--network",
    "none",
    "--entrypoint",
  ]);
  assert.equal(
    riskControlsImageCapable(
      "billing",
      "aerocrm/billing:test",
      "different",
      null,
      execute,
    ),
    false,
  );
  assert.throws(() =>
    riskControlsImageCapable("unknown", "image", "sha", null, execute),
  );
});

test("migration history accepts only a contiguous reviewed prefix and detects checksum tampering", () => {
  for (const service of ["identity", "campaigns", "billing"]) {
    const migrations = Object.entries(
      riskControlsInventory.owners[service].migrations,
    );
    const prefix = migrations
      .slice(0, -1)
      .map(([migration_name, checksum]) => ({
        migration_name,
        checksum,
        finished: true,
        rolled_back: false,
      }));
    const complete = migrations.map(([migration_name, checksum]) => ({
      migration_name,
      checksum,
      finished: true,
      rolled_back: false,
    }));
    assert.equal(verifyHistory(service, prefix), false);
    assert.equal(verifyHistory(service, complete), true);
    assert.equal(verifyHistory(service, complete, true), true);
    assert.throws(() =>
      verifyHistory(service, [
        { ...complete[0], checksum: "0".repeat(64) },
        ...complete.slice(1),
      ]),
    );
    assert.throws(() =>
      verifyHistory(
        service,
        complete.map((row, index) =>
          index === 0 ? { ...row, rolled_back: true } : row,
        ),
      ),
    );
    assert.throws(() => verifyHistory(service, complete.slice(1)));
  }
});

test("migration schema contract is PG18-only and detects catalog tampering", () => {
  for (const service of ["identity", "campaigns", "billing"]) {
    assert.match(schemaQuery(service), new RegExp(`n\\.nspname='${service}'`));
    assert.match(schemaQuery(service), /_prisma_migrations/);
    const hashes = riskControlsInventory.owners[service];
    assert.match(hashes.schemaBeforeSha256, /^[a-f0-9]{64}$/);
    assert.match(hashes.schemaAfterSha256, /^[a-f0-9]{64}$/);
    assert.throws(() => verifySchema(service, { columns: [] }, false));
    assert.throws(() => verifySchema(service, { columns: [] }, true));
  }
  assert.equal(
    schemaFingerprint({ a: 1, b: 2 }),
    schemaFingerprint({ a: 1, b: 2 }),
  );
  assert.notEqual(
    schemaFingerprint({ a: 1, b: 2 }),
    schemaFingerprint({ a: 2, b: 1 }),
  );
  assert.throws(() => schemaQuery("billing; DROP SCHEMA identity"));
});

test("post-DDL ACL recovery grants only newly added runtime tables and preserves backup baseline", () => {
  for (const service of ["identity", "campaigns", "billing"]) {
    const entry = riskControlsInventory.owners[service];
    const pending = pendingGrantAcl(entry);
    for (const [table, privileges] of Object.entries(entry.acl.tables)) {
      assert.deepEqual(
        pending.tables[table],
        Object.hasOwn(entry.beforeAcl.tables, table) ? privileges : [],
      );
    }
    assert.deepEqual(pending.sequences, entry.acl.sequences);
    assert.deepEqual(pending.routines, entry.acl.routines);
    assert.deepEqual(pending.types, entry.acl.types);
  }
});

function parsedFileFromBytes(bytes) {
  return parseEnv(bytes.toString("utf8"));
}
