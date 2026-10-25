/* Madushan's Rating List - front end (no build step, no dependencies) */
(function () {
  'use strict';

  const app = document.getElementById('app');
  const tip = document.getElementById('tip');
  const S = {
    index: null,
    lists: {},
    sort: { key: 'rank', dir: 1 },
    query: '',
    prefs: Object.assign({ ownOnly: false, bestOnly: false, showProv: true }, loadPref('mrl-prefs', {})),
  };

  // ---------------------------------------------------------------- utils
  function loadPref(key, def) {
    try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : def; } catch (e) { return def; }
  }
  function savePref(key, val) {
    try { localStorage.setItem(key, JSON.stringify(val)); } catch (e) { /* storage unavailable */ }
  }
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmt = (x, d = 0) => (x == null || isNaN(x) ? '–' : Number(x).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d }));
  const pct = (x, d = 1) => (x == null ? '–' : fmt(x, d) + '%');
  const signed = (x, d = 0) => (x == null ? '–' : (x > 0 ? '+' : x < 0 ? '−' : '±') + fmt(Math.abs(x), d));
  const elo = (x) => (x == null || isNaN(x) ? '–' : String(Math.round(x)));
  const enc = encodeURIComponent;
  const listUrl = (id, tab) => '#/list/' + enc(id) + (tab ? '/' + tab : '');
  const engUrl = (id, name) => '#/engine/' + enc(id) + '/' + enc(name);
  const fmtDate = (iso) => {
    if (!iso) return '–';
    const d = new Date(iso.length <= 10 ? iso + 'T00:00:00Z' : iso);
    return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
  };
  const fmtBytes = (b) => (b < 1024 * 1024 ? fmt(b / 1024, 0) + ' KB' : fmt(b / 1048576, 1) + ' MB');
  const expected = (d) => 1 / (1 + Math.pow(10, -d / 400));
  const perfDiff = (s) => (s <= 0 ? -Infinity : s >= 1 ? Infinity : -400 * Math.log10(1 / s - 1));

  // ---------------------------------------------------------------- data
  async function getJSON(url) {
    const r = await fetch(url, { cache: 'no-cache' });
    if (!r.ok) throw new Error(url + ': HTTP ' + r.status);
    return r.json();
  }

  async function init() {
    try {
      S.index = await getJSON('data/index.json');
      const all = await Promise.all(S.index.lists.map((l) => getJSON('data/' + l.id + '.json')));
      all.forEach((d) => { S.lists[d.id] = prepare(d); });
    } catch (e) {
      app.innerHTML = `<div class="empty"><h2>Ratings not available</h2>
        <p>Could not load <code>data/index.json</code>. Run <code>python tools/rate.py</code> to generate it,
        and serve the <code>site/</code> folder over HTTP (e.g. <code>python -m http.server -d site</code>).</p>
        <p class="dim">${esc(e.message)}</p></div>`;
      return;
    }
    const site = S.index.site || {};
    if (site.title) { document.getElementById('site-title').textContent = site.title; document.title = site.title; }
    if (site.subtitle) document.getElementById('site-sub').textContent = site.subtitle;
    renderFooter();
    window.addEventListener('hashchange', route);
    route();
  }

  function prepare(d) {
    d.byName = {};
    d.engines.forEach((e, i) => { e.idx = i; d.byName[e.name] = e; });
    // head-to-head lookup: h2h[i][j] = [w, d, l] from i's view
    d.h2h = d.engines.map(() => ({}));
    (d.pairs || []).forEach(([i, j, w, dr, l]) => {
      d.h2h[i][j] = [w, dr, l];
      d.h2h[j][i] = [l, dr, w];
    });
    // best version per family
    const best = {};
    d.engines.forEach((e) => { if (!(e.family in best)) best[e.family] = e.name; });
    d.engines.forEach((e) => { e.best = best[e.family] === e.name; });
    return d;
  }

  // ---------------------------------------------------------------- routing
  function route() {
    hideTip();
    const parts = location.hash.replace(/^#\/?/, '').split('/').map(decodeURIComponent);
    const first = S.index.lists[0] && S.index.lists[0].id;
    let view = parts[0] || 'list';
    if (view === 'list' && !parts[1] && !first) view = 'about';
    renderNav(view, parts[1] || first);
    if (view === 'list') renderList(S.lists[parts[1] || first] || S.lists[first], parts[2] || 'ranking');
    else if (view === 'engine') renderEngine(S.lists[parts[1]], parts.slice(2).join('/'));
    else if (view === 'compare') renderCompare();
    else if (view === 'about') renderAbout();
    else renderList(S.lists[first], 'ranking');
    window.scrollTo(0, 0);
  }

  function renderNav(view, listId) {
    const nav = document.getElementById('main-nav');
    let html = S.index.lists.map((l) =>
      `<a href="${listUrl(l.id)}" class="${(view === 'list' || view === 'engine') && listId === l.id ? 'active' : ''}">${esc(l.name)}<span class="tc">${esc(l.time_control)}</span></a>`).join('');
    if (S.index.lists.length > 1) html += `<a href="#/compare" class="${view === 'compare' ? 'active' : ''}">Compare</a>`;
    html += `<a href="#/about" class="${view === 'about' ? 'active' : ''}">About</a>`;
    nav.innerHTML = html;
  }

  function renderFooter() {
    const site = S.index.site || {};
    const repo = site.repo_url && !/YOUR-/.test(site.repo_url) ? ` · <a href="${esc(site.repo_url)}">Source &amp; PGN downloads on GitHub</a>` : '';
    document.getElementById('footer').innerHTML =
      `${esc(site.title || "Madushan's Rating List")} · Last updated ${fmtDate(S.index.generated)}${repo}` +
      (site.contact ? ` · ${esc(site.contact)}` : '');
  }

  // ---------------------------------------------------------------- list page
  function listHead(d) {
    const s = d.stats;
    return `<div class="page-head">
      <div>
        <h1>${esc(d.name)} <span class="dim" style="font-weight:500">${esc(d.time_control)}</span></h1>
        <p class="lede">${esc(d.description || '')}${d.ccrl_equivalent ? ` Ratings are on the <b>${esc(d.ccrl_equivalent)}</b>-equivalent scale.` : ''}</p>
      </div>
      <div class="meta">Updated ${fmtDate(d.generated)}${s.first_date ? `<br>Games played ${fmtDate(s.first_date)} – ${fmtDate(s.last_date)}` : ''}</div>
    </div>`;
  }

  function listTiles(d) {
    const s = d.stats;
    return `<div class="tiles">
      <div class="tile"><div class="label">Engines</div><div class="value">${fmt(s.engines)}</div>
        <div class="hint">${d.engines.filter((e) => e.own).length} of them mine</div></div>
      <div class="tile"><div class="label">Games</div><div class="value">${fmt(s.games)}</div>
        <div class="hint">${esc(d.time_control_long || d.time_control)}</div></div>
      <div class="tile"><div class="label">Draw rate</div><div class="value">${pct(s.draw_rate)}</div>
        <div class="hint">${fmt(s.draws)} draws</div></div>
      <div class="tile"><div class="label">White score</div><div class="value">${pct(s.white_score)}</div>
        <div class="hint" data-tip="Elo advantage of having the white pieces, estimated together with the ratings (95% interval).">White edge ${signed(s.white_advantage)} ± ${fmt(s.white_advantage_error)} Elo</div></div>
      <div class="tile"><div class="label">Game length</div><div class="value">${fmt(s.avg_moves)} <small>moves</small></div>
        <div class="hint">median ${fmt(s.median_moves)} moves</div></div>
    </div>`;
  }

  function subtabs(d, tab) {
    const tabs = [['ranking', 'Ranking'], ['crosstable', 'Head to head'], ['los', 'LOS matrix'], ['stats', 'Statistics']];
    return `<div class="subtabs">${tabs.map(([k, t]) => `<a href="${listUrl(d.id, k)}" class="${tab === k ? 'active' : ''}">${t}</a>`).join('')}</div>`;
  }

  function renderList(d, tab) {
    if (!d) { app.innerHTML = '<div class="empty"><h2>No rating lists configured</h2></div>'; return; }
    if (!d.engines.length) {
      app.innerHTML = listHead(d) + `<div class="empty"><h2>No games yet</h2>
        <p>Add PGN files to <code>pgn/${esc(d.id)}/</code> and push. The list rebuilds automatically.</p></div>`;
      return;
    }
    let body = '';
    if (tab === 'crosstable') body = crosstable(d);
    else if (tab === 'los') body = losMatrix(d);
    else if (tab === 'stats') body = statsView(d);
    else body = rankingView(d);
    app.innerHTML = listHead(d) + listTiles(d) + subtabs(d, tab) + body;
    if (tab === 'ranking' || !['crosstable', 'los', 'stats'].includes(tab)) bindRanking(d);
  }

  // ---- ranking
  const COLS = [
    { key: 'rank', label: '#', cls: 'num rank' },
    { key: 'name', label: 'Engine', cls: 'eng' },
    { key: 'rating', label: 'Rating', cls: 'num', tip: 'Maximum-likelihood Elo on the CCRL-equivalent scale' },
    { key: 'error', label: '±95%', cls: 'num', tip: '95% confidence interval half-width (±1.96 σ)' },
    { key: 'ci', label: 'Uncertainty', cls: 'ci-cell', nosort: true },
    { key: 'score', label: 'Score', cls: 'num', tip: 'Points scored / games played' },
    { key: 'avg_opp', label: 'Av. opp', cls: 'num', tip: 'Average rating of opponents faced' },
    { key: 'draw_rate', label: 'Draws', cls: 'num' },
    { key: 'games', label: 'Games', cls: 'num' },
    { key: 'los_next', label: 'LOS', cls: 'num', tip: 'Likelihood of superiority: probability that this engine is stronger than the one ranked directly below it' },
  ];

  function rankingView(d) {
    const p = S.prefs;
    const hasOwn = d.engines.some((e) => e.own);
    const hasFam = d.engines.some((e) => !e.best);
    return `<div class="toolbar">
        <input class="search" id="q" type="search" placeholder="Search engines…" value="${esc(S.query)}" aria-label="Search engines">
        ${hasOwn ? `<label class="check"><input type="checkbox" id="f-own" ${p.ownOnly ? 'checked' : ''}> My engines only</label>` : ''}
        ${hasFam ? `<label class="check"><input type="checkbox" id="f-best" ${p.bestOnly ? 'checked' : ''}> Best version only</label>` : ''}
        <label class="check"><input type="checkbox" id="f-prov" ${p.showProv ? 'checked' : ''}> Show provisional</label>
        <span class="spacer count-note" id="count"></span>
        <button class="btn" id="csv" type="button">Download CSV</button>
      </div>
      <div class="card"><div class="scroll"><table class="data" id="rank-table">
        <thead><tr>${COLS.map((c) => `<th class="${c.cls}${c.nosort ? '' : ' sortable'}" data-key="${c.key}"${c.tip ? ` data-tip="${esc(c.tip)}"` : ''}>${c.label}<span class="arrow"></span>${c.key === 'ci' ? '<div class="ci-axis" id="ci-axis"></div>' : ''}</th>`).join('')}</tr></thead>
        <tbody></tbody></table></div></div>
      <p class="dim" style="font-size:13px">Bars show the 95% confidence interval of each rating. LOS compares each engine with the next one down.
      Engines with fewer than ${fmt(d.provisional_games)} games are <i>provisional</i>. ${d.engines.some((e) => e.anchor) ? 'Anchors are reference engines whose CCRL rating sets the scale.' : ''}</p>`;
  }

  function filteredEngines(d) {
    const q = S.query.trim().toLowerCase();
    const p = S.prefs;
    let rows = d.engines.filter((e) =>
      (!q || e.name.toLowerCase().includes(q) || (e.author || '').toLowerCase().includes(q)) &&
      (!p.ownOnly || e.own) && (!p.bestOnly || e.best) && (p.showProv || !e.provisional));
    const { key, dir } = S.sort;
    rows = rows.slice().sort((a, b) => {
      const va = a[key], vb = b[key];
      if (key === 'name') return dir * va.localeCompare(vb);
      if (va == null) return 1;
      if (vb == null) return -1;
      return dir * (va - vb);
    });
    return rows;
  }

  function bindRanking(d) {
    const tbody = app.querySelector('#rank-table tbody');
    const draw = () => {
      const rows = filteredEngines(d);
      const lo = Math.min(...rows.map((e) => e.low)), hi = Math.max(...rows.map((e) => e.high));
      const pad = Math.max(10, (hi - lo) * 0.04);
      const a = Math.floor((lo - pad) / 10) * 10, b = Math.ceil((hi + pad) / 10) * 10;
      const x = (v) => ((v - a) / (b - a || 1)) * 100;
      document.getElementById('ci-axis').innerHTML = rows.length ? `<span>${a}</span><span>${b}</span>` : '';
      tbody.innerHTML = rows.map((e) => {
        const tags = (e.own ? '<span class="pill own">mine</span>' : '') +
          (e.anchor ? `<span class="pill anchor" data-tip="Anchor: CCRL rating ${elo(e.ccrl)}">anchor</span>` : '') +
          (e.provisional ? '<span class="pill prov">provisional</span>' : '');
        const ciTip = `<b>${esc(e.name)}</b>\n95% interval: ${elo(e.low)} – ${elo(e.high)}\nRating ${elo(e.rating)} ± ${fmt(e.error)}`;
        const wdlTip = `+${e.wins}  =${e.draws}  −${e.losses}\nWhite ${pct(e.white_score)} · Black ${pct(e.black_score)}`;
        return `<tr class="${e.own ? 'own' : ''} ${e.provisional ? 'prov' : ''}">
          <td class="num rank">${e.rank}</td>
          <td class="eng"><a href="${engUrl(d.id, e.name)}">${esc(e.name)}</a>${tags}</td>
          <td class="num rating">${elo(e.rating)}</td>
          <td class="num err">±${fmt(e.error)}</td>
          <td class="ci-cell"><div class="ci" data-tip="${esc(ciTip)}">
            <span class="ci-line" style="left:${x(e.low)}%;width:${x(e.high) - x(e.low)}%"></span>
            <span class="ci-dot" style="left:${x(e.rating)}%"></span></div></td>
          <td class="num" data-tip="${esc(wdlTip)}">${pct(e.score)}</td>
          <td class="num">${elo(e.avg_opp)}</td>
          <td class="num">${pct(e.draw_rate, 0)}</td>
          <td class="num">${fmt(e.games)}</td>
          <td class="los" style="background:${losBg(e.los_next)}">${e.los_next == null ? '' : pct(e.los_next, 1)}</td>
        </tr>`;
      }).join('') || `<tr><td colspan="${COLS.length}" class="dim" style="text-align:center;padding:28px">No engines match the filters.</td></tr>`;
      document.getElementById('count').textContent = `${rows.length} of ${d.engines.length} engines`;
      app.querySelectorAll('#rank-table th.sortable').forEach((th) => {
        th.querySelector('.arrow').textContent = th.dataset.key === S.sort.key ? (S.sort.dir > 0 ? '▲' : '▼') : '';
      });
    };
    draw();
    app.querySelector('#q').addEventListener('input', (ev) => { S.query = ev.target.value; draw(); });
    [['f-own', 'ownOnly'], ['f-best', 'bestOnly'], ['f-prov', 'showProv']].forEach(([id, k]) => {
      const el = document.getElementById(id);
      if (el) el.addEventListener('change', () => { S.prefs[k] = el.checked; savePref('mrl-prefs', S.prefs); draw(); });
    });
    app.querySelectorAll('#rank-table th.sortable').forEach((th) => th.addEventListener('click', () => {
      const k = th.dataset.key;
      const defDir = ['rank', 'name'].includes(k) ? 1 : -1;
      S.sort = S.sort.key === k ? { key: k, dir: -S.sort.dir } : { key: k, dir: defDir };
      draw();
    }));
    app.querySelector('#csv').addEventListener('click', () => downloadCsv(d, filteredEngines(d)));
  }

  function downloadCsv(d, rows) {
    const cols = ['rank', 'name', 'rating', 'error', 'low', 'high', 'games', 'wins', 'draws', 'losses', 'score', 'draw_rate', 'avg_opp', 'los_next', 'provisional', 'anchor', 'own'];
    const q = (v) => (v == null ? '' : /[",\n]/.test(String(v)) ? '"' + String(v).replace(/"/g, '""') + '"' : v);
    const csv = [cols.join(',')].concat(rows.map((e) => cols.map((c) => q(e[c])).join(','))).join('\n');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
    a.download = `rating-list-${d.id}-${(d.generated || '').slice(0, 10)}.csv`;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 0);
  }

  // ---- matrices
  function divergingBg(t) { // t in [-1, 1]; + = blue, - = red, 0 = neutral
    const m = Math.round(Math.min(1, Math.abs(t)) * 70);
    if (m < 3) return 'var(--cell)';
    return `color-mix(in oklab, ${t > 0 ? 'var(--pos)' : 'var(--neg)'} ${m}%, var(--cell))`;
  }

  function matrixShell(d, title, sub, cell, legend) {
    const E = d.engines;
    return `<div class="card"><div class="card-head"><h2>${title}</h2><span class="sub">${sub}</span></div>
      <div class="card-body"><div class="scroll"><table class="matrix">
      <thead><tr><th></th>${E.map((e) => `<th data-tip="${esc(esc(e.name))}">${e.rank}</th>`).join('')}</tr></thead>
      <tbody>${E.map((a) => `<tr class="${a.own ? 'own' : ''}"><th><span class="rk">${a.rank}</span><a href="${engUrl(d.id, a.name)}">${esc(a.name)}</a></th>${E.map((b) => cell(a, b)).join('')}</tr>`).join('')}</tbody>
      </table></div>${legend}</div></div>`;
  }

  function losBg(v) { // CCRL-style: greener = more certainly stronger
    if (v == null) return 'transparent';
    if (v >= 50) return `color-mix(in srgb, var(--los) ${Math.round(25 + (v - 50) * 1.5)}%, var(--surface))`;
    return `color-mix(in srgb, var(--neg) ${Math.round((50 - v) * 1.1)}%, var(--surface))`;
  }

  const divLegend = (lo, hi) => `<div class="legend"><span><i style="background:${divergingBg(-1)}"></i>${lo}</span><span><i style="background:var(--cell)"></i>even</span><span><i style="background:${divergingBg(1)}"></i>${hi}</span></div>`;

  function crosstable(d) {
    return matrixShell(d, 'Head to head', 'Row engine’s score against the column engine', (a, b) => {
      if (a === b) return '<td class="self"></td>';
      const r = d.h2h[a.idx][b.idx];
      if (!r) return '<td class="none">·</td>';
      const n = r[0] + r[1] + r[2], s = (r[0] + r[1] / 2) / n;
      const t = `<b>${esc(a.name)}</b> vs <b>${esc(b.name)}</b>\n+${r[0]} =${r[1]} −${r[2]}  (${fmt(s * 100, 1)}%, ${n} games)\nPerformance ${signed(clampPerf(s))} Elo · expected ${fmt(100 * expected(a.rating - b.rating), 1)}%`;
      return `<td style="background:${divergingBg((s - 0.5) * 2.5)}" data-tip="${esc(t)}">${fmt(s * 100, 0)}</td>`;
    }, divLegend('row scored less', 'row scored more') + '<p class="dim" style="font-size:13px;margin:8px 0 0">Values are percentages. Hover a cell for the exact result.</p>');
  }

  function clampPerf(s) { const p = perfDiff(s); return isFinite(p) ? Math.max(-800, Math.min(800, p)) : (p > 0 ? 800 : -800); }

  function losMatrix(d) {
    if (!d.los) return '<div class="empty"><h2>LOS matrix too large</h2><p>Increase <code>los_matrix_max</code> in the list config to include it.</p></div>';
    return matrixShell(d, 'Likelihood of superiority', 'Probability (%) that the row engine is stronger than the column engine', (a, b) => {
      if (a === b) return '<td class="self"></td>';
      const v = d.los[a.idx][b.idx];
      const t = `P(<b>${esc(a.name)}</b> stronger than <b>${esc(b.name)}</b>) = ${v}%\nRating difference ${signed(a.rating - b.rating)}`;
      const shown = v >= 100 ? '100' : v <= 0 ? '0' : v;
      return `<td style="background:${divergingBg((v - 50) / 50)}" data-tip="${esc(t)}">${shown}</td>`;
    }, divLegend('row likely weaker', 'row likely stronger') + '<p class="dim" style="font-size:13px;margin:8px 0 0">LOS uses the full rating covariance, so it accounts for shared opponents. ≥ 95% is usually treated as a significant difference.</p>');
  }

  // ---- statistics
  function statsView(d) {
    const s = d.stats;
    const n = s.games || 1;
    const res = `<div class="card"><div class="card-head"><h2>Results</h2><span class="sub">${fmt(s.games)} games</span></div><div class="card-body chart-box">
      <div class="wdl big" data-tip="${esc(`White wins ${fmt(s.white_wins)} (${fmt(100 * s.white_wins / n, 1)}%)\nDraws ${fmt(s.draws)} (${fmt(100 * s.draws / n, 1)}%)\nBlack wins ${fmt(s.black_wins)} (${fmt(100 * s.black_wins / n, 1)}%)`)}">
        <span class="w" style="width:${100 * s.white_wins / n}%"></span><span class="d" style="width:${100 * s.draws / n}%"></span><span class="l" style="width:${100 * s.black_wins / n}%"></span></div>
      <div class="legend"><span><i style="background:var(--pos)"></i>White wins ${pct(100 * s.white_wins / n)}</span><span><i style="background:var(--mid)"></i>Draws ${pct(100 * s.draws / n)}</span><span><i style="background:var(--neg)"></i>Black wins ${pct(100 * s.black_wins / n)}</span></div>
      <p style="margin:14px 0 0;color:var(--text-2);font-size:14px">White scores ${pct(s.white_score)} overall, an estimated white advantage of <b>${signed(s.white_advantage)} ± ${fmt(s.white_advantage_error)} Elo</b>. The rating model corrects for colour, so engines that played more games as White are not favoured.</p>
      </div></div>`;

    const terms = Object.entries(s.terminations || {});
    const tmax = Math.max(1, ...terms.map(([, v]) => v));
    const term = `<div class="card"><div class="card-head"><h2>How games ended</h2><span class="sub">from PGN termination comments</span></div><div class="card-body chart-box">
      <div class="hbars">${terms.map(([k, v]) => `<span class="lbl">${esc(k)}</span><span class="track"><span class="fill" style="width:${100 * v / tmax}%"></span></span><span class="val">${fmt(v)} <span class="dim">· ${fmt(100 * v / n, 1)}%</span></span>`).join('')}</div>
      </div></div>`;

    const calib = calibrationCard(d);
    const info = `<div class="card"><div class="card-head"><h2>Data</h2></div><div class="card-body prose" style="max-width:none">
      <dl>
        <dt>PGN files</dt><dd>${fmt(s.pgn_files)}</dd>
        <dt>Rated games</dt><dd>${fmt(s.games)}</dd>
        <dt>Skipped</dt><dd>${fmt(s.unfinished_games)} unfinished, ${fmt(s.excluded_games)} excluded</dd>
        <dt>Played</dt><dd>${fmtDate(s.first_date)} – ${fmtDate(s.last_date)}</dd>
        ${(d.downloads || []).length ? `<dt>Download</dt><dd>${d.downloads.map((f) => `<a href="pgn/${f.path.split('/').map(enc).join('/')}" download>${esc(f.path.split('/').pop())}</a> <span class="dim">(${fmtBytes(f.bytes)})</span>`).join('<br>')}</dd>` : ''}
        ${s.disconnected_engines.length ? `<dt>Not rated</dt><dd>${s.disconnected_engines.map(esc).join(', ')} <span class="dim">(no games connecting them to the main pool)</span></dd>` : ''}
      </dl></div></div>`;

    return `<div class="grid-2"><div>${res}${term}</div><div>${lengthChart(d)}${calib}${info}</div></div>`;
  }

  function lengthChart(d) {
    const h = d.stats.length_histogram || [];
    const W = 460, H = 180, L = 36, B = 22, T = 8;
    const max = Math.max(1, ...h.map((b) => b.count));
    const step = niceStep(max / 4);
    const top = Math.ceil(max / step) * step;
    const bw = (W - L) / h.length;
    const y = (v) => T + (H - T - B) * (1 - v / top);
    let g = '';
    for (let v = 0; v <= top; v += step) g += `<line class="gridline" x1="${L}" x2="${W}" y1="${y(v)}" y2="${y(v)}"/><text x="${L - 6}" y="${y(v) + 4}" text-anchor="end">${fmt(v)}</text>`;
    const bars = h.map((b, i) => {
      const x = L + i * bw + 1, hh = Math.max(0, y(0) - y(b.count));
      const label = b.to == null ? `${b.from}+ moves` : `${b.from}–${b.to} moves`;
      const r = Math.min(4, hh, (bw - 2) / 2);
      const path = hh > 0 ? `M${x},${y(0)} V${y(b.count) + r} Q${x},${y(b.count)} ${x + r},${y(b.count)} H${x + bw - 2 - r} Q${x + bw - 2},${y(b.count)} ${x + bw - 2},${y(b.count) + r} V${y(0)} Z` : '';
      return `<g data-tip="${esc(`${label}\n${fmt(b.count)} games`)}"><rect class="bar-hit" x="${L + i * bw}" y="${T}" width="${bw}" height="${H - T - B}"/><path class="bar" d="${path}"/></g>` +
        (i % 3 === 0 ? `<text x="${x + (bw - 2) / 2}" y="${H - 6}" text-anchor="middle">${b.from}${b.to == null ? '+' : ''}</text>` : '');
    }).join('');
    return `<div class="card"><div class="card-head"><h2>Game length</h2><span class="sub">full moves · average ${fmt(d.stats.avg_moves)}</span></div><div class="card-body chart-box">
      <svg class="chart-svg" viewBox="0 0 ${W} ${H}" role="img" aria-label="Histogram of game length in moves">${g}${bars}<line class="baseline" x1="${L}" x2="${W}" y1="${y(0)}" y2="${y(0)}"/></svg>
      </div></div>`;
  }
  function niceStep(x) { const p = Math.pow(10, Math.floor(Math.log10(x || 1))); const m = x / p; return (m <= 1 ? 1 : m <= 2 ? 2 : m <= 5 ? 5 : 10) * p; }

  function calibrationCard(d) {
    const c = d.calibration || {};
    const modeText = {
      offset: `The ratings are fitted freely from these games, then shifted as a whole so the anchors’ average equals their average ${esc(d.ccrl_equivalent)} rating. Each anchor’s deviation shows how well this list agrees with CCRL.`,
      fixed: `Each anchor is pinned to its ${esc(d.ccrl_equivalent)} rating, and all other engines are rated relative to them.`,
      average: `No anchor engines are configured yet, so the pool average is set to ${fmt(c.pool_average)}. Add anchors in <code>config/lists.json</code> to put the list on the ${esc(d.ccrl_equivalent || 'CCRL')} scale.`,
    }[c.mode] || '';
    const rows = (c.anchors || []).map((a) => {
      const dev = a.rating - a.ccrl;
      return `<tr><td class="eng"><a href="${engUrl(d.id, a.name)}">${esc(a.name)}</a></td><td class="num">${elo(a.ccrl)}</td><td class="num">${elo(a.rating)}</td>
        <td class="num ${Math.abs(dev) > a.error && c.mode === 'offset' ? 'neg-t' : ''}">${c.mode === 'fixed' ? '–' : signed(dev)}</td><td class="num">${fmt(a.games)}</td></tr>`;
    }).join('');
    return `<div class="card"><div class="card-head"><h2>Calibration</h2><span class="sub">${esc(d.ccrl_equivalent || '')} · mode: ${esc(c.mode || '')}</span></div><div class="card-body">
      <p style="font-size:14px;color:var(--text-2)">${modeText}</p>
      ${rows ? `<div class="scroll"><table class="data"><thead><tr><th>Anchor</th><th class="num">CCRL</th><th class="num">Here</th><th class="num">Δ</th><th class="num">Games</th></tr></thead><tbody>${rows}</tbody></table></div>` : ''}
      ${(c.missing_anchors || []).length ? `<p class="dim" style="font-size:13px;margin-top:10px">Configured but no games yet: ${c.missing_anchors.map(esc).join(', ')}</p>` : ''}
      </div></div>`;
  }

  // ---------------------------------------------------------------- engine page
  function renderEngine(d, name) {
    const e = d && d.byName[name];
    if (!e) {
      app.innerHTML = `<div class="empty"><h2>Engine not found</h2><p>${esc(name)} has no games in this list.</p><p><a href="${d ? listUrl(d.id) : '#/'}">Back to the ranking</a></p></div>`;
      return;
    }
    const others = S.index.lists.map((l) => S.lists[l.id]).filter((x) => x && x.byName[name]);
    const chips = others.map((x) => {
      const o = x.byName[name];
      return `<a class="pill ${x === d ? 'anchor' : ''}" href="${engUrl(x.id, name)}">${esc(x.name)} · #${o.rank} · ${elo(o.rating)}</a>`;
    }).join(' ');
    const meta = [e.author && `by ${esc(e.author)}`, e.country && esc(e.country),
      e.url && `<a href="${esc(e.url)}" rel="noopener">${esc(e.url.replace(/^https?:\/\//, ''))}</a>`].filter(Boolean).join(' · ');
    const n = e.games || 1;

    const tiles = `<div class="tiles">
      <div class="tile"><div class="label">Rating</div><div class="value">${elo(e.rating)} <small>± ${fmt(e.error)}</small></div><div class="hint">95%: ${elo(e.low)} – ${elo(e.high)}</div></div>
      <div class="tile"><div class="label">Rank</div><div class="value">#${e.rank} <small>of ${d.engines.length}</small></div><div class="hint">${e.los_next == null ? 'last place' : `LOS vs next: ${pct(e.los_next, 0)}`}</div></div>
      <div class="tile"><div class="label">Score</div><div class="value">${pct(e.score)}</div><div class="hint">+${fmt(e.wins)} =${fmt(e.draws)} −${fmt(e.losses)} in ${fmt(e.games)} games</div></div>
      <div class="tile"><div class="label">Colour</div><div class="value" style="font-size:18px">W ${pct(e.white_score, 0)} · B ${pct(e.black_score, 0)}</div><div class="hint">${fmt(e.white_games)} as White, ${fmt(e.black_games)} as Black</div></div>
      <div class="tile"><div class="label">Av. opponent</div><div class="value">${elo(e.avg_opp)}</div><div class="hint">${Object.keys(d.h2h[e.idx]).length} different opponents</div></div>
      <div class="tile"><div class="label">Draw rate</div><div class="value">${pct(e.draw_rate)}</div><div class="hint">av. ${fmt((e.avg_plies || 0) / 2)} moves per game</div></div>
    </div>`;

    const wdl = `<div class="card"><div class="card-body chart-box">
      <div class="wdl big"><span class="w" style="width:${100 * e.wins / n}%"></span><span class="d" style="width:${100 * e.draws / n}%"></span><span class="l" style="width:${100 * e.losses / n}%"></span></div>
      <div class="legend"><span><i style="background:var(--pos)"></i>Wins ${fmt(e.wins)} (${pct(100 * e.wins / n)})</span><span><i style="background:var(--mid)"></i>Draws ${fmt(e.draws)} (${pct(100 * e.draws / n)})</span><span><i style="background:var(--neg)"></i>Losses ${fmt(e.losses)} (${pct(100 * e.losses / n)})</span>
      ${e.first_date ? `<span style="margin-left:auto" class="dim">Played ${fmtDate(e.first_date)} – ${fmtDate(e.last_date)}</span>` : ''}</div>
    </div></div>`;

    const opps = Object.entries(d.h2h[e.idx]).map(([j, r]) => {
      const o = d.engines[+j];
      const g = r[0] + r[1] + r[2], s = (r[0] + r[1] / 2) / g;
      return { o, r, g, s, exp: expected(e.rating - o.rating), los: d.los ? d.los[e.idx][o.idx] : null };
    }).sort((a, b) => a.o.rank - b.o.rank);
    const oppRows = opps.map(({ o, r, g, s, exp, los }) => `<tr class="${o.own ? 'own' : ''}">
      <td class="num rank">${o.rank}</td>
      <td class="eng"><a href="${engUrl(d.id, o.name)}">${esc(o.name)}</a>${o.anchor ? '<span class="pill anchor">anchor</span>' : ''}</td>
      <td class="num">${elo(o.rating)}</td>
      <td class="num">${signed(e.rating - o.rating)}</td>
      <td class="num">${fmt(g)}</td>
      <td class="num">${r[0]}</td><td class="num">${r[1]}</td><td class="num">${r[2]}</td>
      <td><div class="wdl" data-tip="${esc(`+${r[0]} =${r[1]} −${r[2]}`)}"><span class="w" style="width:${100 * r[0] / g}%"></span><span class="d" style="width:${100 * r[1] / g}%"></span><span class="l" style="width:${100 * r[2] / g}%"></span></div></td>
      <td class="num ${s - exp > 0.02 ? 'pos-t' : s - exp < -0.02 ? 'neg-t' : ''}" data-tip="${esc(s - exp > 0.02 ? 'Scored above expectation' : s - exp < -0.02 ? 'Scored below expectation' : 'In line with expectation')}">${pct(100 * s)}</td>
      <td class="num" data-tip="Score expected from the two ratings">${pct(100 * exp)}</td>
      <td class="num" data-tip="Rating difference this result alone implies">${signed(clampPerf(s))}</td>
      <td class="los" style="background:${losBg(los)}">${los == null ? '–' : los + '%'}</td>
    </tr>`).join('');
    const oppTable = `<div class="card"><div class="card-head"><h2>Results by opponent</h2><span class="sub">sorted by opponent rank</span></div>
      <div class="scroll"><table class="data"><thead><tr><th class="num">#</th><th>Opponent</th><th class="num">Rating</th><th class="num" data-tip="${esc(esc(e.name))}’s rating minus the opponent’s">Diff</th><th class="num">Games</th>
      <th class="num">+</th><th class="num">=</th><th class="num">−</th><th></th><th class="num">Score</th><th class="num">Expected</th><th class="num">Perf Δ</th><th class="num" data-tip="Probability that ${esc(esc(e.name))} is stronger than this opponent">LOS</th></tr></thead>
      <tbody>${oppRows}</tbody></table></div></div>`;

    const fam = d.engines.filter((x) => x.family === e.family);
    const famCard = fam.length > 1 ? `<div class="card"><div class="card-head"><h2>Other versions</h2><span class="sub">${esc(e.family)} in ${esc(d.name)}</span></div>
      <div class="scroll"><table class="data"><thead><tr><th class="num">#</th><th>Version</th><th class="num">Rating</th><th class="num">±95%</th><th class="num">vs this</th><th class="num">Games</th></tr></thead><tbody>
      ${fam.map((x) => `<tr class="${x === e ? 'own' : ''}"><td class="num rank">${x.rank}</td><td class="eng"><a href="${engUrl(d.id, x.name)}">${esc(x.name)}</a></td><td class="num rating">${elo(x.rating)}</td><td class="num err">±${fmt(x.error)}</td>
      <td class="num">${x === e ? '' : signed(x.rating - e.rating)}${x !== e && d.los ? ` <span class="dim">(LOS ${d.los[x.idx][e.idx]}%)</span>` : ''}</td><td class="num">${fmt(x.games)}</td></tr>`).join('')}
      </tbody></table></div></div>` : '';

    const tags = (e.own ? '<span class="pill own">mine</span> ' : '') + (e.anchor ? `<span class="pill anchor">anchor · CCRL ${elo(e.ccrl)}</span> ` : '') + (e.provisional ? '<span class="pill prov">provisional</span>' : '');
    app.innerHTML = `<div class="page-head"><div>
        <a class="crumb" href="${listUrl(d.id)}">← ${esc(d.name)} ${esc(d.time_control)} ranking</a>
        <h1>${esc(e.name)} ${tags}</h1>
        <p class="lede">${meta}${meta && e.notes ? '<br>' : ''}${esc(e.notes || '')}</p>
      </div><div class="meta">${chips}</div></div>
      ${tiles}${wdl}${oppTable}${famCard}`;
  }

  // ---------------------------------------------------------------- compare page
  function renderCompare() {
    const L = S.index.lists.map((l) => S.lists[l.id]).filter(Boolean);
    const names = [...new Set(L.flatMap((d) => d.engines.map((e) => e.name)))];
    const rows = names.map((n) => ({ n, r: L.map((d) => d.byName[n]) })).filter((x) => x.r.filter(Boolean).length >= 2);
    const [A, B] = L;
    rows.sort((x, y) => (y.r[1] ? y.r[1].rating : 0) - (x.r[1] ? x.r[1].rating : 0));
    const own = (n) => L.some((d) => d.byName[n] && d.byName[n].own);
    app.innerHTML = `<div class="page-head"><div><h1>Compare lists</h1>
      <p class="lede">Engines rated in more than one list. The difference shows which engines gain or lose strength at the longer time control; the ± is the combined 95% uncertainty.</p></div></div>
      ${rows.length ? `<div class="card"><div class="scroll"><table class="data"><thead><tr><th>Engine</th>
      ${L.map((d) => `<th class="num">${esc(d.name)} <span class="dim">${esc(d.time_control)}</span></th><th class="num">#</th>`).join('')}
      ${A && B ? `<th class="num">${esc(B.name)} − ${esc(A.name)}</th>` : ''}</tr></thead><tbody>
      ${rows.map(({ n, r }) => {
        const a = r[0], b = r[1];
        const diff = a && b ? b.rating - a.rating : null;
        const err = a && b ? Math.sqrt(a.error * a.error + b.error * b.error) : null;
        const sig = diff != null && Math.abs(diff) > err;
        return `<tr class="${own(n) ? 'own' : ''}"><td class="eng"><a href="${engUrl(L[r.findIndex(Boolean)].id, n)}">${esc(n)}</a>${own(n) ? '<span class="pill own">mine</span>' : ''}</td>
          ${r.map((e) => e ? `<td class="num rating">${elo(e.rating)} <span class="err" style="font-weight:400;font-size:13px">±${fmt(e.error)}</span></td><td class="num rank">${e.rank}</td>` : '<td class="num dim">–</td><td></td>').join('')}
          ${A && B ? `<td class="num ${sig ? (diff > 0 ? 'pos-t' : 'neg-t') : ''}">${diff == null ? '–' : `${signed(diff)} <span class="dim">± ${fmt(err)}</span>`}</td>` : ''}</tr>`;
      }).join('')}</tbody></table></div></div>
      <p class="dim" style="font-size:13px">Differences larger than their uncertainty are coloured. Both lists are anchored to their own CCRL list, so a difference reflects relative scaling, not just raw time.</p>`
      : '<div class="empty"><h2>Nothing to compare yet</h2><p>No engine has been rated in more than one list.</p></div>'}`;
  }

  // ---------------------------------------------------------------- about page
  function renderAbout() {
    const site = S.index.site || {};
    const L = S.index.lists.map((l) => S.lists[l.id]).filter(Boolean);
    const listInfo = L.map((d) => `<h3>${esc(d.name)} · ${esc(d.time_control)}</h3><dl>
      <dt>Time control</dt><dd>${esc(d.time_control_long || d.time_control)}</dd>
      ${d.ccrl_equivalent ? `<dt>Scale</dt><dd>${esc(d.ccrl_equivalent)}-equivalent</dd>` : ''}
      ${d.hardware ? `<dt>Hardware</dt><dd>${esc(d.hardware)}</dd>` : ''}
      ${d.settings ? `<dt>Settings</dt><dd>${esc(d.settings)}</dd>` : ''}
      <dt>Anchors</dt><dd>${(d.calibration.anchors || []).length ? d.calibration.anchors.map((a) => `${esc(a.name)} (${elo(a.ccrl)})`).join(', ') : `none yet – pool average ${fmt(d.calibration.pool_average)}`}</dd>
      <dt>Provisional</dt><dd>fewer than ${fmt(d.provisional_games)} games</dd></dl>`).join('');
    app.innerHTML = `<div class="page-head"><div><h1>About this list</h1>
      <p class="lede">${esc(site.title || "Madushan's Rating List")} measures the strength of ${esc(site.owner || 'my')}’s chess engines against established reference engines, at two time controls.</p></div></div>
      <div class="prose">
      <h2>Rating lists</h2>${listInfo}
      <h2>How ratings are calculated</h2>
      <p>Ratings are maximum-likelihood estimates under the logistic Elo model, the same model <a href="https://github.com/michiguel/Ordo" rel="noopener">Ordo</a> uses for CCRL. Every game counts (a draw is half a point), and an estimated white-move advantage is fitted together with the ratings, so colour imbalances do not bias anyone.</p>
      <h3>CCRL equivalence</h3>
      <p>Each list includes reference engines (<b>anchors</b>) whose current rating on the matching CCRL list is known. In <i>offset</i> mode the whole list is shifted so the anchors’ average matches their CCRL average, keeping the spacing my own games produce. In <i>fixed</i> mode each anchor is pinned to its CCRL rating. The Statistics tab of each list shows how closely the anchors agree with CCRL.</p>
      <h3>Uncertainty</h3>
      <p>The <b>±95%</b> column is the half-width of a 95% confidence interval (1.96 standard errors). Errors come from the full covariance of the fit with a draw-aware variance (draws carry less information than decisive games), so they match what you would see if the same tournament were replayed many times. Errors are relative to the anchors, which is why the anchors themselves can have small errors.</p>
      <h3>Likelihood of superiority (LOS)</h3>
      <p>LOS is the probability that one engine is truly stronger than another, given the games played. It uses the covariance between the two ratings, so engines that met many common opponents can be separated with fewer games. 95% or more is a reasonable threshold for calling a difference real.</p>
      <h2>Columns</h2>
      <dl>
        <dt>Rating</dt><dd>Elo on the CCRL-equivalent scale</dd>
        <dt>±95%</dt><dd>95% confidence interval half-width</dd>
        <dt>Uncertainty</dt><dd>the 95% interval drawn on a common scale</dd>
        <dt>Score</dt><dd>points ÷ games</dd>
        <dt>Av. opp</dt><dd>average rating of opponents</dd>
        <dt>Draws</dt><dd>share of drawn games</dd>
        <dt>LOS</dt><dd>probability of being stronger than the next engine down</dd>
      </dl>
      <h2>Raw data</h2>
      <p>All games are published as PGN${site.repo_url && !/YOUR-/.test(site.repo_url) ? ` in the <a href="${esc(site.repo_url)}">GitHub repository</a>` : ' in the GitHub repository'}, and every list can be downloaded as CSV from its ranking page.</p>
      </div>`;
  }

  // ---------------------------------------------------------------- tooltip
  function showTip(el, ev) {
    tip.innerHTML = el.getAttribute('data-tip');
    tip.hidden = false;
    moveTip(ev);
  }
  function moveTip(ev) {
    const pad = 14, r = tip.getBoundingClientRect();
    let x = ev.clientX + pad, y = ev.clientY + pad;
    if (x + r.width > window.innerWidth - 8) x = ev.clientX - r.width - pad;
    if (y + r.height > window.innerHeight - 8) y = ev.clientY - r.height - pad;
    tip.style.left = Math.max(8, x) + 'px';
    tip.style.top = Math.max(8, y) + 'px';
  }
  function hideTip() { tip.hidden = true; }
  let tipEl = null;
  document.addEventListener('mouseover', (ev) => {
    const el = ev.target.closest && ev.target.closest('[data-tip]');
    if (el === tipEl) return;
    tipEl = el;
    if (el) showTip(el, ev); else hideTip();
  });
  document.addEventListener('mousemove', (ev) => { if (tipEl) moveTip(ev); });
  document.addEventListener('scroll', () => { tipEl = null; hideTip(); }, { passive: true });

  // ---------------------------------------------------------------- theme
  document.getElementById('theme-btn').addEventListener('click', () => {
    const root = document.documentElement;
    const cur = root.getAttribute('data-theme') || 'light';
    const next = cur === 'dark' ? 'light' : 'dark';
    root.setAttribute('data-theme', next);
    try { localStorage.setItem('mrl-theme', next); } catch (e) { /* ignore */ }
  });

  init();
})();
