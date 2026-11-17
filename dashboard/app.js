// Token Launch Radar — renders window.RADAR into the board, filters and detail view.
// No network, no framework: plain DOM from the generated data.js.
(function () {
  'use strict';
  var R = window.RADAR;
  if (!R) { document.body.textContent = 'No radar data loaded.'; return; }

  function esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function money(n) {
    if (n >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
    if (n >= 1e6) return '$' + (n / 1e6).toFixed(1) + 'M';
    if (n >= 1e3) return '$' + (n / 1e3).toFixed(1) + 'K';
    if (n >= 10) return '$' + n.toFixed(0);
    if (n >= 0) return '$' + n.toFixed(2);
    return '-$' + Math.abs(n).toFixed(2);
  }
  function signed(n, digits) { return (n >= 0 ? '+' : '') + n.toFixed(digits === undefined ? 2 : digits); }
  function ageText(days) {
    if (days >= 365) return (days / 365).toFixed(1) + 'y';
    return days + 'd';
  }
  function $(id) { return document.getElementById(id); }

  // ---- headline stats ----
  var watchRows = R.rows.filter(function (r) { return r.watchlist; });
  $('headline-stats').innerHTML =
    '<div><dt>Board rows</dt><dd>' + R.rows.length + '</dd></div>' +
    '<div><dt>Watchlist</dt><dd>' + watchRows.length + ' / ' + R.watchlistCount + '</dd></div>' +
    '<div><dt>Total implied</dt><dd>' + money(R.totalImplied) + '</dd></div>';
  $('as-of').textContent = R.asOf;

  // ---- validation panel: the fitted formula and the held-out numbers ----
  var m = R.model, v = R.validation;
  $('validation').innerHTML =
    '<h2>How the value is fitted — and how it holds up out of sample</h2>' +
    '<div class="formula">log10(mcap / TVL) = ' + m.level.toFixed(3) +
    ' + (' + m.sizeSlope.toFixed(3) + ' × (log10 TVL − 8))' +
    ' + (' + m.chainsCoef.toFixed(3) + ' × (min(chains, 5) − 1))' +
    ' + family effect</div>' +
    '<p>Fitted at run time from ' + m.comps + ' live-token comparables in ' + m.families +
    ' categories, by Huber-robust regression (c = ' + m.huberC + '), with each category effect shrunk ' +
    'by n / (n + ' + m.shrinkK + '). The target is clipped to [' + m.clipLo + ', ' + m.clipHi +
    '] in log10, so dead-token records cannot drag the line. Implied value = TVL × 10<sup>pred</sup> × growth × age.</p>' +
    '<dl class="validation-grid">' +
    '<div><dt>Leave-one-out</dt><dd>×' + v.loo.toFixed(2) + '<small>typical factor off; flat median ×' + v.flatLoo.toFixed(2) + '</small></dd></div>' +
    '<div><dt>Time split</dt><dd>×' + v.oos.toFixed(2) + '<small>fit on ' + v.oosTrain + ' pre-Jun-2024, tested on ' + v.oosTest + '</small></dd></div>' +
    '<div><dt>5-fold CV</dt><dd>×' + v.cv5.toFixed(2) + '<small>seeded folds over all comps</small></dd></div>' +
    '<div><dt>Full pipeline</dt><dd>×' + v.pipe.toFixed(2) + '<small>leave-one-out incl. growth × age</small></dd></div>' +
    '<div><dt>Size slope (90%)</dt><dd>' + v.slopeP5.toFixed(2) + ' … ' + v.slopeP95.toFixed(2) + '<small>bootstrap, 200 resamples</small></dd></div>' +
    '</dl>' +
    '<p>Each row also carries a P25–P75 range from the leave-one-out residuals (×' + m.bandLo.toFixed(2) +
    ' to ×' + m.bandHi.toFixed(2) + '), so the board states its own uncertainty.</p>';

  // ---- filter controls ----
  var categories = [];
  R.rows.forEach(function (r) { if (categories.indexOf(r.category) < 0) categories.push(r.category); });
  categories.sort();
  var chains = [];
  R.rows.forEach(function (r) { r.chains.forEach(function (c) { if (chains.indexOf(c) < 0) chains.push(c); }); });
  chains.sort();
  categories.forEach(function (c) {
    var o = document.createElement('option'); o.value = c; o.textContent = c; $('category').appendChild(o);
  });
  chains.forEach(function (c) {
    var o = document.createElement('option'); o.value = c; o.textContent = c; $('chain').appendChild(o);
  });

  var sortKey = 'rank', sortDir = 1;
  function filteredRows() {
    var q = $('q').value.trim().toLowerCase();
    var cat = $('category').value, ch = $('chain').value, wl = $('watchlist-only').checked;
    return R.rows.filter(function (r) {
      if (q && r.name.toLowerCase().indexOf(q) < 0 && r.slug.indexOf(q) < 0) return false;
      if (cat && r.category !== cat) return false;
      if (ch && r.chains.indexOf(ch) < 0) return false;
      if (wl && !r.watchlist) return false;
      return true;
    });
  }
  function renderBoard() {
    var rows = filteredRows().slice();
    rows.sort(function (a, b) {
      var av = a[sortKey], bv = b[sortKey];
      if (typeof av === 'string') return sortDir * av.localeCompare(bv);
      return sortDir * (av - bv);
    });
    $('board-body').innerHTML = rows.map(function (r) {
      var netCls = r.farm_net_usd >= 0 ? 'pos' : 'neg';
      return '<tr data-slug="' + esc(r.slug) + '"><td>' + r.rank + '</td>' +
        '<td>' + esc(r.name) + (r.watchlist ? ' <span class="watch" title="On the watchlist">★</span>' : '') + '</td>' +
        '<td>' + esc(r.category) + '</td>' +
        '<td class="num">' + money(r.tvl_usd) + '</td>' +
        '<td class="num"><strong>' + money(r.implied_value_usd) + '</strong></td>' +
        '<td class="num ' + netCls + '">' + money(r.farm_net_usd) + '</td>' +
        '<td class="num">' + ageText(r.age_days) + '</td></tr>';
    }).join('');
    $('count').textContent = rows.length + ' of ' + R.rows.length + ' rows';
  }
  document.querySelectorAll('#board-table th[data-sort]').forEach(function (th) {
    th.addEventListener('click', function () {
      var key = th.getAttribute('data-sort');
      if (sortKey === key) { sortDir = -sortDir; } else { sortKey = key; sortDir = key === 'name' || key === 'category' ? 1 : -1; }
      renderBoard();
    });
  });
  ['q', 'category', 'chain', 'watchlist-only'].forEach(function (id) {
    $(id).addEventListener('input', renderBoard);
    $(id).addEventListener('change', renderBoard);
  });
  $('board-body').addEventListener('click', function (ev) {
    var tr = ev.target.closest('tr[data-slug]');
    if (tr) location.hash = '#p=' + tr.getAttribute('data-slug');
  });

  // ---- live and aside tabs ----
  $('live-body').innerHTML = R.live.map(function (r) {
    return '<tr><td>' + esc(r.name) + '</td><td>' + esc(r.category) + '</td>' +
      '<td class="num">' + money(r.tvl_usd) + '</td><td class="num">' + money(r.mcap_usd) +
      '</td><td class="num">' + r.multiple.toFixed(2) + '×</td></tr>';
  }).join('');
  $('aside-body').innerHTML = R.aside.map(function (r) {
    return '<tr><td>' + esc(r.name) + '</td><td>' + esc(r.category) + '</td>' +
      '<td class="num">' + money(r.tvl_usd) + '</td><td>' + esc(r.reason) + '</td></tr>';
  }).join('');

  var tabs = { board: $('tab-board'), live: $('tab-live'), aside: $('tab-aside') };
  var views = { board: $('view-board'), live: $('view-live'), aside: $('view-aside') };
  function showTab(name) {
    Object.keys(tabs).forEach(function (k) {
      tabs[k].classList.toggle('active', k === name);
      views[k].classList.toggle('hidden', k !== name);
    });
  }
  tabs.board.addEventListener('click', function () { showTab('board'); });
  tabs.live.addEventListener('click', function () { showTab('live'); });
  tabs.aside.addEventListener('click', function () { showTab('aside'); });

  // ---- detail view: the arithmetic, recomputed in the page, plus the farm plan ----
  function openDetail(slug) {
    var r = null;
    R.rows.forEach(function (row) { if (row.slug === slug) r = row; });
    var el = $('detail');
    if (!r) { el.classList.add('hidden'); el.innerHTML = ''; return; }
    showTab('board');
    var recomputed = Math.max(1, Math.round(r.tvl_usd * r.multiple * r.growth_factor * r.age_factor));
    var match = recomputed === r.implied_value_usd;
    var growthPct = r.change_7d === null ? 'unreported' : signed(r.change_7d, 1) + '%';
    el.innerHTML =
      '<button class="close-btn" type="button" id="detail-close">Close ×</button>' +
      '<h2>#' + r.rank + ' ' + esc(r.name) + (r.watchlist ? ' <span class="watch">★ watchlist</span>' : '') + '</h2>' +
      '<p class="sub">' + esc(r.category) + ' · ' + esc(r.chains.join(', ')) + ' · ' + ageText(r.age_days) + ' old · 7-day TVL ' + growthPct + '</p>' +
      '<h3>Implied value — the arithmetic</h3>' +
      '<dl class="breakdown">' +
      '<div><dt>TVL</dt><dd>' + money(r.tvl_usd) + '</dd></div>' +
      '<div><dt>Fitted multiple</dt><dd>' + r.multiple.toFixed(3) + '×<small>family effect ' + signed(r.family_effect, 3) + ' in log10</small></dd></div>' +
      '<div><dt>Growth × Age</dt><dd>' + r.growth_factor.toFixed(2) + ' × ' + r.age_factor.toFixed(2) + '</dd></div>' +
      '<div><dt>Implied value</dt><dd>' + money(r.implied_value_usd) + '<small>range ' + money(r.implied_low_usd) + ' – ' + money(r.implied_high_usd) + '</small></dd></div>' +
      '</dl>' +
      '<div class="math">' + money(r.tvl_usd) + ' × ' + r.multiple.toFixed(3) + ' × ' + r.growth_factor.toFixed(2) + ' × ' + r.age_factor.toFixed(2) +
      ' = ' + money(recomputed) + (match ? ' — recomputed in this page, matches the board ✓' : ' — recomputed ' + money(recomputed)) + '</div>' +
      '<h3>Farm economics</h3>' +
      '<dl class="breakdown">' +
      '<div><dt>Capital tier</dt><dd>' + money(r.capital_usd) + '<small>hold ' + r.hold_days + ' days</small></dd></div>' +
      '<div><dt>Gas, whole plan</dt><dd>' + money(r.gas_usd) + '<small>5 tx on ' + esc(r.chains[0] || 'Ethereum') + '</small></dd></div>' +
      '<div><dt>Airdrop / $1K</dt><dd>' + money(r.airdrop_per_1k_usd) + '<small>at the 7.5% assumption</small></dd></div>' +
      '<div><dt>Expected net</dt><dd class="' + (r.farm_net_usd >= 0 ? 'pos' : 'neg') + '">' + money(r.farm_net_usd) + '<small>break-even at ' + money(r.break_even_usd) + ' capital</small></dd></div>' +
      '</dl>' +
      '<h3>Farm plan — 7 steps</h3>' +
      '<ol class="steps">' + r.farm_steps.map(function (s) { return '<li>' + esc(s) + '</li>'; }).join('') + '</ol>';
    el.classList.remove('hidden');
    $('detail-close').addEventListener('click', function () {
      history.pushState(null, '', location.pathname + location.search);
      el.classList.add('hidden');
      el.innerHTML = '';
    });
    el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  // ---- hash routing: #p=<slug> opens a detail, #category=<name> filters ----
  function route() {
    var hash = location.hash.slice(1);
    var params = new URLSearchParams(hash);
    var slug = params.get('p');
    var cat = params.get('category');
    if (cat) { $('category').value = cat; renderBoard(); }
    if (slug) { openDetail(slug); }
  }
  window.addEventListener('hashchange', route);

  renderBoard();
  route();
})();
