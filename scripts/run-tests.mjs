// Portable test runner.
//
// `node --test test/*.test.ts` relies on the shell to expand the glob, which
// cmd.exe on Windows does not do, and Node 20's test runner does not glob on
// its own (that arrived in Node 21). This lists the test files itself and
// passes them explicitly, so `npm test` behaves the same on every platform.
//
// `--experimental-detect-module` is needed because @pump-fun/pump-swap-sdk
// ships its ESM build without a "type": "module" marker; without the flag
// Node 20 treats it as CommonJS and the named imports in src/pumpSwap.ts fail
// (Node 22.7+ detects the syntax by default, so the flag is a no-op there).
//
//   npm test           run every test/*.test.ts
//   npm run test:live  run test/live.test.ts with RUN_LIVE_TX_TESTS=1
import { readdirSync, mkdtempSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const live = process.argv.includes('--live');

// ---------------------------------------------------------------------------
// STATE ISOLATION — tests must NEVER touch the real .botstate.
// ---------------------------------------------------------------------------
// A test that books a fill through the store would otherwise append it to the
// live journal (trades-live.jsonl) and emit fake events into events.log,
// polluting tracking/accounting with synthetic "test-sell" rows. Point every
// state path at a throwaway temp dir for the whole run, then delete it.
const testStateDir = mkdtempSync(path.join(os.tmpdir(), 'gridlord-test-state-'));

const files = live
  ? ['test/live.test.ts']
  : readdirSync(path.join(root, 'test'))
      .filter((f) => f.endsWith('.test.ts'))
      .sort()
      .map((f) => path.join('test', f));

const env = {
  ...process.env,
  // Isolate all persistent state into the temp dir so tests cannot pollute the
  // real journal, event log, history rollups, or bot state files.
  BOT_STATE_DIR: testStateDir,
  PERP_STATE_DIR: testStateDir,
};
if (live) env.RUN_LIVE_TX_TESTS = '1';

let status = 1;
try {
  const result = spawnSync(
    process.execPath,
    ['--experimental-detect-module', '--import', 'tsx', '--test', ...files],
    { cwd: root, env, stdio: 'inherit' }
  );
  status = result.status ?? 1;
} finally {
  try { rmSync(testStateDir, { recursive: true, force: true }); } catch { /* best-effort */ }
}
process.exit(status);
