import test from 'node:test';
import assert from 'node:assert/strict';
import { releaseInventoryFiles } from './backend-image-inventory.mjs';
import { normalizeInventory, runImageCleanup } from './backend-image-cleanup.mjs';

const sha = (char) => char.repeat(40);
const digest = (char) => char.repeat(64);
const image = (char) => `sha256:${digest(char)}`;
const inventoryHash = digest('a');
const infraSha = sha('b');

function candidate(char, app = 'billing', revision = sha('c')) {
  return {
    imageId: image(char),
    tags: [`aerocrm/${app}:${revision}`],
    sizeBytes: 1024,
    revision,
  };
}

function approvedInventory(items = [candidate('1'), candidate('2', 'identity', sha('d'))]) {
  return {
    schemaVersion: 1,
    mode: 'READ_ONLY',
    generatedAt: '2026-09-28T00:00:00.000Z',
    containerCount: 1,
    candidates: items,
    retained: [{
      ...candidate('f', 'crm-sales', sha('e')),
      reasons: ['canonical', 'container-reference'],
    }],
    estimatedImageBytes: items.reduce((sum, item) => sum + item.sizeBytes, 0),
    note: 'Synthetic fixture; no production inventory data.',
  };
}

function protection() {
  return {
    releaseFiles: releaseInventoryFiles.map((name, index) => ({
      name,
      sha256: index === releaseInventoryFiles.length - 1 ? null : digest(String(index % 10)),
    })),
    containers: [{ containerId: digest('8'), imageId: image('f') }],
  };
}

function snapshot(approved, { removed = [], guard = protection(), installedExtra = [] } = {}) {
  const inventory = structuredClone({
    ...approved,
    candidates: approved.candidates.filter((item) => !removed.includes(item.imageId)),
  });
  return {
    inventory,
    protection: structuredClone(guard),
    imageIds: [
      ...approved.candidates.map((item) => item.imageId).filter((id) => !removed.includes(id)),
      ...approved.retained.map((item) => item.imageId),
      ...installedExtra,
    ].sort(),
  };
}

function harness(approved = approvedInventory(), options = {}) {
  let current = snapshot(approved);
  let journal = null;
  const writes = [];
  const calls = [];
  let reads = 0;
  return {
    approved,
    writes,
    calls,
    setSnapshot(value) { current = structuredClone(value); },
    getSnapshot() { return structuredClone(current); },
    getJournal() { return journal && structuredClone(journal); },
    readSnapshot() {
      reads++;
      return options.readSnapshot ? options.readSnapshot(reads, current) : structuredClone(current);
    },
    readJournal() { return journal && structuredClone(journal); },
    writeJournal(value) {
      journal = structuredClone(value);
      writes.push(structuredClone(value));
    },
    remove(args) {
      calls.push(args);
      if (options.runDocker) return options.runDocker(args, this);
      const id = args.at(-1);
      current = snapshot(approved, {
        removed: [...(options.removedSoFar ?? []), ...calls.map((call) => call.at(-1))],
        guard: current.protection,
        installedExtra: [],
      });
      return id;
    },
    run(overrides = {}) {
      return runImageCleanup({
        approved: overrides.approved ?? approved,
        inventoryHash: overrides.inventoryHash ?? inventoryHash,
        infraSha: overrides.infraSha ?? infraSha,
        readSnapshot: overrides.readSnapshot ?? (() => this.readSnapshot()),
        readJournal: overrides.readJournal ?? (() => this.readJournal()),
        writeJournal: overrides.writeJournal ?? ((value) => this.writeJournal(value)),
        runDocker: overrides.runDocker
          ? (args) => overrides.runDocker(args, this)
          : (args) => this.remove(args),
        diskUsage: overrides.diskUsage ?? (() => ({ availableBytes: '1234' })),
      });
    },
  };
}

test('normalization sorts image IDs, tags, and retention reasons and rejects duplicate or overlapping identities', () => {
  const source = approvedInventory();
  source.candidates[0].tags.reverse();
  source.retained[0].reasons.reverse();
  const normalized = normalizeInventory(source);
  assert.deepEqual(normalized.candidates.map((item) => item.imageId),
    normalized.candidates.map((item) => item.imageId).toSorted());
  assert.deepEqual(normalized.candidates[0].tags, [...source.candidates[0].tags].sort());
  assert.deepEqual(normalized.retained[0].reasons, ['canonical', 'container-reference']);
  assert.throws(() => normalizeInventory({ ...source, candidates: [...source.candidates, source.candidates[0]] }),
    /Duplicate or overlapping cleanup images/);
});

test('cleanup deletes only reviewed image IDs with no force and explicit no-prune, then verifies completion and disk usage', () => {
  const testHarness = harness();
  const report = testHarness.run();
  const ids = testHarness.approved.candidates.map((item) => item.imageId).sort();
  assert.deepEqual(testHarness.calls, ids.map((id) => ['image', 'rm', '--no-prune', id]));
  assert(testHarness.calls.flat().every((arg) => !['-f', '--force', 'prune', 'system'].includes(arg)));
  assert.deepEqual(report.removedImageIds, ids);
  assert.deepEqual(report.inventory.candidates, []);
  assert.deepEqual(report.inventory.retained.map((item) => item.imageId), [image('f')]);
  assert.deepEqual(report.diskUsage, { availableBytes: '1234' });
  assert.equal(testHarness.getJournal().completed, true);
  assert.deepEqual(testHarness.writes.filter((entry) => entry.inFlightImageId).map((entry) => entry.inFlightImageId), ids);
});

test('candidate image referenced by a container is rejected before any Docker mutation', () => {
  const approved = approvedInventory();
  const protectedState = protection();
  protectedState.containers[0].imageId = approved.candidates[0].imageId;
  const testHarness = harness(approved);
  testHarness.setSnapshot(snapshot(approved, { guard: protectedState }));
  assert.throws(() => testHarness.run(), /container reference|protection fingerprint/i);
  assert.deepEqual(testHarness.calls, []);
});

test('approved identity rejects malformed hash and a resumed journal from another approval or infrastructure SHA', () => {
  const invalid = harness();
  assert.throws(() => invalid.run({ inventoryHash: 'not-a-hash' }), /approval or infrastructure hash/);
  assert.deepEqual(invalid.calls, []);

  const seed = harness();
  const firstId = seed.approved.candidates[0].imageId;
  const firstSnapshot = snapshot(seed.approved, { removed: [firstId] });
  seed.writeJournal({
    schemaVersion: 1,
    inventoryHash,
    infraSha,
    protection: firstSnapshot.protection,
    removedImageIds: [firstId],
    inFlightImageId: null,
    installedImageIds: snapshot(seed.approved).imageIds,
    completed: false,
  });
  seed.setSnapshot(firstSnapshot);
  for (const identity of [{ infraSha: sha('9') }, { inventoryHash: digest('9') }]) {
    assert.throws(() => seed.run(identity), /Invalid cleanup journal or reviewed identity/);
    assert.deepEqual(seed.calls, []);
  }
});

test('current, previous, pending, schema-marker, and all-container drift each block deletion', () => {
  const approved = approvedInventory();
  const changedNames = [
    'backend-state.json',
    'backend-previous-state.json',
    'backend-release.pending.json',
    'workspace-closure-compatible.sha',
    'workspace-closure-enabled.sha',
  ];
  for (const name of changedNames) {
    const testHarness = harness(approved);
    let readCount = 0;
    assert.throws(() => testHarness.run({
      readSnapshot: () => {
        readCount++;
        const value = snapshot(approved);
        if (readCount > 1) {
          const changed = value.protection.releaseFiles.find((file) => file.name === name);
          changed.sha256 = digest('9');
        }
        return value;
      },
    }), /protection fingerprint drift/);
    assert.deepEqual(testHarness.calls, [], `Unexpected deletion after ${name} drift`);
  }
});

test('same-count container replacement is detected by exact container identity and image reference', () => {
  const approved = approvedInventory();
  const testHarness = harness(approved);
  let readCount = 0;
  assert.throws(() => testHarness.run({
    readSnapshot: () => {
      readCount++;
      const value = snapshot(approved);
      if (readCount > 1) value.protection.containers[0] = {
        containerId: digest('7'),
        imageId: image('f'),
      };
      return value;
    },
  }), /protection fingerprint drift/);
  assert.deepEqual(testHarness.calls, []);
});

test('unapproved candidate, candidate metadata drift, and extra installed image fail closed', () => {
  const approved = approvedInventory();
  const unexpected = candidate('3', 'support', sha('7'));
  for (const mutate of [
    (value) => {
      value.inventory.candidates.push(unexpected);
      value.imageIds.push(unexpected.imageId);
      value.imageIds.sort();
    },
    (value) => { value.inventory.candidates[0].tags = ['aerocrm/billing:' + sha('9')]; },
    (value) => { value.imageIds.push(image('9')); value.imageIds.sort(); },
  ]) {
    const testHarness = harness(approved);
    let readCount = 0;
    assert.throws(() => testHarness.run({
      readSnapshot: () => {
        readCount++;
        const value = snapshot(approved);
        if (readCount > 1) mutate(value);
        return value;
      },
    }), /inventory drift|installed image inventory drift/);
    assert.deepEqual(testHarness.calls, []);
  }
});

test('a failed post-delete verification stops before another image and leaves every protected ID untouched', () => {
  const approved = approvedInventory();
  const testHarness = harness(approved);
  assert.throws(() => testHarness.run({
    runDocker: (args, context) => {
      context.calls.push(args);
      // Simulate a Docker response without the requested image actually disappearing.
    },
  }), /inventory drift|installed image inventory drift/);
  assert.deepEqual(testHarness.calls, [['image', 'rm', '--no-prune', approved.candidates[0].imageId]]);
  assert.equal(testHarness.getJournal().inFlightImageId, approved.candidates[0].imageId);
  assert.equal(testHarness.getSnapshot().protection.containers[0].imageId, image('f'));
});

test('partial cleanup resumes from the same approved journal after a lost remove response', () => {
  const approved = approvedInventory();
  const testHarness = harness(approved);
  const firstId = approved.candidates.map((item) => item.imageId).sort()[0];
  const secondId = approved.candidates.map((item) => item.imageId).sort()[1];
  let firstAttempt = true;
  assert.throws(() => testHarness.run({
    runDocker: (args, context) => {
      context.calls.push(args);
      const id = args.at(-1);
      if (firstAttempt && id === firstId) {
        firstAttempt = false;
        context.setSnapshot(snapshot(approved, { removed: [firstId] }));
        throw new Error('synthetic lost Docker response');
      }
      const priorRemoved = id === secondId ? [firstId, secondId] : [id];
      context.setSnapshot(snapshot(approved, { removed: priorRemoved }));
    },
  }), /synthetic lost Docker response/);
  const pendingJournal = testHarness.getJournal();
  assert.deepEqual(pendingJournal.removedImageIds, []);
  assert.equal(pendingJournal.inFlightImageId, firstId);

  const beforeResumeCalls = testHarness.calls.length;
  const report = testHarness.run();
  assert.deepEqual(testHarness.calls.slice(beforeResumeCalls), [
    ['image', 'rm', '--no-prune', secondId],
  ]);
  assert.equal(report.inventory.candidates.length, 0);
  assert.deepEqual(testHarness.getJournal().removedImageIds, [firstId, secondId]);
  assert.equal(testHarness.getJournal().inventoryHash, inventoryHash);
  assert.equal(testHarness.getJournal().infraSha, infraSha);
});

test('a candidate disappearing from tags but remaining installed cannot be treated as deleted during resume', () => {
  const approved = approvedInventory();
  const testHarness = harness(approved);
  const firstId = approved.candidates.map((item) => item.imageId).sort()[0];
  const before = snapshot(approved, { removed: [firstId] });
  before.imageIds.push(firstId);
  before.imageIds.sort();
  testHarness.writeJournal({
    schemaVersion: 1,
    inventoryHash,
    infraSha,
    protection: before.protection,
    removedImageIds: [],
    inFlightImageId: firstId,
    installedImageIds: snapshot(approved).imageIds,
    completed: false,
  });
  testHarness.setSnapshot(before);
  assert.throws(() => testHarness.run(), /installed image inventory drift/);
  assert.deepEqual(testHarness.calls, []);
});
