#!/usr/bin/env node
// GLB watchdog — zombie-process detector for the LIVE bot only.
// Scope: GET /api/state, classify health, `launchctl kickstart` when the
// process is dead/hung. No trading logic. Two powers: HTTP GET, launchctl.
//
// Classification:
//   ok          — HTTP 200 and price stamp fresh            -> nothing
//   stale-feed  — HTTP 200 but price old                    -> nothing (bot's
//                 circuit-breaker owns feed recovery; log-only)
//   dead/hung   — fetch error / non-200 / timeout           -> count misses;
//                 N consecutive -> kickstart (budget-capped, notify)
//
// Dry-run default: WATCHDOG_DRY_RUN=1 logs decisions without restarting.
import { readFileSync, appendFileSync, mkdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url));
const cfgPath = join(here, 'watchdog.config.json');
let cfg = {};
try { cfg = JSON.parse(readFileSync(cfgPath, 'utf8')); } catch { /* defaults */ }

const env = (k, d) => process.env[k] ?? cfg[k] ?? d;
const DRY = String(env('WATCHDOG_DRY_RUN', '1')) === '1';
const STATE_URL = env('WATCHDOG_STATE_URL', 'http://127.0.0.1:3000/api/state');
const LABEL = env('WATCHDOG_LABEL', 'com.buzzkillb.glb');
const POLL_MS = Number(env('WATCHDOG_POLL_S', 20)) * 1000;
const FAILS_TO_ACT = Number(env('WATCHDOG_FAILS', 3));
const PRICE_STALE_S = Number(env('WATCHDOG_PRICE_STALE_S', 180));
const MAX_RESTARTS_HR = Number(env('WATCHDOG_MAX_RESTARTS_HR', 5));
const HTTP_TIMEOUT_MS = Number(env('WATCHDOG_HTTP_TIMEOUT_MS', 4000));
const LOG = join(here, 'watchdog.log');

mkdirSync(here, { recursive: true });
const log = (m) => {
  const line = `[${new Date().toISOString()}] ${m}`;
  console.log(line);
  try { appendFileSync(LOG, line + '\n'); } catch { /* best effort */ }
};

let fails = 0;
const restarts = [];
function budgetLeft() {
  const now = Date.now();
  while (restarts.length && now - restarts[0] > 3600_000) restarts.shift();
  return MAX_RESTARTS_HR - restarts.length;
}

export async function classify(now = Date.now()) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), HTTP_TIMEOUT_MS);
  try {
    const r = await fetch(STATE_URL, { signal: ctl.signal });
    if (!r.ok) return { state: 'hung', detail: `HTTP ${r.status}` };
    const s = await r.json();
    if (typeof s?.ts === 'number') {
      const age = (now - s.ts) / 1000;
      if (age > PRICE_STALE_S) return { state: 'stale-feed', detail: `price age ${age | 0}s` };
    }
    return { state: 'ok', detail: '' };
  } catch (e) {
    return { state: 'dead', detail: e?.name === 'AbortError' ? 'timeout' : String(e.message || e) };
  } finally { clearTimeout(t); }
}

function kickstart() {
  try {
    execFileSync('/bin/launchctl', ['kickstart', '-k', `gui/${process.getuid()}/${LABEL}`]);
    return true;
  } catch (e) { log(`kickstart failed: ${e.message}`); return false; }
}

export function makeTick(deps = {}) {
  const now = () => deps.now?.() ?? Date.now();
  const kick = deps.kickstart ?? kickstart;
  const notify = deps.notify ?? ((...a) => log(...a));
  return async function tick() {
    const { state, detail } = await classify(now());
    if (state === 'ok') { if (fails) notify(`recovered after ${fails} miss(es)`); fails = 0; return 'ok'; }
    if (state === 'stale-feed') { fails = 0; return 'stale-feed'; } // never restart for feed
    fails += 1;
    if (fails < FAILS_TO_ACT) return `miss ${fails}/${FAILS_TO_ACT} (${state}: ${detail})`;
    if (budgetLeft() <= 0) { notify(`restart budget exhausted (${MAX_RESTARTS_HR}/h) — NEEDS HUMAN`); return 'budget-exhausted'; }
    restarts.push(now());
    const msg = `${state} x${fails} (${detail}) -> ${DRY ? 'WOULD kickstart' : 'kickstarting'} ${LABEL}`;
    notify(msg);
    if (!DRY) kick();
    return DRY ? 'would-restart' : 'restarted';
  };
}

if (process.argv[1] && statSync(process.argv[1]).ino === statSync(fileURLToPath(import.meta.url)).ino) {
  log(`watchdog start dryRun=${DRY} url=${STATE_URL} label=${LABEL} poll=${POLL_MS / 1000}s fails=${FAILS_TO_ACT}`);
  const tick = makeTick();
  setInterval(tick, POLL_MS);
  void tick(); // immediate first pass
}
