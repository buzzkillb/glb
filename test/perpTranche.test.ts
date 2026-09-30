import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { planHedgeTranche } from '../src/perpStrategy.js';

// Base ctx: winning short, 1000 collateral, floor 25% / ceiling 60%.
const base = {
  netPnlUsd: 300, // above the 29% dynamic target (floor 25% + 2% trend x2)
  collateralUsd: 1000,
  entryPriceUsd: 120,
  markPriceUsd: 117.6, // 2% favourable move
  profitable: true,
  vol24RangePct: 0.05, // 5% range; 2% move < 5% -> not exhausted by range
  momentum24HPct: -0.02, // still falling -> not exhausted by momentum
  minTakeProfitPct: 0.25,
  maxTakeProfitPct: 0.6,
  volFactor: 1,
};

describe('planHedgeTranche (scaled take-profit)', () => {
  it('holds when the dynamic target is not yet reached', () => {
    const t = planHedgeTranche({ ...base, netPnlUsd: 100, bankFraction: 0.5 });
    assert.equal(t.action, 'hold');
    assert.equal(t.fraction, 0);
  });

  it('banks tranche A at the configured fraction on the first fire', () => {
    const t = planHedgeTranche({ ...base, bankFraction: 0.5 });
    assert.equal(t.action, 'partial');
    assert.equal(t.fraction, 0.5);
  });

  it('with tranches=1 (A done), demands the CEILING before the final close', () => {
    // PnL at floor level only: legacy/min-target would fire, tranche B must not.
    const t = planHedgeTranche({ ...base, bankedTranches: 1, bankFraction: 0.5 });
    assert.equal(t.action, 'hold', 'floor-level pnl must not close tranche B');
    // At ceiling level (60% of margin = 600): fires fully.
    const t2 = planHedgeTranche({ ...base, netPnlUsd: 600, bankedTranches: 1, bankFraction: 0.5 });
    assert.equal(t2.action, 'bank');
    assert.equal(t2.fraction, 1);
  });

  it('exhaustion closes the remainder directly (B fires via exhausted-floor path)', () => {
    // Momentum flipped positive while profitable -> exhausted -> floor target.
    const t = planHedgeTranche({
      ...base,
      netPnlUsd: 260,
      momentum24HPct: 0.01,
      bankedTranches: 1,
      bankFraction: 0.5,
    });
    assert.equal(t.action, 'bank');
    assert.equal(t.fraction, 1);
    assert.equal(t.exhausted, true);
  });

  it('bankFraction 0 or 1 collapses to legacy all-at-once', () => {
    for (const bf of [0, 1]) {
      const t = planHedgeTranche({ ...base, bankFraction: bf });
      assert.equal(t.action, 'bank');
      assert.equal(t.fraction, 1);
    }
  });

  it('bankedTranches >= 2 is treated as fully banked (clamp guard): no partial re-fire', () => {
    // tranches clamps to 2 -> wantCeiling stays armed, and a second PARTIAL
    // must never happen (tranches===0 gate). At ceiling-level pnl it closes all.
    const t = planHedgeTranche({ ...base, bankFraction: 0.5, bankedTranches: 2, netPnlUsd: 620 });
    assert.equal(t.action, 'bank');
    assert.equal(t.fraction, 1);
    // Below ceiling it must hold, not fire a second partial at floor logic.
    const h = planHedgeTranche({ ...base, bankFraction: 0.5, bankedTranches: 2, netPnlUsd: 300 });
    assert.equal(h.action, 'hold');
  });

  it('disabled take-profit (floor 0) holds regardless', () => {
    const t = planHedgeTranche({ ...base, minTakeProfitPct: 0, bankFraction: 0.5 });
    assert.equal(t.action, 'hold');
  });
});
