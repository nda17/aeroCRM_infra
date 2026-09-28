#!/usr/bin/env node
// Delete only the frozen reviewed IDs; never infer a new deletion set from live data.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { collectImageSnapshot, dockerInventory, releaseInventoryFiles } from './backend-image-inventory.mjs';
import { validateState, validatePending, apps } from './backend-release-state.mjs';

const root = '/opt/aerocrm';
const imageId = /^sha256:[a-f0-9]{64}$/;
const hash = /^[a-f0-9]{64}$/;
const sha = /^[a-f0-9]{40}$/;
const check = (condition, message) => { if (!condition) throw new Error(message); };
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const sorted = values => [...values].sort();
function exactKeys(value, names) {
  check(value && typeof value === 'object' && !Array.isArray(value) &&
    isDeepStrictEqual(Object.keys(value).sort(), sorted(names)), 'Invalid cleanup contract fields');
}
export function normalizeInventory(inventory) {
  check(inventory?.schemaVersion === 1 && Number.isSafeInteger(inventory.containerCount) && inventory.containerCount >= 0 &&
    Array.isArray(inventory.candidates) && Array.isArray(inventory.retained), 'Invalid cleanup inventory');
  function items(values, retained) {
    return values.map(item => {
      exactKeys(item, ['imageId', 'tags', 'sizeBytes', 'revision', ...(retained ? ['reasons'] : [])]);
      check(imageId.test(item.imageId) && Array.isArray(item.tags) && item.tags.every(tag => typeof tag === 'string') &&
        Number.isSafeInteger(item.sizeBytes) && item.sizeBytes >= 0 && (item.revision === null || sha.test(item.revision)),
        'Invalid cleanup image identity');
      check(new Set(item.tags).size === item.tags.length, 'Duplicate cleanup image tags');
      if (retained) check(Array.isArray(item.reasons) && item.reasons.length > 0 && item.reasons.every(reason => typeof reason === 'string'),
        'Invalid cleanup retained reasons');
      return { imageId: item.imageId, tags: sorted(item.tags), sizeBytes: item.sizeBytes, revision: item.revision,
        ...(retained ? { reasons: sorted(item.reasons) } : {}) };
    }).sort((a, b) => a.imageId.localeCompare(b.imageId));
  }
  const candidates = items(inventory.candidates, false), retained = items(inventory.retained, true);
  check(new Set([...candidates, ...retained].map(item => item.imageId)).size === candidates.length + retained.length,
    'Duplicate or overlapping cleanup images');
  return { schemaVersion: 1, containerCount: inventory.containerCount, candidates, retained };
}
function validateProtection(protection) {
  exactKeys(protection, ['releaseFiles', 'containers']);
  check(Array.isArray(protection.releaseFiles) && Array.isArray(protection.containers), 'Invalid cleanup protection fingerprint');
  check(isDeepStrictEqual(protection.releaseFiles.map(file => file.name), releaseInventoryFiles), 'Invalid cleanup release fingerprint');
  for (const file of protection.releaseFiles) {
    exactKeys(file, ['name', 'sha256']);
    check(file.sha256 === null || hash.test(file.sha256), 'Invalid cleanup release hash');
  }
  for (const container of protection.containers) {
    exactKeys(container, ['containerId', 'imageId']);
    check(/^[a-f0-9]{64}$/.test(container.containerId) && imageId.test(container.imageId), 'Invalid cleanup container reference');
  }
  check(new Set(protection.containers.map(container => container.containerId)).size === protection.containers.length &&
    isDeepStrictEqual(protection.containers.map(container => container.containerId), sorted(protection.containers.map(container => container.containerId))),
    'Invalid cleanup container order');
}
export function runImageCleanup({ approved, inventoryHash, infraSha, readSnapshot, readJournal, writeJournal, runDocker, diskUsage }) {
  check(hash.test(inventoryHash) && sha.test(infraSha), 'Invalid cleanup approval or infrastructure hash');
  const baseline = normalizeInventory(approved);
  check(approved.mode === 'READ_ONLY' && baseline.candidates.length > 0, 'Cleanup requires a reviewed read-only inventory');
  for (const item of baseline.candidates) {
    const tag = /^aerocrm\/([a-z-]+):([a-f0-9]{40})$/.exec(item.tags[0] ?? '');
    check(item.tags.length === 1 && tag && apps.includes(tag[1]) && tag[2] === item.revision,
      'Cleanup requires exactly one reviewed backend tag per image');
  }
  const ids = baseline.candidates.map(item => item.imageId);
  let journal = readJournal();
  function expect(snapshot, removed, protection = null, installedImageIds = null) {
    validateProtection(snapshot.protection);
    check(snapshot.protection.containers.length === snapshot.inventory.containerCount,
      'Cleanup container count differs from its protection fingerprint');
    check(!snapshot.protection.containers.some(container => ids.includes(container.imageId)),
      'Cleanup candidate has a container reference');
    check(Array.isArray(snapshot.imageIds) && snapshot.imageIds.every(id => imageId.test(id)) &&
      new Set(snapshot.imageIds).size === snapshot.imageIds.length && isDeepStrictEqual(snapshot.imageIds, sorted(snapshot.imageIds)),
      'Invalid installed image inventory');
    check([...snapshot.inventory.candidates, ...snapshot.inventory.retained].every(item => snapshot.imageIds.includes(item.imageId)),
      'Cleanup report includes absent images');
    const expected = { ...baseline, candidates: baseline.candidates.filter(item => !removed.includes(item.imageId)) };
    check(isDeepStrictEqual(normalizeInventory(snapshot.inventory), expected), 'Cleanup inventory drift; no further deletion is allowed');
    check(!protection || isDeepStrictEqual(snapshot.protection, protection), 'Cleanup protection fingerprint drift');
    check(!installedImageIds || isDeepStrictEqual(snapshot.imageIds, installedImageIds.filter(id => !removed.includes(id))),
      'Cleanup installed image inventory drift');
    return snapshot;
  }
  if (journal === null) {
    const initial = expect(readSnapshot(), []);
    journal = { schemaVersion: 1, inventoryHash, infraSha, protection: initial.protection,
      installedImageIds: initial.imageIds, removedImageIds: [], inFlightImageId: null, completed: false };
    writeJournal(journal);
  } else {
    exactKeys(journal, ['schemaVersion', 'inventoryHash', 'infraSha', 'protection', 'installedImageIds', 'removedImageIds', 'inFlightImageId', 'completed']);
    validateProtection(journal.protection);
    check(journal.schemaVersion === 1 && journal.inventoryHash === inventoryHash && journal.infraSha === infraSha &&
      Array.isArray(journal.removedImageIds) && isDeepStrictEqual(journal.removedImageIds, ids.slice(0, journal.removedImageIds.length)) &&
      Array.isArray(journal.installedImageIds) && journal.installedImageIds.every(id => imageId.test(id)) &&
      new Set(journal.installedImageIds).size === journal.installedImageIds.length &&
      isDeepStrictEqual(journal.installedImageIds, sorted(journal.installedImageIds)) && ids.every(id => journal.installedImageIds.includes(id)) &&
      journal.removedImageIds.length <= ids.length && typeof journal.completed === 'boolean' &&
      (journal.inFlightImageId === null || imageId.test(journal.inFlightImageId) && journal.inFlightImageId === ids[journal.removedImageIds.length]) &&
      (!journal.completed || (journal.removedImageIds.length === ids.length && journal.inFlightImageId === null)),
      'Invalid cleanup journal or reviewed identity');
  }
  if (journal.inFlightImageId) {
    const current = readSnapshot();
    if (current.inventory.candidates.some(item => item.imageId === journal.inFlightImageId))
      expect(current, journal.removedImageIds, journal.protection, journal.installedImageIds);
    else {
      expect(current, [...journal.removedImageIds, journal.inFlightImageId], journal.protection, journal.installedImageIds);
      journal = { ...journal, removedImageIds: [...journal.removedImageIds, journal.inFlightImageId], inFlightImageId: null };
      writeJournal(journal);
    }
  }
  for (const id of ids.slice(journal.removedImageIds.length)) {
    expect(readSnapshot(), journal.removedImageIds, journal.protection, journal.installedImageIds);
    journal = { ...journal, inFlightImageId: id };
    writeJournal(journal);
    // No force and no implicit deletion of unapproved dangling parent images.
    runDocker(['image', 'rm', '--no-prune', id]);
    expect(readSnapshot(), [...journal.removedImageIds, id], journal.protection, journal.installedImageIds);
    journal = { ...journal, removedImageIds: [...journal.removedImageIds, id], inFlightImageId: null };
    writeJournal(journal);
  }
  const after = expect(readSnapshot(), journal.removedImageIds, journal.protection, journal.installedImageIds);
  journal = { ...journal, completed: true };
  writeJournal(journal);
  return { schemaVersion: 1, mode: 'REVIEWED_CLEANUP', inventoryHash, infraSha,
    removedImageIds: journal.removedImageIds, protection: journal.protection,
    inventory: normalizeInventory(after.inventory), installedImageIds: after.imageIds, diskUsage: diskUsage() };
}
function privateRead(file) {
  const stat = fs.lstatSync(file);
  check(stat.isFile() && !stat.isSymbolicLink() && fs.realpathSync(file) === file &&
    (stat.mode & 0o777) === 0o600 && stat.uid === process.getuid(), 'Unsafe cleanup journal metadata');
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}
function atomicJson(file, value) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  const fd = fs.openSync(temporary, 'wx', 0o600);
  try { fs.writeFileSync(fd, JSON.stringify(value, null, 2) + '\n'); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(temporary, file);
  const directory = fs.openSync(path.dirname(file), 'r');
  try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
}
function hostDiskUsage() {
  const dockerRoot = dockerInventory(['info', '--format', '{{.DockerRootDir}}']);
  check(dockerRoot.startsWith('/') && fs.realpathSync(dockerRoot) === dockerRoot, 'Unsafe Docker data directory');
  const directories = new Set([root, dockerRoot]);
  if (fs.existsSync('/var/lib/containerd')) directories.add('/var/lib/containerd');
  return Object.fromEntries([...directories].sort().map(directory => {
    const stat = fs.statfsSync(directory, { bigint: true });
    return [directory, { totalBytes: String(stat.blocks * stat.bsize), availableBytes: String(stat.bavail * stat.bsize),
      freeBytes: String(stat.bfree * stat.bsize) }];
  }));
}
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  try {
    assert.equal(process.platform, 'linux'); assert.equal(fs.realpathSync('.'), root);
    const args = process.argv.slice(2);
    if (args[0] !== '--locked') {
      const child = spawnSync('flock', ['-n', `${root}/release.lock`, process.execPath, fileURLToPath(import.meta.url), '--locked', ...args],
        { stdio: 'inherit', env: process.env });
      process.exit(child.status ?? 1);
    }
    args.shift(); check(args.length === 2, 'Cleanup requires exact infra SHA and reviewed inventory hash');
    const [infraSha, inventoryHash] = args;
    check(sha.test(infraSha) && hash.test(inventoryHash), 'Invalid cleanup identities');
    const stage = fs.realpathSync(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
    check(stage.startsWith(`${root}/releases/staging/`) && process.env.INFRA_SHA === infraSha, 'Cleanup must use reviewed per-run infrastructure');
    const bytes = fs.readFileSync(`${stage}/scripts/backend-image-cleanup-reviewed.json`);
    check(digest(bytes) === inventoryHash, 'Reviewed cleanup artifact hash mismatch');
    const directory = `${root}/releases/backend-image-cleanup`;
    fs.mkdirSync(directory, { mode: 0o700, recursive: true });
    const stat = fs.lstatSync(directory);
    check(stat.isDirectory() && !stat.isSymbolicLink() && fs.realpathSync(directory) === directory &&
      (stat.mode & 0o777) === 0o700 && stat.uid === process.getuid(), 'Unsafe cleanup journal directory');
    const journalFile = `${directory}/${inventoryHash}.json`;
    const report = runImageCleanup({ approved: JSON.parse(bytes), inventoryHash, infraSha,
      readSnapshot: () => collectImageSnapshot({ validateStateFn: validateState, validatePendingFn: validatePending }),
      readJournal: () => {
        try { fs.lstatSync(journalFile); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
        return privateRead(journalFile);
      },
      writeJournal: value => atomicJson(journalFile, value), runDocker: dockerInventory, diskUsage: hostDiskUsage });
    atomicJson(`${directory}/${inventoryHash}.report.json`, report);
    console.log(JSON.stringify(report, null, 2));
  } catch (error) { console.error(`Reviewed image cleanup failed: ${error.message}`); process.exitCode = 1; }
}
