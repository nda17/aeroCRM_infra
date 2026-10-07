import test from 'node:test';
import assert from 'node:assert/strict';
import { runReleaseTransaction } from './backend-release-transaction.mjs';

function fixture({ failAt = null, rollbackFails = false, compatibilityRequiresRollback = false,
  validatePreviousFails = false, forwardOnly = false } = {}) {
  const calls = [];
  let committed = false;
  const action = name => () => {
    calls.push(name);
    if (name === 'commit') committed = true;
    if (name === failAt) throw new Error(`${name} fixture failure`);
  };
  const compatibility = () => {
    calls.push('compatibility');
    if (failAt === 'compatibility') {
      const error = new Error('compatibility fixture failure');
      if (compatibilityRequiresRollback) error.requiresRollback = true;
      throw error;
    }
  };
  const validatePrevious = () => {
    calls.push('validatePrevious');
    if (validatePreviousFails) throw new Error('previous runtime is incompatible');
  };
  return { calls, actions: {
    migrate: action('migrate'), compatibility,
    applyConfiguration: action('applyConfiguration'), switchImages: action('switchImages'),
    validateTarget: action('validateTarget'), commit: action('commit'), project: action('project'),
    clearPending: action('clearPending'), report: action('report'), isCommitted: () => committed,
    validatePrevious,
    rollback: () => { calls.push('rollback'); if (rollbackFails) throw new Error('rollback guard failure'); },
    forwardOnly: () => forwardOnly,
    blockRollback: action('blockRollback'), startWriters: action('startWriters')
  } };
}

test('successful release orders compatibility checks, image switch, readiness, commit, and projection', () => {
  const { actions, calls } = fixture();
  assert.deepEqual(runReleaseTransaction(actions), { status: 'committed' });
  assert.deepEqual(calls, ['migrate', 'compatibility', 'applyConfiguration', 'switchImages',
    'validateTarget', 'commit', 'project', 'clearPending']);
});

test('pre-switch failure validates the previous runtime and clears pending only after safe recovery', () => {
  const { actions, calls } = fixture({ failAt: 'compatibility' });
  assert.equal(runReleaseTransaction(actions).status, 'preflight-failed');
  assert.deepEqual(calls, ['migrate', 'compatibility', 'report', 'validatePrevious', 'clearPending']);
});

test('compatibility error requiring rollback uses the guarded full rollback path without directly restarting writers', () => {
  const { actions, calls } = fixture({ failAt: 'compatibility', compatibilityRequiresRollback: true });
  assert.equal(runReleaseTransaction(actions).status, 'rolled-back');
  assert.deepEqual(calls, ['migrate', 'compatibility', 'report', 'rollback', 'clearPending']);
  assert(!calls.includes('validatePrevious'));
  assert(!calls.includes('startWriters'));
});

test('unverifiable previous runtime blocks recovery and leaves the pending marker in place', () => {
  const { actions, calls } = fixture({ failAt: 'compatibility', validatePreviousFails: true });
  assert.equal(runReleaseTransaction(actions).status, 'rollback-blocked');
  assert.deepEqual(calls, ['migrate', 'compatibility', 'report', 'validatePrevious', 'blockRollback']);
  assert(!calls.includes('clearPending'));
});

test('failure after partial configuration, image switch, or readiness validation rolls back the whole selected release', () => {
  for (const failAt of ['applyConfiguration', 'switchImages', 'validateTarget']) {
    const { actions, calls } = fixture({ failAt });
    assert.equal(runReleaseTransaction(actions).status, 'rolled-back', failAt);
    assert.deepEqual(calls.slice(-2), ['rollback', 'clearPending'], failAt);
    assert(calls.includes('rollback'), `rollback was not invoked after ${failAt}`);
    assert(!calls.includes('project'), `uncommitted ${failAt} release must not project state`);
  }
});

test('migration failure requests rollback even before the image switch begins', () => {
  const { actions, calls } = fixture({ failAt: 'migrate' });
  assert.equal(runReleaseTransaction(actions, { migrationRequested: true }).status, 'rolled-back');
  assert(calls.includes('rollback'));
  assert(!calls.includes('validatePrevious'), 'database migration means old runtime alone cannot certify recovery');
});

test('projection failure after durable commit leaves release committed for marker repair without image rollback', () => {
  const { actions, calls } = fixture({ failAt: 'project' });
  assert.equal(runReleaseTransaction(actions).status, 'projection-repair-required');
  assert(calls.includes('commit'));
  assert(!calls.includes('rollback'));
  assert(!calls.includes('clearPending'), 'pending marker remains until state projection is repaired');
});

test('failed rollback compatibility guard blocks rollback and preserves the pending marker', () => {
  const { actions, calls } = fixture({ failAt: 'validateTarget', rollbackFails: true });
  assert.equal(runReleaseTransaction(actions).status, 'rollback-blocked');
  assert(calls.includes('blockRollback'));
  assert(!calls.includes('clearPending'));
});

test('forward-only storage journal blocks every previous-state recovery path', () => {
  for (const failAt of ['migrate', 'compatibility', 'applyConfiguration', 'switchImages', 'validateTarget']) {
    const { actions, calls } = fixture({ failAt, forwardOnly: true });
    assert.equal(runReleaseTransaction(actions, { migrationRequested: failAt === 'migrate' }).status, 'fix-forward-required', failAt);
    assert(calls.includes('blockRollback'), failAt);
    assert(!calls.includes('rollback'), failAt);
    assert(!calls.includes('validatePrevious'), failAt);
    assert(!calls.includes('clearPending'), failAt);
  }
});
