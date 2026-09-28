// Synchronous release transaction with injected host operations for failure fixtures.
export function runReleaseTransaction(actions, { migrationRequested = false } = {}) {
  let switchStarted = false;
  let committed = false;
  try {
    actions.migrate();
    actions.compatibility();
    switchStarted = true;
    actions.applyConfiguration();
    actions.switchImages();
    actions.validateTarget();
    actions.commit();
    committed = true;
    actions.project();
    actions.clearPending();
    return { status: 'committed' };
  } catch (error) {
    actions.report(error);
    if (committed || actions.isCommitted()) return { status: 'projection-repair-required', error };
    if (!switchStarted && !migrationRequested && !error.requiresRollback) {
      try { actions.validatePrevious(); } catch (validationError) {
        actions.blockRollback(validationError);
        return { status: 'rollback-blocked', error, rollbackError: validationError };
      }
      actions.clearPending();
      return { status: 'preflight-failed', error };
    }
    try {
      // The callback validates the complete previous image set and persisted database compatibility
      // before restoring its configuration; it never rolls the database back.
      actions.rollback();
      actions.clearPending();
      return { status: 'rolled-back', error };
    } catch (rollbackError) {
      actions.blockRollback(rollbackError);
      return { status: 'rollback-blocked', error, rollbackError };
    }
  }
}
