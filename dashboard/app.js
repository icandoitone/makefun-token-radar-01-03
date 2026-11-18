// Token Radar — the page. No network: every byte it renders comes from data.js,
// written beside this page by main.ts. Views switch by tab; the detail and the
// filtered view also answer to the address hash, so screenshots can aim at them.

(function () {
  var D = window.RADAR;
  if (!D) {
    document.body.innerHTML = '<p style="padding:24px">Token Radar: no data beside this page.</p>';
    return;
  }

  function $(id) { return document.getElementById(id); }
  function money(n) {
    if (n >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
    if (n >= 1e6) return '$' + (n / 1e6).toFixed(1) + 'M';
    if (n >= 1e3) return '$' + (n / 1e3).toFixed(0) + 'K';
    return '$' + n;
  }
  function pct(n) { return (n >= 0 ? '+' : '') + n.toFixed(1) + '%'; }
  function esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
  function ageText(d) {
    if (d === null || d === undefined) return '—';
    if (d < 30) return d + 'd';
    if (d < 365) return Math.round(d / 30) + 'mo';
    return (d / 365).toFixed(1) + 'y';
  }

  // ---- header + footer -------------------------------------------------
  $('asof').textContent = 'Snapshot ' + D.asOf;
  $('modeltag').textContent = 'Model ' + D.model.version;
  $('footmodel').textContent = D.model.version;
  $('footasof').textContent = D.asOf;

  // ---- KPI strip --------------------------------------------------------
  var kpis = [
    [D.boardCount + '', 'pre-token protocols ranked'],
    [D.watchCount + ' / ' + D.watchCount, 'watchlist covered'],
    [D.universeCount + '', 'protocols accounted for'],
    [(D.model.rSquared * 100).toFixed(1) + '%', 'model fit (R² on traded comps)'],
    [(D.model.looMedianErr * 100).toFixed(1) + '%', 'median error, held-out tokens'],
    [D.model.refitsKept + ' refits', 'value range per row (p10–p90)'],
  ];
  $('kpis').innerHTML = kpis.map(function (k) {
    return '<div class="kpi"><b>' + esc(k[0]) + '</b><span>' + esc(k[1]) + '</span></div>';
  }).join('');

  // ---- model + validation panels ----------------------------------------
  var w = D.model.weights;
  var eq = 'ln(implied value) = ' + w[0].toFixed(3) +
    ' + ' + w[1].toFixed(3) + ' · ln(TVL)' +
    ' + ' + w[2].toFixed(3) + ' · growth_7d' +
    ' + ' + w[3].toFixed(3) + ' · ln(1 + age_days)' +
    ' + ' + w[4].toFixed(3) + ' · ln(chains)';
  for (var ci = 0; ci < D.model.categories.length; ci++) {
    var cw = w[5 + ci];
    eq += ' + ' + cw.toFixed(3) + ' · [' + D.model.categories[ci] + ']';
  }
  $('equation').textContent = eq;
  $('fitstats').innerHTML =
    'Fitted on <b>' + D.model.trainedOn + '</b> traded protocols (market cap &gt; 0), ' +
    'with one dummy per big category (ridge ' + D.model.ridge + '). ' +
    'R² = <b>' + D.model.rSquared.toFixed(3) + '</b>. ' +
    'Features: ' + D.model.features.map(esc).join(', ') + '.';
  $('loostats').innerHTML =
    'Leave-one-out median absolute error: <b>' + (D.model.looMedianErr * 100).toFixed(1) + '%</b>. ' +
    'Share of held-out tokens predicted within 2× of their market cap: <b>' +
    (D.model.looWithin2x * 100).toFixed(0) + '%</b>. ' +
    'Within 15%: <b>' + (D.model.looWithin15pct * 100).toFixed(0) + '%</b>. ' +
    'Value ranges from <b>' + D.model.refitsKept + '</b> bootstrap refits of the traded set.';

  // ---- anchors -----------------------------------------------------------
  $('anchors').innerHTML = D.anchors.map(function (a) {
    var ratio = a.fitted / Math.max(1, a.mcap);
    return '<tr><td>' + esc(a.name) + '</td><td>' + esc(a.category || '—') + '</td>' +
      '<td class="num">' + money(a.tvl) + '</td>' +
      '<td class="num">' + money(a.mcap) + '</td>' +
      '<td class="num">' + money(a.fitted) + '</td>' +
      '<td class="num">' + ratio.toFixed(2) + '×</td></tr>';
  }).join('');

  // ---- board -------------------------------------------------------------
  var cats = [];
  D.rows.forEach(function (r) {
    if (r.category && cats.indexOf(r.category) === -1) cats.push(r.category);
  });
  cats.sort();
  $('cat').innerHTML = '<option value="">All categories</option>' +
    cats.map(function (c) { return '<option>' + esc(c) + '</option>'; }).join('');

  var state = { q: '', cat: '', sort: 'rank', watch: false };

  function visibleRows() {
    var list = D.rows.filter(function (r) {
      if (state.watch && D.watch.indexOf(r.slug) === -1) return false;
      if (state.cat && r.category !== state.cat) return false;
      if (state.q) {
        var q = state.q.toLowerCase();
        var hay = (r.name + ' ' + r.slug + ' ' + (r.category || '')).toLowerCase();
        if (hay.indexOf(q) === -1) return false;
      }
      return true;
    });
    var key = state.sort;
    list.sort(function (a, b) {
      if (key === 'implied') return b.implied - a.implied;
      if (key === 'tvl') return b.tvl - a.tvl;
      if (key === 'growth') return (b.growth7d || 0) - (a.growth7d || 0);
      if (key === 'age') return (b.ageDays || 0) - (a.ageDays || 0);
      if (key === 'multiple') return b.tvlMultiple - a.tvlMultiple;
      return a.rank - b.rank;
    });
    return list;
  }

  function renderBoard() {
    var list = visibleRows();
    $('count').textContent = list.length + ' of ' + D.rows.length + ' rows';
    $('rows').innerHTML = list.map(function (r) {
      var g = r.growth7d === null ? '—' : pct(r.growth7d);
      var gc = r.growth7d === null ? '' : (r.growth7d >= 0 ? 'pos' : 'neg');
      var watch = D.watch.indexOf(r.slug) !== -1 ? ' <span class="badge">watchlist</span>' : '';
      return '<tr data-slug="' + esc(r.slug) + '">' +
        '<td>' + r.rank + '</td>' +
        '<td><b>' + esc(r.name) + '</b>' + watch + '</td>' +
        '<td>' + esc(r.category || '—') + '</td>' +
        '<td>' + esc(r.chains.slice(0, 2).join(', ')) + (r.chains.length > 2 ? ' +' + (r.chains.length - 2) : '') + '</td>' +
        '<td class="num">' + money(r.tvl) + '</td>' +
        '<td class="num ' + gc + '">' + g + '</td>' +
        '<td class="num">' + ageText(r.ageDays) + '</td>' +
        '<td class="num"><b>' + money(r.implied) + '</b></td>' +
        '<td class="num">' + money(r.valueLow) + '–' + money(r.valueHigh) + '</td>' +
        '<td class="num">' + r.tvlMultiple.toFixed(2) + '×</td></tr>';
    }).join('');
  }

  $('q').addEventListener('input', function (e) { state.q = e.target.value; renderBoard(); });
  $('cat').addEventListener('change', function (e) { state.cat = e.target.value; renderBoard(); });
  $('sort').addEventListener('change', function (e) { state.sort = e.target.value; renderBoard(); });
  $('watchonly').addEventListener('change', function (e) { state.watch = e.target.checked; renderBoard(); });
  $('rows').addEventListener('click', function (e) {
    var tr = e.target.closest('tr[data-slug]');
    if (tr) location.hash = '#/p/' + tr.getAttribute('data-slug');
  });

  // ---- detail -------------------------------------------------------------
  function showDetail(slug) {
    var r = null;
    for (var i = 0; i < D.rows.length; i++) {
      if (D.rows[i].slug === slug) { r = D.rows[i]; break; }
    }
    var el = $('detail');
    if (!r) {
      el.classList.remove('on');
      return;
    }
    document.querySelectorAll('.view').forEach(function (v) { v.classList.remove('on'); });
    el.classList.add('on');
    var g = r.growth7d === null ? 'not reported' : pct(r.growth7d);
    el.innerHTML =
      '<button class="back" id="backbtn">← Back to the board</button>' +
      '<h2>' + esc(r.name) + ' <span class="badge">rank #' + r.rank + '</span>' +
      (D.watch.indexOf(r.slug) !== -1 ? ' <span class="badge">watchlist</span>' : '') + '</h2>' +
      '<p class="note">' + esc(r.category || 'Uncategorised') + ' · ' + esc(r.chains.join(', ')) +
      ' · TVL ' + money(r.tvl) + ' · 7d ' + g + ' · age ' + ageText(r.ageDays) +
      ' · listed ' + esc(r.listedAt || 'unknown') + '</p>' +
      '<div class="grid">' +
      '<div class="stat"><b>' + money(r.implied) + '</b><span>implied value at launch (fitted)</span></div>' +
      '<div class="stat"><b>' + money(r.valueLow) + ' – ' + money(r.valueHigh) + '</b><span>value range, p10–p90 over ' + D.model.refitsKept + ' refits</span></div>' +
      '<div class="stat"><b>#' + r.rankLow + ' – #' + r.rankHigh + '</b><span>rank range across the refits</span></div>' +
      '<div class="stat"><b>' + r.tvlMultiple.toFixed(2) + '×</b><span>implied value / TVL</span></div>' +
      '</div>' +
      '<h3>Farm plan — costed, step by step</h3>' +
      '<ol class="steps">' + r.steps.map(function (s) { return '<li>' + esc(s) + '</li>'; }).join('') + '</ol>' +
      '<p class="note">The plan is sized by this protocol\u2019s own TVL and age, and every step states its cost and its time. ' +
      'The implied value is this radar\u2019s own claim, not a promise: the protocol may never issue a token.</p>';
    $('backbtn').addEventListener('click', function () { location.hash = '#/board'; });
  }

  // ---- tabs + routing -------------------------------------------------------
  function showView(name) {
    document.querySelectorAll('.view').forEach(function (v) { v.classList.remove('on'); });
    var el = $('view-' + name);
    if (el) el.classList.add('on');
    document.querySelectorAll('.tabs button').forEach(function (b) {
      b.classList.toggle('on', b.getAttribute('data-view') === name);
    });
  }
  document.querySelectorAll('.tabs button').forEach(function (b) {
    b.addEventListener('click', function () {
      location.hash = '#/' + b.getAttribute('data-view');
    });
  });

  function route() {
    var h = location.hash || '#/board';
    var m = h.match(/^#\/p\/(.+)$/);
    if (m) { showDetail(decodeURIComponent(m[1])); return; }
    var f = h.match(/^#\/f\?(.*)$/);
    if (f) {
      var params = new URLSearchParams(f[1]);
      var cat = params.get('cat') || '';
      var q = params.get('q') || '';
      state.cat = cat; state.q = q;
      $('cat').value = cat; $('q').value = q;
      renderBoard();
      showView('board');
      return;
    }
    var v = h.replace(/^#\//, '');
    if (['board', 'model', 'anchors', 'about'].indexOf(v) === -1) v = 'board';
    renderBoard();
    showView(v);
  }
  window.addEventListener('hashchange', route);
  renderBoard();
  route();
})();
