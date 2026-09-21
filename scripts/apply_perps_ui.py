import subprocess, sys, re

head = subprocess.check_output(
    ['git', 'show', 'HEAD:public/index.html'], cwd='/Users/buzzkillb/Desktop/Projects/trade'
).decode('utf-8')

def once(s, old, new, label):
    n = s.count(old)
    if n != 1:
        sys.exit(f'FAIL {label}: found {n} occurrences of anchor')
    return s.replace(old, new, 1)

# 1) nav tab
head = once(head, '    <div class="tab" data-tab="memes">Memes</div>\n    <div class="tab" data-tab="history">History</div>',
            '    <div class="tab" data-tab="memes">Memes</div>\n    <div class="tab" data-tab="perps">Perps</div>\n    <div class="tab" data-tab="history">History</div>',
            'nav')

# 2) panel block
panel = '''  <!-- /memes -->
  <!-- ============ PERPS SLEEVE ============ -->
  <div class="tab-panel" id="panel-perps">
    <div class="section">
      <h2>Perps Sleeve <span class="muted">profit-funded · risk-isolated leverage overlay</span></h2>
      <div id="perpsBanner" class="muted"></div>
      <div class="row2">
        <div class="card"><div class="k">Status</div><div class="v" id="pStatus">\u2014</div></div>
        <div class="card"><div class="k">Venue mark (SOL)</div><div class="v" id="pMark">\u2014</div></div>
      </div>
      <div class="row2">
        <div class="card"><div class="k">High-water mark</div><div class="v" id="pHwm">\u2014</div></div>
        <div class="card"><div class="k">Eligible profit</div><div class="v" id="pElig">\u2014</div></div>
      </div>
      <div class="row2">
        <div class="card"><div class="k">Sleeve budget</div><div class="v" id="pBudget">\u2014</div></div>
        <div class="card"><div class="k">Edge vs equity</div><div class="v" id="pEdge">\u2014</div></div>
      </div>
      <div class="row2">
        <div class="card"><div class="k">Grid net-long</div><div class="v" id="pGridLong">\u2014</div></div>
        <div class="card"><div class="k">Exposure</div><div class="v" id="pExposure">\u2014</div></div>
      </div>
      <div class="row2">
        <div class="card"><div class="k">Position</div><div class="v" id="pPosition">\u2014</div></div>
        <div class="card"><div class="k">Liquidation buffer</div><div class="v" id="pLiq">\u2014</div></div>
      </div>
      <div class="row2">
        <div class="card"><div class="k">Sleeve realized PnL</div><div class="v" id="pPnl">\u2014</div></div>
        <div class="card"><div class="k">Sleeve fees</div><div class="v" id="pFees">\u2014</div></div>
      </div>
      <div class="card" style="margin-top:12px">
        <div class="k">Last decision</div>
        <div class="v" id="pDecision" style="font-size:14px">\u2014</div>
      </div>
    </div>
    <div class="section">
      <h2>Perps Ledger Tape <span class="muted">open / close / halt / reject</span></h2>
      <table id="perpsLedgerTable"><thead><tr><th>Time</th><th>Kind</th><th>Side</th><th>Collateral</th><th>Notional</th><th>PnL</th><th>Price</th><th>Note</th></tr></thead><tbody></tbody></table>
    </div>
  </div>
  <!-- /perps -->
  <!-- ============ HISTORY ============ -->'''
head = once(head, '  <!-- /memes -->\n  <!-- ============ HISTORY ============ -->', panel, 'panel')

# 3) render call
head = once(head, '    safe(() => renderMemes(s));',
            '    safe(() => renderMemes(s));\n    safe(() => renderPerps(s));', 'rendercall')

# 4) renderer functions before renderHistory
renderers = '''  // ============ PERPS SLEEVE ============
  // Renders the profit-funded leverage sleeve: budget, hedge exposure, open
  // position, and the isolated ledger tape. Read-only; the sleeve's own ledger
  // file is the source of truth and lives in a namespace separate from the spot book.
  function renderPerps(s) {
    const p = (s.strategies && s.strategies.perps) || {};
    const money = (v) => (v < 0 ? '-$' : '$') + fmt(Math.abs(v || 0), 2);
    const pctv = (v) => ((v || 0) * 100).toFixed(1) + '%';
    const set = (id, txt, cls) => {
      const el = $(id);
      if (!el) return;
      el.textContent = txt;
      el.className = 'v' + (cls ? ' ' + cls : '');
    };

    const enabled = !!p.enabled;
    const halted = !!p.halted;
    let statusCls = enabled ? '' : 'muted';
    let statusTxt = enabled ? 'ENABLED' : 'DISABLED (PERPS_ENABLED not set)';
    if (halted) { statusCls = 'neg'; statusTxt = 'HALTED \u2014 ' + (p.haltReason || 'loss ceiling'); }

    const banner = $('perpsBanner');
    if (banner) {
      banner.textContent = halted
        ? '\u26d4 Sleeve halted: ' + (p.haltReason || '') + '. No new margin deployed; the spot book is unaffected.'
        : 'Funded ONLY by profit above the high-water mark \u2014 base spot capital is never at risk. ' +
          'Budget goes to $0 the moment equity is at/below the mark.';
      banner.className = halted ? 'neg' : 'muted';
    }

    set('pStatus', statusTxt, statusCls);
    set('pMark', p.markHealthy ? '$' + fmt(p.markPrice, 2) : 'n/a' + (p.feedRejectReason ? ' (' + p.feedRejectReason + ')' : ''), p.markHealthy ? '' : 'muted');
    set('pHwm', money(p.highWaterMarkUsd));
    set('pElig', money(p.eligibleProfitUsd));
    set('pBudget', money(p.sleeveBudgetUsd), p.sleeveBudgetUsd > 0 ? 'pos' : 'muted');
    set('pEdge', pctv(p.edgePct));
    set('pGridLong', money(p.gridNetLongUsd));
    set('pExposure', pctv(p.exposurePct), p.exposurePct >= 0.15 ? 'warn' : '');
    set('pPnl', money(p.realizedPnlUsd), p.realizedPnlUsd >= 0 ? 'pos' : 'neg');
    set('pFees', money(p.feesPaidUsd), 'muted');

    const o = p.open;
    if (o) {
      set('pPosition', o.side.toUpperCase() + ' ' + o.leverage + 'x \u00b7 $' + fmt(o.collateralUsd, 2) + ' margin \u00b7 $' + fmt(o.notionalUsd, 2) + ' notional');
      const bufCls = p.liquidationBufferPct > 0.15 ? 'pos' : (p.liquidationBufferPct > 0 ? 'warn' : 'neg');
      set('pLiq', pctv(p.liquidationBufferPct) + ' to liq @ $' + fmt(o.liquidationPriceUsd, 2), bufCls);
    } else {
      set('pPosition', p.hedgeActive ? 'hedge active' : 'flat', 'muted');
      set('pLiq', '\u2014', 'muted');
    }

    const dec = $('pDecision');
    if (dec) {
      dec.textContent = p.lastDecision || '\u2014';
      dec.className = 'v' + (/reject|halt|disabled/.test(p.lastDecision || '') ? ' muted' : '');
    }

    renderPerpsLedger();
  }

  async function renderPerpsLedger() {
    try {
      const res = await fetch('/api/perps/ledger');
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const j = await res.json();
      const rows = (j.history || []).slice().reverse();
      const tb = $('perpsLedgerTable').querySelector('tbody');
      const money = (v) => (v == null ? '\u2014' : (v < 0 ? '-$' : '$') + fmt(Math.abs(v), 2));
      tb.innerHTML = rows.map((r) => {
        const t = new Date(r.ts).toLocaleTimeString('en-US');
        const cls = r.kind === 'halt' || r.kind === 'reject' ? 'neg' : (r.pnlUsd > 0 ? 'pos' : '');
        return `<tr class="${cls}"><td>${t}</td><td>${r.kind}</td><td>${r.side || '\u2014'}</td><td>${money(r.collateralUsd)}</td><td>${money(r.notionalUsd)}</td><td>${money(r.pnlUsd)}</td><td>${r.price ? '$' + fmt(r.price, 2) : '\u2014'}</td><td class="muted">${r.note || ''}</td></tr>`;
      }).join('') || '<tr><td colspan="8" class="muted">No perps activity yet.</td></tr>';
    } catch (e) {
      console.warn('[dash] perps ledger load failed: ' + (e && e.message));
    }
  }

  function renderHistory() {'''
head = once(head, '  function renderHistory() {', renderers, 'renderers')

open('/Users/buzzkillb/Desktop/Projects/trade/public/index.html', 'w').write(head)
print('lines:', head.count('\n') + 1)
for pat in ['renderPerps(s)', 'panel-perps', 'async function loadAudit()', 'connect();']:
    print(pat, '->', head.count(pat))
