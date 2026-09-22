import 'dotenv/config';
import { loadConfig } from '../src/config.js';
import { StateStore } from '../src/store.js';
import { PerpSleeve } from '../src/perpSleeve.js';

const cfg = loadConfig();
const store = new StateStore(cfg);
const sleeve = new PerpSleeve(cfg, store);
const v = sleeve.view();
console.log('perps enabled:', v.enabled);
console.log('dashboard budgetUsd:', v.sleeveBudgetUsd.toFixed(2));
console.log('SPOT CLAIM (what grid/DCA subtract):', sleeve.spotClaimUsd().toFixed(2));
console.log(v.enabled ? '-> claim should equal budget' : '-> perps OFF: claim MUST be 0');
