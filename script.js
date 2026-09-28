/* =========================================================
   TRADING JOURNAL — APPLICATION LOGIC
   Vanilla JS. State persisted to localStorage. No frameworks.
   ========================================================= */

(function () {
  'use strict';

  /* ----------------------------------------------------------
     0. CONSTANTS & STATE
  ---------------------------------------------------------- */
  const STORAGE_KEY = 'tj_trades_v1';

  /** @type {Array<Object>} in-memory list of trades, synced to localStorage */
  let trades = [];

  /** current UI filter/sort state */
  const ui = {
    search: '',
    resultFilter: 'ALL',
    dateSort: 'desc',
  };

  let editingId = null;         // id of trade currently being edited, or null when adding
  let pendingScreenshot = null; // base64 string staged from file input before save
  let deleteTargetId = null;    // id staged for deletion, awaiting confirm dialog
  let equityChart, winLossChart, monthlyChart; // Chart.js instances

  /* ----------------------------------------------------------
     1. DOM REFERENCES
  ---------------------------------------------------------- */
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => Array.from(document.querySelectorAll(sel));

  const el = {
    // stat cards
    statTotal: $('#statTotal'),
    statWins: $('#statWins'),
    statLosses: $('#statLosses'),
    statWinRate: $('#statWinRate'),
    statWinRateBar: $('#statWinRateBar'),
    statPL: $('#statPL'),

    // toolbar
    searchPair: $('#searchPair'),
    filterResult: $('#filterResult'),
    sortDate: $('#sortDate'),
    btnClearAll: $('#btnClearAll'),

    // table
    tbody: $('#tradeTableBody'),
    emptyState: $('#emptyState'),

    // modal
    overlay: $('#tradeModalOverlay'),
    modalTitle: $('#modalTitle'),
    form: $('#tradeForm'),
    btnAddTrade: $('#btnAddTrade'),
    btnCloseModal: $('#btnCloseModal'),
    btnCancelModal: $('#btnCancelModal'),

    fId: $('#tradeId'),
    fDate: $('#fDate'),
    fPair: $('#fPair'),
    fPairOther: $('#fPairOther'),
    pairOtherWrap: $('#pairOtherWrap'),
    fDirection: $('#fDirection'),
    fTimeframe: $('#fTimeframe'),
    fSetup: $('#fSetup'),
    fEntry: $('#fEntry'),
    fSL: $('#fSL'),
    fTP: $('#fTP'),
    fLot: $('#fLot'),
    fResult: $('#fResult'),
    fPL: $('#fPL'),
    fRR: $('#fRR'),
    fScreenshot: $('#fScreenshot'),
    shotPreview: $('#shotPreview'),

    // lightbox
    lightboxOverlay: $('#lightboxOverlay'),
    lightboxImg: $('#lightboxImg'),
    lightboxClose: $('#lightboxClose'),

    // confirm dialog
    confirmOverlay: $('#confirmOverlay'),
    confirmTitle: $('#confirmTitle'),
    confirmMessage: $('#confirmMessage'),
    confirmOk: $('#confirmOk'),
    confirmCancel: $('#confirmCancel'),

    // toast
    toast: $('#toast'),

    // import/export
    btnImport: $('#btnImport'),
    btnExport: $('#btnExport'),
    csvFileInput: $('#csvFileInput'),

    // nav
    navTabs: $('#navTabs'),
    btnBurger: $('#btnBurger'),
    navbar: $('.navbar'),
  };

  /* ----------------------------------------------------------
     2. STORAGE HELPERS
  ---------------------------------------------------------- */
  function loadTrades() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      trades = raw ? JSON.parse(raw) : [];
    } catch (e) {
      console.error('Failed to load trades from localStorage', e);
      trades = [];
    }
  }

  function saveTrades() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(trades));
    } catch (e) {
      console.error('Failed to save trades to localStorage', e);
      showToast('Storage error: could not save data', true);
    }
  }

  /* ----------------------------------------------------------
     3. CALCULATIONS
  ---------------------------------------------------------- */
  /** Risk/Reward = |TP - Entry| / |Entry - SL|, direction-aware for sanity but
   *  magnitude-based so it works regardless of BUY/SELL. */
  function calcRR(entry, sl, tp) {
    entry = parseFloat(entry); sl = parseFloat(sl); tp = parseFloat(tp);
    if ([entry, sl, tp].some((v) => isNaN(v))) return null;
    const risk = Math.abs(entry - sl);
    const reward = Math.abs(tp - entry);
    if (risk === 0) return null;
    return reward / risk;
  }

  function fmtMoney(n) {
    const v = Number(n) || 0;
    const sign = v > 0 ? '+' : v < 0 ? '-' : '';
    return `${sign}$${Math.abs(v).toFixed(2)}`;
  }

  function fmtRR(rr) {
    if (rr === null || rr === undefined || isNaN(rr)) return '—';
    return `1:${rr.toFixed(2)}`;
  }

  /* ----------------------------------------------------------
     4. RENDER: STAT CARDS
  ---------------------------------------------------------- */
  function renderStats() {
    const total = trades.length;
    const wins = trades.filter((t) => t.result === 'WIN').length;
    const losses = trades.filter((t) => t.result === 'LOSS').length;
    const decided = wins + losses; // BE excluded from win-rate denominator
    const winRate = decided > 0 ? (wins / decided) * 100 : 0;
    const totalPL = trades.reduce((sum, t) => sum + (parseFloat(t.pl) || 0), 0);

    el.statTotal.textContent = total;
    el.statWins.textContent = wins;
    el.statLosses.textContent = losses;
    el.statWinRate.textContent = `${winRate.toFixed(1)}%`;
    el.statWinRateBar.style.width = `${Math.min(100, winRate)}%`;

    el.statPL.textContent = fmtMoney(totalPL);
    el.statPL.classList.remove('stat-card__value--green', 'stat-card__value--red');
    if (totalPL > 0) el.statPL.classList.add('stat-card__value--green');
    if (totalPL < 0) el.statPL.classList.add('stat-card__value--red');
  }

  /* ----------------------------------------------------------
     5. RENDER: TABLE
  ---------------------------------------------------------- */
  function getFilteredSortedTrades() {
    let list = trades.slice();

    if (ui.search.trim()) {
      const q = ui.search.trim().toLowerCase();
      list = list.filter((t) => t.pair.toLowerCase().includes(q));
    }

    if (ui.resultFilter !== 'ALL') {
      list = list.filter((t) => t.result === ui.resultFilter);
    }

    list.sort((a, b) => {
      const da = new Date(a.date).getTime();
      const db = new Date(b.date).getTime();
      return ui.dateSort === 'asc' ? da - db : db - da;
    });

    return list;
  }

  function renderTable() {
    const list = getFilteredSortedTrades();
    el.tbody.innerHTML = '';

    el.emptyState.classList.toggle('is-visible', trades.length === 0);

    list.forEach((t) => {
      const tr = document.createElement('tr');

      const pl = parseFloat(t.pl) || 0;
      const plClass = pl > 0 ? 'pl-pos' : pl < 0 ? 'pl-neg' : 'pl-zero';
      const dirClass = t.direction === 'BUY' ? 'pill--buy' : 'pill--sell';
      const resultClass = t.result === 'WIN' ? 'pill--win' : t.result === 'LOSS' ? 'pill--loss' : 'pill--be';

      tr.innerHTML = `
        <td class="num">${escapeHtml(t.date)}</td>
        <td><strong>${escapeHtml(t.pair)}</strong></td>
        <td><span class="pill ${dirClass}">${t.direction}</span></td>
        <td>${escapeHtml(t.setup || '—')}</td>
        <td class="num">${escapeHtml(t.timeframe)}</td>
        <td class="num">${escapeHtml(String(t.entry))}</td>
        <td class="num">${escapeHtml(String(t.sl))}</td>
        <td class="num">${escapeHtml(String(t.tp))}</td>
        <td class="num">${escapeHtml(String(t.lot))}</td>
        <td><span class="pill ${resultClass}">${t.result}</span></td>
        <td class="${plClass}">${fmtMoney(pl)}</td>
        <td class="num">${fmtRR(t.rr)}</td>
        <td>${t.screenshot ? `<img class="shot-thumb" src="${t.screenshot}" data-id="${t.id}" alt="Screenshot">` : '<span class="shot-none">—</span>'}</td>
        <td>
          <div class="row-actions">
            <button class="icon-btn" data-action="edit" data-id="${t.id}" title="Edit" aria-label="Edit trade">
              <svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04a1 1 0 0 0 0-1.41l-2.34-2.34a1 1 0 0 0-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z"/></svg>
            </button>
            <button class="icon-btn icon-btn--danger" data-action="delete" data-id="${t.id}" title="Delete" aria-label="Delete trade">
              <svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M6 7h12l-1 14H7L6 7zm3-4h6l1 2h4v2H2V5h4l1-2z"/></svg>
            </button>
          </div>
        </td>
      `;

      el.tbody.appendChild(tr);
    });

    // wire up row action buttons
    $$('.icon-btn[data-action="edit"]').forEach((b) => b.addEventListener('click', () => openEditModal(b.dataset.id)));
    $$('.icon-btn[data-action="delete"]').forEach((b) => b.addEventListener('click', () => requestDelete(b.dataset.id)));
    $$('.shot-thumb').forEach((img) => img.addEventListener('click', () => openLightbox(img.src)));
  }

  function escapeHtml(str) {
    const d = document.createElement('div');
    d.textContent = str ?? '';
    return d.innerHTML;
  }

  /* ----------------------------------------------------------
     6. RENDER: EVERYTHING
  ---------------------------------------------------------- */
  function renderAll() {
    renderStats();
    renderTable();
    renderCharts();
  }

  /* ----------------------------------------------------------
     7. MODAL: ADD / EDIT
  ---------------------------------------------------------- */
  function openAddModal() {
    editingId = null;
    pendingScreenshot = null;
    el.modalTitle.textContent = 'Add Trade';
    el.form.reset();
    el.fId.value = '';
    el.fDate.value = new Date().toISOString().slice(0, 10);
    el.fRR.value = '—';
    el.shotPreview.innerHTML = '';
    togglePairOther();
    openOverlay(el.overlay);
  }

  function openEditModal(id) {
    const t = trades.find((x) => x.id === id);
    if (!t) return;
    editingId = id;
    pendingScreenshot = t.screenshot || null;

    el.modalTitle.textContent = 'Edit Trade';
    el.fId.value = t.id;
    el.fDate.value = t.date;
    // Pairs outside the preset list are shown via the "Other…" option
    const isPreset = Array.from(el.fPair.options).some((o) => o.value === t.pair && o.value !== 'OTHER');
    el.fPair.value = isPreset ? t.pair : 'OTHER';
    el.pairOtherWrap.hidden = isPreset;
    el.fPairOther.required = !isPreset;
    el.fPairOther.value = isPreset ? '' : t.pair;
    el.fDirection.value = t.direction;
    el.fTimeframe.value = t.timeframe;
    el.fSetup.value = t.setup || '';
    el.fEntry.value = t.entry;
    el.fSL.value = t.sl;
    el.fTP.value = t.tp;
    el.fLot.value = t.lot;
    el.fResult.value = t.result;
    el.fPL.value = t.pl;
    el.fRR.value = fmtRR(t.rr);

    el.shotPreview.innerHTML = t.screenshot
      ? `<img src="${t.screenshot}" alt="Current screenshot">`
      : '';

    openOverlay(el.overlay);
  }

  function closeModal() {
    closeOverlay(el.overlay);
    editingId = null;
    pendingScreenshot = null;
  }

  /** Show the custom-pair input only when "Other…" is selected. */
  function togglePairOther() {
    const isOther = el.fPair.value === 'OTHER';
    el.pairOtherWrap.hidden = !isOther;
    el.fPairOther.required = isOther;
    if (!isOther) el.fPairOther.value = '';
    else el.fPairOther.focus();
  }

  /** Resolve the pair value: preset from dropdown, or the typed custom pair. */
  function getSelectedPair() {
    return el.fPair.value === 'OTHER'
      ? el.fPairOther.value.trim().toUpperCase().replace(/\s+/g, '')
      : el.fPair.value;
  }

  function updateRRPreview() {
    const rr = calcRR(el.fEntry.value, el.fSL.value, el.fTP.value);
    el.fRR.value = fmtRR(rr);
  }

  function handleFormSubmit(e) {
    e.preventDefault();

    const entry = parseFloat(el.fEntry.value);
    const sl = parseFloat(el.fSL.value);
    const tp = parseFloat(el.fTP.value);
    const rr = calcRR(entry, sl, tp);

    const tradeData = {
      id: editingId || cryptoRandomId(),
      date: el.fDate.value,
      pair: getSelectedPair(),
      direction: el.fDirection.value,
      setup: el.fSetup.value.trim(),
      timeframe: el.fTimeframe.value,
      entry, sl, tp,
      lot: parseFloat(el.fLot.value),
      result: el.fResult.value,
      pl: parseFloat(el.fPL.value),
      rr,
      screenshot: pendingScreenshot,
    };

    if (editingId) {
      const idx = trades.findIndex((t) => t.id === editingId);
      if (idx > -1) trades[idx] = tradeData;
      showToast('Trade updated');
    } else {
      trades.push(tradeData);
      showToast('Trade added');
    }

    saveTrades();
    renderAll();
    closeModal();
  }

  function cryptoRandomId() {
    return 'tr_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
  }

  /* ----------------------------------------------------------
     8. SCREENSHOT UPLOAD
  ---------------------------------------------------------- */
  function handleScreenshotChange(e) {
    const file = e.target.files[0];
    if (!file) return;
    if (!file.type.startsWith('image/')) {
      showToast('Please select an image file', true);
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      pendingScreenshot = reader.result;
      el.shotPreview.innerHTML = `<img src="${pendingScreenshot}" alt="Screenshot preview">`;
    };
    reader.readAsDataURL(file);
  }

  /* ----------------------------------------------------------
     9. DELETE FLOW
  ---------------------------------------------------------- */
  function requestDelete(id) {
    deleteTargetId = id;
    el.confirmTitle.textContent = 'Delete this trade?';
    el.confirmMessage.textContent = 'This will permanently remove the trade entry. This action cannot be undone.';
    el.confirmOk.textContent = 'Delete';
    el.confirmOk.dataset.mode = 'single';
    openOverlay(el.confirmOverlay);
  }

  function requestClearAll() {
    deleteTargetId = null;
    el.confirmTitle.textContent = 'Clear all trade data?';
    el.confirmMessage.textContent = `This will permanently delete all ${trades.length} trade(s) from local storage. This action cannot be undone.`;
    el.confirmOk.textContent = 'Clear All';
    el.confirmOk.dataset.mode = 'all';
    openOverlay(el.confirmOverlay);
  }

  function handleConfirmOk() {
    const mode = el.confirmOk.dataset.mode;
    if (mode === 'all') {
      trades = [];
      saveTrades();
      renderAll();
      showToast('All data cleared');
    } else if (mode === 'single' && deleteTargetId) {
      trades = trades.filter((t) => t.id !== deleteTargetId);
      saveTrades();
      renderAll();
      showToast('Trade deleted');
    }
    deleteTargetId = null;
    closeOverlay(el.confirmOverlay);
  }

  /* ----------------------------------------------------------
     10. LIGHTBOX
  ---------------------------------------------------------- */
  function openLightbox(src) {
    el.lightboxImg.src = src;
    openOverlay(el.lightboxOverlay);
  }
  function closeLightbox() {
    closeOverlay(el.lightboxOverlay);
    el.lightboxImg.src = '';
  }

  /* ----------------------------------------------------------
     11. OVERLAY HELPERS
  ---------------------------------------------------------- */
  function openOverlay(node) { node.classList.add('is-open'); }
  function closeOverlay(node) { node.classList.remove('is-open'); }

  /* ----------------------------------------------------------
     12. TOAST
  ---------------------------------------------------------- */
  let toastTimer = null;
  function showToast(msg, isError = false) {
    el.toast.textContent = msg;
    el.toast.classList.toggle('toast--error', !!isError);
    el.toast.classList.add('is-visible');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.toast.classList.remove('is-visible'), 2400);
  }

  /* ----------------------------------------------------------
     13. CSV EXPORT / IMPORT
  ---------------------------------------------------------- */
  const CSV_COLUMNS = ['id', 'date', 'pair', 'direction', 'setup', 'timeframe', 'entry', 'sl', 'tp', 'lot', 'result', 'pl', 'rr'];
  // Note: screenshots (base64) are intentionally excluded from CSV to keep files lightweight & spreadsheet-friendly.

  function exportCSV() {
    if (trades.length === 0) {
      showToast('No trades to export', true);
      return;
    }
    const header = CSV_COLUMNS.join(',');
    const rows = trades.map((t) =>
      CSV_COLUMNS.map((c) => csvEscape(t[c])).join(',')
    );
    const csv = [header, ...rows].join('\n');

    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `trading-journal-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    showToast('CSV exported');
  }

  function csvEscape(val) {
    const s = val === undefined || val === null ? '' : String(val);
    if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
    return s;
  }

  function parseCSV(text) {
    // Minimal RFC4180-ish CSV parser handling quoted fields.
    const rows = [];
    let row = [], field = '', inQuotes = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (inQuotes) {
        if (c === '"') {
          if (text[i + 1] === '"') { field += '"'; i++; }
          else inQuotes = false;
        } else field += c;
      } else {
        if (c === '"') inQuotes = true;
        else if (c === ',') { row.push(field); field = ''; }
        else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
        else if (c === '\r') { /* skip */ }
        else field += c;
      }
    }
    if (field.length || row.length) { row.push(field); rows.push(row); }
    return rows.filter((r) => r.length && r.some((v) => v !== ''));
  }

  function importCSV(file) {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const rows = parseCSV(String(reader.result));
        if (rows.length < 2) { showToast('CSV appears empty', true); return; }

        const header = rows[0].map((h) => h.trim().toLowerCase());
        const dataRows = rows.slice(1);

        let imported = 0;
        dataRows.forEach((r) => {
          const obj = {};
          header.forEach((h, idx) => { obj[h] = r[idx]; });

          const entry = parseFloat(obj.entry);
          const sl = parseFloat(obj.sl);
          const tp = parseFloat(obj.tp);

          const trade = {
            id: obj.id && !trades.some((t) => t.id === obj.id) ? obj.id : cryptoRandomId(),
            date: obj.date || new Date().toISOString().slice(0, 10),
            pair: (obj.pair || 'EURUSD').toUpperCase(),
            direction: (obj.direction || 'BUY').toUpperCase(),
            setup: obj.setup || '',
            timeframe: obj.timeframe || '1H',
            entry, sl, tp,
            lot: parseFloat(obj.lot) || 0,
            result: (obj.result || 'WIN').toUpperCase(),
            pl: parseFloat(obj.pl) || 0,
            rr: obj.rr && !isNaN(parseFloat(obj.rr)) ? parseFloat(obj.rr) : calcRR(entry, sl, tp),
            screenshot: null,
          };
          trades.push(trade);
          imported++;
        });

        saveTrades();
        renderAll();
        showToast(`Imported ${imported} trade(s)`);
      } catch (err) {
        console.error(err);
        showToast('Failed to import CSV', true);
      }
    };
    reader.readAsText(file);
  }

  /* ----------------------------------------------------------
     14. CHARTS (Chart.js)
  ---------------------------------------------------------- */
  const CHART_COLORS = {
    grid: 'rgba(148,163,184,0.08)',
    text: '#8b93a8',
    blue: '#2f6bff',
    green: '#16c784',
    red: '#f6465d',
    amber: '#f0b90b',
  };

  function baseChartOptions(extra = {}) {
    return Object.assign({
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false, labels: { color: CHART_COLORS.text } },
      },
      scales: {
        x: { grid: { color: CHART_COLORS.grid }, ticks: { color: CHART_COLORS.text, font: { family: 'Inter', size: 11 } } },
        y: { grid: { color: CHART_COLORS.grid }, ticks: { color: CHART_COLORS.text, font: { family: 'JetBrains Mono', size: 11 } } },
      },
    }, extra);
  }

  function renderCharts() {
    // Guard: if Chart.js hasn't loaded (blocked CDN, offline, ad-blocker, etc.)
    // show a clear inline message in each chart card instead of leaving a
    // silently blank box, and bail out without throwing.
    if (typeof Chart === 'undefined') {
      showChartLoadError();
      return;
    }
    try {
      clearChartLoadError();
      renderEquityChart();
      renderWinLossChart();
      renderMonthlyChart();
    } catch (err) {
      // A chart error should never take down the rest of the app (table,
      // stats, modals must keep working even if charting fails).
      console.error('Chart rendering failed:', err);
      showChartLoadError();
    }
  }

  function showChartLoadError() {
    $$('.chart-canvas-wrap').forEach((wrap) => {
      if (wrap.querySelector('.chart-error')) return; // already shown
      const msg = document.createElement('div');
      msg.className = 'chart-error';
      msg.textContent = 'Charts could not load (Chart.js was blocked or failed to load). Check your connection or ad-blocker, then refresh.';
      wrap.appendChild(msg);
    });
  }

  function clearChartLoadError() {
    $$('.chart-error').forEach((n) => n.remove());
  }

  function renderEquityChart() {
    const ctx = document.getElementById('equityChart');
    if (!ctx) return;

    const chronological = trades.slice().sort((a, b) => new Date(a.date) - new Date(b.date));
    let running = 0;
    const labels = [];
    const data = [];
    chronological.forEach((t, i) => {
      running += parseFloat(t.pl) || 0;
      labels.push(t.date);
      data.push(running.toFixed(2));
    });
    if (labels.length === 0) { labels.push('—'); data.push(0); }

    const finalPL = running;
    const lineColor = finalPL >= 0 ? CHART_COLORS.green : CHART_COLORS.red;

    if (equityChart) equityChart.destroy();
    equityChart = new Chart(ctx, {
      type: 'line',
      data: {
        labels,
        datasets: [{
          data,
          borderColor: lineColor,
          backgroundColor: hexToRgba(lineColor, 0.12),
          fill: true,
          tension: 0.3,
          pointRadius: 0,
          pointHoverRadius: 4,
          borderWidth: 2,
        }],
      },
      options: baseChartOptions({
        plugins: { legend: { display: false } },
      }),
    });
  }

  function renderWinLossChart() {
    const ctx = document.getElementById('winLossChart');
    if (!ctx) return;

    const wins = trades.filter((t) => t.result === 'WIN').length;
    const losses = trades.filter((t) => t.result === 'LOSS').length;
    const be = trades.filter((t) => t.result === 'BE').length;

    if (winLossChart) winLossChart.destroy();
    winLossChart = new Chart(ctx, {
      type: 'doughnut',
      data: {
        labels: ['Wins', 'Losses', 'Break-even'],
        datasets: [{
          data: [wins, losses, be],
          backgroundColor: [CHART_COLORS.green, CHART_COLORS.red, CHART_COLORS.amber],
          borderColor: '#131a26',
          borderWidth: 3,
        }],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        cutout: '68%',
        plugins: {
          legend: { position: 'bottom', labels: { color: CHART_COLORS.text, boxWidth: 10, font: { family: 'Inter', size: 11 } } },
        },
      },
    });
  }

  function renderMonthlyChart() {
    const ctx = document.getElementById('monthlyChart');
    if (!ctx) return;

    const byMonth = {};
    trades.forEach((t) => {
      const d = new Date(t.date);
      if (isNaN(d)) return;
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
      byMonth[key] = (byMonth[key] || 0) + (parseFloat(t.pl) || 0);
    });
    const keys = Object.keys(byMonth).sort();
    const labels = keys.map((k) => {
      const [y, m] = k.split('-');
      return new Date(Number(y), Number(m) - 1, 1).toLocaleDateString(undefined, { month: 'short', year: '2-digit' });
    });
    const values = keys.map((k) => byMonth[k]);
    const colors = values.map((v) => (v >= 0 ? CHART_COLORS.green : CHART_COLORS.red));

    if (monthlyChart) monthlyChart.destroy();
    monthlyChart = new Chart(ctx, {
      type: 'bar',
      data: {
        labels: labels.length ? labels : ['—'],
        datasets: [{
          data: values.length ? values : [0],
          backgroundColor: colors.length ? colors : [CHART_COLORS.blue],
          borderRadius: 5,
          maxBarThickness: 36,
        }],
      },
      options: baseChartOptions({ plugins: { legend: { display: false } } }),
    });
  }

  function hexToRgba(hex, alpha) {
    const h = hex.replace('#', '');
    const r = parseInt(h.substring(0, 2), 16);
    const g = parseInt(h.substring(2, 4), 16);
    const b = parseInt(h.substring(4, 6), 16);
    return `rgba(${r},${g},${b},${alpha})`;
  }

  /* ----------------------------------------------------------
     15. NAV TABS (scroll-to + active state)
  ---------------------------------------------------------- */
  function setupNavTabs() {
    const sections = {
      dashboard: document.getElementById('viewDashboard'),
      log: document.getElementById('viewLog'),
      analytics: document.getElementById('viewAnalytics'),
    };

    $$('.navtab').forEach((btn) => {
      btn.addEventListener('click', () => {
        $$('.navtab').forEach((b) => b.classList.remove('is-active'));
        btn.classList.add('is-active');
        const target = sections[btn.dataset.view];
        if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
        el.navbar.classList.remove('is-menu-open');
      });
    });

    el.btnBurger.addEventListener('click', () => {
      el.navbar.classList.toggle('is-menu-open');
    });
  }

  /* ----------------------------------------------------------
     16. EVENT WIRING
  ---------------------------------------------------------- */
  function wireEvents() {
    // add / edit modal
    el.btnAddTrade.addEventListener('click', openAddModal);
    el.btnCloseModal.addEventListener('click', closeModal);
    el.btnCancelModal.addEventListener('click', closeModal);
    el.overlay.addEventListener('click', (e) => { if (e.target === el.overlay) closeModal(); });
    el.form.addEventListener('submit', handleFormSubmit);

    // custom pair toggle
    el.fPair.addEventListener('change', togglePairOther);

    // live RR preview
    [el.fEntry, el.fSL, el.fTP].forEach((input) => input.addEventListener('input', updateRRPreview));

    // screenshot
    el.fScreenshot.addEventListener('change', handleScreenshotChange);

    // lightbox
    el.lightboxClose.addEventListener('click', closeLightbox);
    el.lightboxOverlay.addEventListener('click', (e) => { if (e.target === el.lightboxOverlay) closeLightbox(); });

    // confirm dialog
    el.confirmCancel.addEventListener('click', () => closeOverlay(el.confirmOverlay));
    el.confirmOverlay.addEventListener('click', (e) => { if (e.target === el.confirmOverlay) closeOverlay(el.confirmOverlay); });
    el.confirmOk.addEventListener('click', handleConfirmOk);

    // toolbar: search / filter / sort
    el.searchPair.addEventListener('input', (e) => { ui.search = e.target.value; renderTable(); });
    el.filterResult.addEventListener('change', (e) => { ui.resultFilter = e.target.value; renderTable(); });
    el.sortDate.addEventListener('change', (e) => { ui.dateSort = e.target.value; renderTable(); });
    el.btnClearAll.addEventListener('click', requestClearAll);

    // import / export
    el.btnExport.addEventListener('click', exportCSV);
    el.btnImport.addEventListener('click', () => el.csvFileInput.click());
    el.csvFileInput.addEventListener('change', (e) => {
      const file = e.target.files[0];
      if (file) importCSV(file);
      e.target.value = ''; // allow re-selecting the same file later
    });

    // escape key closes any open overlay
    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      if (el.overlay.classList.contains('is-open')) closeModal();
      if (el.lightboxOverlay.classList.contains('is-open')) closeLightbox();
      if (el.confirmOverlay.classList.contains('is-open')) closeOverlay(el.confirmOverlay);
    });

    setupNavTabs();
  }

  /* ----------------------------------------------------------
     17. INIT
  ---------------------------------------------------------- */
  function init() {
    loadTrades();
    wireEvents();
    renderAll();
  }

  document.addEventListener('DOMContentLoaded', init);

  // If Chart.js loads asynchronously (e.g. the primary CDN was blocked and
  // the fallback CDN loaded afterwards), re-render charts once it's ready.
  document.addEventListener('chartjsready', renderCharts);
  document.addEventListener('chartjsfailed', () => {
    console.error('Both Chart.js CDNs failed to load.');
    showChartLoadError();
  });
})();
