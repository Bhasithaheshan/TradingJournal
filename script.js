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
  const JOURNAL_KEY = 'tj_active_journal_v1';
  const JOURNALS_KEY = 'tj_journals_v1';
  const JOURNAL_COLORS = ['#a06bff', '#2f6bff', '#16c784', '#f0b90b', '#f6465d', '#22d3ee', '#fb7185', '#f97316'];

  /** @type {Array<{id:string,name:string,color:string}>} user-created journals */
  let journals = [];
  let journalDialogMode = null; // 'new' | 'rename'
  let journalTargetId = null;   // journal staged for deletion

  /** @type {Array<Object>} in-memory list of trades, synced to localStorage */
  let trades = [];

  /** current UI filter/sort state */
  const ui = {
    search: '',
    resultFilter: 'ALL',
    dateSort: 'desc',
    journal: 'ALL',   // 'ALL' | 'INDICATOR' | 'MANUAL'
  };

  let editingId = null;         // id of trade currently being edited, or null when adding
  let pendingShotBlob = null;   // compressed image staged from the file input before save
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
    fJournal: $('#fJournal'),
    journalSwitch: $('#journalSwitch'),
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
  const CFG = window.TJ_CONFIG || {};
  const SHOTS_BUCKET = 'screenshots';
  const MIGRATED_KEY = 'tj_migrated_v1';
  const SIGNED_URL_SECONDS = 60 * 60 * 24;
  let sb = null;          // Supabase client
  let currentUser = null; // signed-in user
  let unsavedJournals = []; // journals created while importing a CSV, saved right after

  function errMsg(e) { return (e && e.message) ? e.message : String(e); }

  function newId() {
    if (window.crypto && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (ch) => {
      const r = (Math.random() * 16) | 0;
      return (ch === 'x' ? r : (r & 3) | 8).toString(16);
    });
  }

  /* ----- row <-> object mapping (database uses snake_case) ----- */
  function rowToJournal(r) { return { id: r.id, name: r.name, color: r.color || '#2f6bff' }; }

  function rowToTrade(r) {
    return {
      id: r.id,
      journal: r.journal_id,
      date: r.trade_date,
      pair: r.pair,
      direction: r.direction,
      setup: r.setup || '',
      timeframe: r.timeframe,
      entry: Number(r.entry),
      sl: Number(r.sl),
      tp: Number(r.tp),
      lot: Number(r.lot),
      result: r.result,
      pl: Number(r.pl),
      rr: r.rr === null || r.rr === undefined ? null : Number(r.rr),
      screenshotPath: r.screenshot_path || null,
      screenshot: null, // filled with a signed URL after loading
    };
  }

  function tradeToRow(t) {
    return {
      id: t.id,
      user_id: currentUser.id,
      journal_id: t.journal,
      trade_date: t.date,
      pair: t.pair,
      direction: t.direction,
      setup: t.setup || '',
      timeframe: t.timeframe,
      entry: t.entry,
      sl: t.sl,
      tp: t.tp,
      lot: t.lot,
      result: t.result,
      pl: t.pl,
      rr: t.rr === undefined || (typeof t.rr === 'number' && isNaN(t.rr)) ? null : t.rr,
      screenshot_path: t.screenshotPath || null,
    };
  }

  /* ----- remote reads / writes ----- */
  async function fetchAll(table, orderCol) {
    const out = [];
    const size = 1000; // Supabase returns at most 1000 rows per request, so page through
    for (let from = 0; ; from += size) {
      const { data, error } = await sb.from(table).select('*')
        .order(orderCol, { ascending: true }).order('id', { ascending: true })
        .range(from, from + size - 1);
      if (error) throw error;
      out.push(...data);
      if (data.length < size) break;
    }
    return out;
  }

  async function upsertJournalRemote(j) {
    const { error } = await sb.from('journals').upsert({ id: j.id, user_id: currentUser.id, name: j.name, color: j.color });
    if (error) throw error;
  }

  async function attachScreenshotUrls(list) {
    const withShots = list.filter((t) => t.screenshotPath);
    for (let i = 0; i < withShots.length; i += 100) {
      const chunk = withShots.slice(i, i + 100);
      const { data, error } = await sb.storage.from(SHOTS_BUCKET)
        .createSignedUrls(chunk.map((t) => t.screenshotPath), SIGNED_URL_SECONDS);
      if (error) { console.error('Could not sign screenshot URLs', error); return; }
      const map = {};
      data.forEach((d) => { if (d.path && d.signedUrl) map[d.path] = d.signedUrl; });
      chunk.forEach((t) => { t.screenshot = map[t.screenshotPath] || null; });
    }
  }

  async function deleteTradesRemote(list) {
    if (!list.length) return;
    const ids = list.map((t) => t.id);
    for (let i = 0; i < ids.length; i += 100) {
      const { error } = await sb.from('trades').delete().in('id', ids.slice(i, i + 100));
      if (error) throw error;
    }
    const paths = list.filter((t) => t.screenshotPath).map((t) => t.screenshotPath);
    if (paths.length) {
      const { error } = await sb.storage.from(SHOTS_BUCKET).remove(paths);
      if (error) console.warn('Screenshot cleanup failed', error);
    }
  }

  /** Load everything for the signed-in user. */
  async function loadAll() {
    const [jRows, tRows] = await Promise.all([fetchAll('journals', 'created_at'), fetchAll('trades', 'trade_date')]);
    journals = jRows.map(rowToJournal);
    trades = tRows.map(rowToTrade);

    if (journals.length === 0) {
      const main = { id: newId(), name: 'Main', color: nextJournalColor() };
      await upsertJournalRemote(main);
      journals.push(main);
    }
    await attachScreenshotUrls(trades);

    ui.journal = 'ALL';
    try {
      const saved = localStorage.getItem(JOURNAL_KEY);
      if (saved && journalById(saved)) ui.journal = saved;
    } catch (e) { /* ignore */ }
  }

  /* ----- image compression (keeps screenshots small & fast) ----- */
  function compressImage(file, maxDim = 1600, quality = 0.82) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        const scale = Math.min(1, maxDim / Math.max(img.width, img.height));
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(img.width * scale));
        canvas.height = Math.max(1, Math.round(img.height * scale));
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        URL.revokeObjectURL(url);
        canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Image compression failed'))), 'image/jpeg', quality);
      };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Could not read that image')); };
      img.src = url;
    });
  }

  async function uploadScreenshot(tradeId, blob) {
    const path = `${currentUser.id}/${tradeId}.jpg`;
    const { error } = await sb.storage.from(SHOTS_BUCKET).upload(path, blob, { upsert: true, contentType: 'image/jpeg' });
    if (error) throw error;
    const { data, error: e2 } = await sb.storage.from(SHOTS_BUCKET).createSignedUrl(path, SIGNED_URL_SECONDS);
    if (e2) throw e2;
    return { path, url: data.signedUrl };
  }

  /* ----------------------------------------------------------
     2b. AUTH (email + password)
  ---------------------------------------------------------- */
  function setAuthMessage(text, isInfo) {
    const m = $('#authMsg');
    m.textContent = text || '';
    m.classList.toggle('is-info', !!isInfo);
  }

  function showAuth(state, setupText) {
    $('#authSetup').hidden = state !== 'setup';
    $('#authForm').hidden = state === 'setup';
    if (setupText) $('#authSetupText').textContent = setupText;
    setAuthMessage('');
    openOverlay($('#authOverlay'));
  }

  function setAuthBusy(busy) {
    $('#btnSignIn').disabled = busy;
    $('#btnSignUp').disabled = busy;
  }

  async function handleAuth(mode) {
    const email = $('#authEmail').value.trim();
    const password = $('#authPassword').value;
    if (!email || password.length < 6) {
      setAuthMessage('Enter your email and a password (at least 6 characters).');
      return;
    }
    setAuthBusy(true);
    setAuthMessage('');
    try {
      if (mode === 'signup') {
        const { data, error } = await sb.auth.signUp({ email, password });
        if (error) throw error;
        if (data.session) await onSignedIn(data.session.user);
        else setAuthMessage('Account created. Check your email to confirm it, then sign in.', true);
      } else {
        const { data, error } = await sb.auth.signInWithPassword({ email, password });
        if (error) throw error;
        await onSignedIn(data.user);
      }
    } catch (err) {
      setAuthMessage(errMsg(err));
    } finally {
      setAuthBusy(false);
    }
  }

  async function onSignedIn(user) {
    currentUser = user;
    $('#authPassword').value = '';
    closeOverlay($('#authOverlay'));
    $('#btnLogout').title = user.email ? `Log out (${user.email})` : 'Log out';
    try {
      await loadAll();
    } catch (err) {
      console.error(err);
      showToast('Could not load data: ' + errMsg(err) + ' (did you run the SQL setup?)', true);
    }
    renderAll();
    checkLocalData();
  }

  async function handleLogout() {
    try { await sb.auth.signOut(); } catch (e) { console.error(e); }
    resetAfterSignOut();
  }

  function resetAfterSignOut() {
    currentUser = null;
    trades = [];
    journals = [];
    ui.journal = 'ALL';
    $('#migrateBanner').hidden = true;
    renderAll();
    showAuth('login');
  }

  /* ----------------------------------------------------------
     2c. ONE-TIME MIGRATION: browser local storage -> cloud
  ---------------------------------------------------------- */
  function readLocalLegacy() {
    try {
      const t = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
      return Array.isArray(t) ? t : [];
    } catch (e) { return []; }
  }

  function checkLocalData() {
    let done = false;
    try { done = localStorage.getItem(MIGRATED_KEY) === '1'; } catch (e) { /* ignore */ }
    const n = readLocalLegacy().length;
    const show = n > 0 && !done;
    $('#migrateBanner').hidden = !show;
    if (show) $('#migrateText').textContent = `Found ${n} trade(s) saved in this browser (old local storage). Upload them to your cloud journal?`;
  }

  async function migrateLocalData() {
    const local = readLocalLegacy();
    if (!local.length || !currentUser) return;
    const btn = $('#btnMigrate');
    btn.disabled = true;
    try {
      let localJournals = [];
      try { localJournals = JSON.parse(localStorage.getItem(JOURNALS_KEY) || '[]'); } catch (e) { /* ignore */ }
      const legacyNames = { INDICATOR: 'Indicator', MANUAL: 'Manual' };
      const nameFor = (jid) => {
        const lj = Array.isArray(localJournals) ? localJournals.find((j) => j.id === jid) : null;
        return lj ? lj.name : (legacyNames[jid] || 'Main');
      };

      const byName = {};
      journals.forEach((j) => { byName[j.name.toLowerCase()] = j.id; });
      const ensureJournal = async (name) => {
        const key = name.toLowerCase();
        if (byName[key]) return byName[key];
        const j = { id: newId(), name: name.slice(0, 24), color: nextJournalColor() };
        await upsertJournalRemote(j);
        journals.push(j);
        byName[key] = j.id;
        return j.id;
      };

      // phase 1: build rows (and upload screenshots)
      const rows = [];
      for (let i = 0; i < local.length; i++) {
        const t = local[i];
        const id = newId();
        const entry = parseFloat(t.entry), sl = parseFloat(t.sl), tp = parseFloat(t.tp);
        const trade = {
          id,
          journal: await ensureJournal(nameFor(t.journal)),
          date: t.date,
          pair: t.pair,
          direction: t.direction,
          setup: t.setup || '',
          timeframe: t.timeframe,
          entry, sl, tp,
          lot: parseFloat(t.lot) || 0,
          result: t.result,
          pl: parseFloat(t.pl) || 0,
          rr: typeof t.rr === 'number' && !isNaN(t.rr) ? t.rr : calcRR(entry, sl, tp),
          screenshotPath: null,
        };
        if (t.screenshot && String(t.screenshot).startsWith('data:')) {
          try {
            const raw = await (await fetch(t.screenshot)).blob();
            const small = await compressImage(raw);
            trade.screenshotPath = (await uploadScreenshot(id, small)).path;
          } catch (e) { console.warn('Screenshot skipped for a trade', e); }
        }
        rows.push(tradeToRow(trade));
        showToast(`Preparing ${i + 1}/${local.length}…`);
      }

      // phase 2: insert in chunks
      for (let i = 0; i < rows.length; i += 200) {
        const { error } = await sb.from('trades').insert(rows.slice(i, i + 200));
        if (error) throw error;
      }

      try { localStorage.setItem(MIGRATED_KEY, '1'); } catch (e) { /* ignore */ }
      await loadAll();
      renderAll();
      checkLocalData();
      showToast(`Uploaded ${rows.length} trade(s) to the cloud`);
    } catch (err) {
      console.error(err);
      showToast('Upload failed: ' + errMsg(err), true);
    } finally {
      btn.disabled = false;
    }
  }

  /* ----- journal helpers ----- */
  function nextJournalColor() { return JOURNAL_COLORS[journals.length % JOURNAL_COLORS.length]; }
  function journalById(id) { return journals.find((j) => j.id === id) || null; }
  function journalName(id) { const j = journalById(id); return j ? j.name : '—'; }
  function journalColor(id) { const j = journalById(id); return j ? j.color : '#8b93a8'; }

  function populateJournalSelect() {
    el.fJournal.innerHTML = journals
      .map((j) => `<option value="${j.id}">${escapeHtml(j.name)}</option>`)
      .join('');
  }

  /** Name dialog (shared by "New journal" and "Rename"). */
  function openJournalDialog(mode) {
    journalDialogMode = mode;
    const input = $('#journalNameInput');
    $('#journalNameTitle').textContent = mode === 'rename' ? 'Rename journal' : 'New journal';
    $('#journalNameOk').textContent = mode === 'rename' ? 'Save' : 'Create';
    input.value = mode === 'rename' ? journalName(ui.journal) : '';
    openOverlay($('#journalNameOverlay'));
    setTimeout(() => { input.focus(); input.select(); }, 50);
  }

  async function handleJournalNameSubmit(e) {
    e.preventDefault();
    const name = $('#journalNameInput').value.trim();
    if (!name) return;
    const clash = journals.some((j) =>
      j.name.toLowerCase() === name.toLowerCase() && !(journalDialogMode === 'rename' && j.id === ui.journal));
    if (clash) { showToast('A journal with that name already exists', true); return; }

    closeOverlay($('#journalNameOverlay'));
    try {
      if (journalDialogMode === 'rename') {
        const j = journalById(ui.journal);
        if (j) {
          await upsertJournalRemote({ ...j, name });
          j.name = name;
        }
        renderAll();
        showToast('Journal renamed');
      } else {
        const j = { id: newId(), name, color: nextJournalColor() };
        await upsertJournalRemote(j);
        journals.push(j);
        setJournal(j.id);
        showToast(`Journal "${name}" created`);
      }
    } catch (err) {
      console.error(err);
      showToast('Could not save journal: ' + errMsg(err), true);
    }
  }

  function requestDeleteJournal() {
    if (journals.length <= 1) { showToast('Keep at least one journal', true); return; }
    journalTargetId = ui.journal;
    const n = trades.filter((t) => t.journal === journalTargetId).length;
    el.confirmTitle.textContent = `Delete "${journalName(journalTargetId)}" journal?`;
    el.confirmMessage.textContent = n
      ? `This will permanently delete this journal and its ${n} trade(s). This action cannot be undone.`
      : 'This journal is empty and will be removed.';
    el.confirmOk.textContent = 'Delete Journal';
    el.confirmOk.dataset.mode = 'journal';
    openOverlay(el.confirmOverlay);
  }

  async function deleteJournal(id) {
    const victims = trades.filter((t) => t.journal === id);
    await deleteTradesRemote(victims);
    const { error } = await sb.from('journals').delete().eq('id', id);
    if (error) throw error;
    trades = trades.filter((t) => t.journal !== id);
    journals = journals.filter((j) => j.id !== id);
    journalTargetId = null;
    setJournal('ALL');
    showToast('Journal deleted');
  }

  /** CSV import: match a journal by name (case-insensitive) or create it (saved right after parsing). */
  function resolveImportJournal(name) {
    const clean = (name || '').trim();
    if (clean) {
      let j = journals.find((x) => x.name.toLowerCase() === clean.toLowerCase());
      if (!j) {
        j = { id: newId(), name: clean.slice(0, 24), color: nextJournalColor() };
        journals.push(j);
        unsavedJournals.push(j);
      }
      return j.id;
    }
    return ui.journal === 'ALL' ? journals[0].id : ui.journal;
  }

  /** Trades belonging to the currently selected journal ('ALL' = everything). */
  function scopedTrades() {
    return ui.journal === 'ALL' ? trades : trades.filter((t) => t.journal === ui.journal);
  }

  function setJournal(j) {
    ui.journal = j;
    try { localStorage.setItem(JOURNAL_KEY, j); } catch (e) { /* ignore */ }
    renderAll();
  }

  function renderJournalSwitch() {
    if (ui.journal !== 'ALL' && !journalById(ui.journal)) ui.journal = 'ALL';

    const tab = (id, label, color, count) =>
      `<button class="jtab${ui.journal === id ? ' is-active' : ''}" role="tab" data-journal="${id}" style="--jc:${color}">` +
      `<span class="jtab__dot"></span>${escapeHtml(label)} <span class="jtab__count">${count}</span></button>`;

    let html = journals
      .map((j) => tab(j.id, j.name, j.color, trades.filter((t) => t.journal === j.id).length))
      .join('');
    html += tab('ALL', 'All Trades', '#f0b90b', trades.length);
    html += '<span class="jsep"></span><button class="jtool" data-jaction="new">+ New journal</button>';
    if (ui.journal !== 'ALL') {
      html += '<button class="jtool" data-jaction="rename">Rename</button>' +
              '<button class="jtool jtool--danger" data-jaction="delete">Delete</button>';
    }
    el.journalSwitch.innerHTML = html;
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
    const list = scopedTrades();
    const total = list.length;
    const wins = list.filter((t) => t.result === 'WIN').length;
    const losses = list.filter((t) => t.result === 'LOSS').length;
    const decided = wins + losses; // BE excluded from win-rate denominator
    const winRate = decided > 0 ? (wins / decided) * 100 : 0;
    const totalPL = list.reduce((sum, t) => sum + (parseFloat(t.pl) || 0), 0);

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
    let list = scopedTrades().slice();

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

    el.emptyState.classList.toggle('is-visible', scopedTrades().length === 0);

    list.forEach((t) => {
      const tr = document.createElement('tr');

      const pl = parseFloat(t.pl) || 0;
      const plClass = pl > 0 ? 'pl-pos' : pl < 0 ? 'pl-neg' : 'pl-zero';
      const dirClass = t.direction === 'BUY' ? 'pill--buy' : 'pill--sell';
      const resultClass = t.result === 'WIN' ? 'pill--win' : t.result === 'LOSS' ? 'pill--loss' : 'pill--be';

      tr.innerHTML = `
        <td class="num">${escapeHtml(t.date)}</td>
        <td><strong>${escapeHtml(t.pair)}</strong></td>
        <td><span class="pill" style="background:${hexToRgba(journalColor(t.journal), 0.14)};color:${journalColor(t.journal)}">${escapeHtml(journalName(t.journal))}</span></td>
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
    renderJournalSwitch();
    renderStats();
    renderTable();
    renderCharts();
  }

  /* ----------------------------------------------------------
     7. MODAL: ADD / EDIT
  ---------------------------------------------------------- */
  function openAddModal() {
    editingId = null;
    pendingShotBlob = null;
    el.modalTitle.textContent = 'Add Trade';
    el.form.reset();
    el.fId.value = '';
    populateJournalSelect();
    el.fJournal.value = ui.journal === 'ALL' ? journals[0].id : ui.journal;
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
    pendingShotBlob = null;

    el.modalTitle.textContent = 'Edit Trade';
    el.fId.value = t.id;
    populateJournalSelect();
    el.fJournal.value = journalById(t.journal) ? t.journal : journals[0].id;
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
    pendingShotBlob = null;
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

  let savingTrade = false;

  async function handleFormSubmit(e) {
    e.preventDefault();
    if (savingTrade) return;

    const entry = parseFloat(el.fEntry.value);
    const sl = parseFloat(el.fSL.value);
    const tp = parseFloat(el.fTP.value);
    const rr = calcRR(entry, sl, tp);

    const existing = editingId ? trades.find((t) => t.id === editingId) : null;
    const tradeData = {
      id: editingId || newId(),
      journal: el.fJournal.value,
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
      screenshot: existing ? existing.screenshot : null,
      screenshotPath: existing ? existing.screenshotPath : null,
    };

    const saveBtn = $('#btnSaveTrade');
    savingTrade = true;
    saveBtn.disabled = true;
    saveBtn.textContent = 'Saving…';
    try {
      if (pendingShotBlob) {
        const up = await uploadScreenshot(tradeData.id, pendingShotBlob);
        tradeData.screenshotPath = up.path;
        tradeData.screenshot = up.url;
      }
      const { error } = await sb.from('trades').upsert(tradeToRow(tradeData));
      if (error) throw error;

      if (existing) {
        const idx = trades.findIndex((t) => t.id === editingId);
        if (idx > -1) trades[idx] = tradeData;
        showToast('Trade updated');
      } else {
        trades.push(tradeData);
        showToast('Trade added');
      }
      renderAll();
      closeModal();
    } catch (err) {
      console.error(err);
      showToast('Could not save trade: ' + errMsg(err), true);
    } finally {
      savingTrade = false;
      saveBtn.disabled = false;
      saveBtn.textContent = 'Save Trade';
    }
  }

  /* ----------------------------------------------------------
     8. SCREENSHOT UPLOAD
  ---------------------------------------------------------- */
  async function handleScreenshotChange(e) {
    const file = e.target.files[0];
    if (!file) return;
    if (!file.type.startsWith('image/')) {
      showToast('Please select an image file', true);
      return;
    }
    try {
      pendingShotBlob = await compressImage(file);
      const url = URL.createObjectURL(pendingShotBlob);
      el.shotPreview.innerHTML = `<img src="${url}" alt="Screenshot preview">`;
    } catch (err) {
      pendingShotBlob = null;
      showToast(errMsg(err), true);
    }
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
    const n = scopedTrades().length;
    const scopeName = ui.journal === 'ALL' ? 'ALL journals' : `the "${journalName(ui.journal)}" journal`;
    el.confirmTitle.textContent = ui.journal === 'ALL' ? 'Clear ALL trade data?' : `Clear "${journalName(ui.journal)}" journal?`;
    el.confirmMessage.textContent = `This will permanently delete ${n} trade(s) from ${scopeName}. This action cannot be undone.`;
    el.confirmOk.textContent = 'Clear All';
    el.confirmOk.dataset.mode = 'all';
    openOverlay(el.confirmOverlay);
  }

  async function handleConfirmOk() {
    const mode = el.confirmOk.dataset.mode;
    el.confirmOk.disabled = true;
    try {
      if (mode === 'all') {
        const victims = scopedTrades().slice();
        await deleteTradesRemote(victims);
        const gone = new Set(victims.map((t) => t.id));
        trades = trades.filter((t) => !gone.has(t.id));
        renderAll();
        showToast('All data cleared');
      } else if (mode === 'journal' && journalTargetId) {
        await deleteJournal(journalTargetId);
      } else if (mode === 'single' && deleteTargetId) {
        const t = trades.find((x) => x.id === deleteTargetId);
        if (t) await deleteTradesRemote([t]);
        trades = trades.filter((x) => x.id !== deleteTargetId);
        renderAll();
        showToast('Trade deleted');
      }
    } catch (err) {
      console.error(err);
      showToast('Delete failed: ' + errMsg(err), true);
    } finally {
      el.confirmOk.disabled = false;
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
    toastTimer = setTimeout(() => el.toast.classList.remove('is-visible'), isError ? 6000 : 2400);
  }

  /* ----------------------------------------------------------
     13. CSV EXPORT / IMPORT
  ---------------------------------------------------------- */
  const CSV_COLUMNS = ['id', 'journal', 'date', 'pair', 'direction', 'setup', 'timeframe', 'entry', 'sl', 'tp', 'lot', 'result', 'pl', 'rr'];
  // Note: screenshots (base64) are intentionally excluded from CSV to keep files lightweight & spreadsheet-friendly.

  function exportCSV() {
    const list = scopedTrades();
    if (list.length === 0) {
      showToast('No trades to export', true);
      return;
    }
    const header = CSV_COLUMNS.join(',');
    const rows = list.map((t) =>
      CSV_COLUMNS.map((c) => csvEscape(c === 'journal' ? journalName(t.journal) : t[c])).join(',')
    );
    const csv = [header, ...rows].join('\n');

    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `trading-journal-${ui.journal === 'ALL' ? 'all' : journalName(ui.journal).toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${new Date().toISOString().slice(0, 10)}.csv`;
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
    reader.onload = async () => {
      unsavedJournals = [];
      try {
        const rows = parseCSV(String(reader.result));
        if (rows.length < 2) { showToast('CSV appears empty', true); return; }

        const header = rows[0].map((h) => h.trim().toLowerCase());
        const dataRows = rows.slice(1);

        const fresh = [];
        let skipped = 0;
        dataRows.forEach((r) => {
          const obj = {};
          header.forEach((h, idx) => { obj[h] = r[idx]; });

          const entry = parseFloat(obj.entry);
          const sl = parseFloat(obj.sl);
          const tp = parseFloat(obj.tp);
          const date = obj.date || new Date().toISOString().slice(0, 10);
          const direction = (obj.direction || 'BUY').toUpperCase();
          const result = (obj.result || 'WIN').toUpperCase();

          // skip rows the database would reject
          if (![entry, sl, tp].every(Number.isFinite) || !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
              !['BUY', 'SELL'].includes(direction) || !['WIN', 'LOSS', 'BE'].includes(result)) {
            skipped++;
            return;
          }

          fresh.push({
            id: newId(),
            // CSV journal column (by name) wins; otherwise the journal you're viewing
            journal: resolveImportJournal(obj.journal),
            date,
            pair: (obj.pair || 'EURUSD').toUpperCase(),
            direction,
            setup: obj.setup || '',
            timeframe: obj.timeframe || '1H',
            entry, sl, tp,
            lot: parseFloat(obj.lot) || 0,
            result,
            pl: parseFloat(obj.pl) || 0,
            rr: obj.rr && !isNaN(parseFloat(obj.rr)) ? parseFloat(obj.rr) : calcRR(entry, sl, tp),
            screenshot: null,
            screenshotPath: null,
          });
        });

        showToast('Importing…');
        for (const j of unsavedJournals) await upsertJournalRemote(j);
        for (let i = 0; i < fresh.length; i += 200) {
          const { error } = await sb.from('trades').insert(fresh.slice(i, i + 200).map(tradeToRow));
          if (error) throw error;
        }
        unsavedJournals = [];
        trades.push(...fresh);
        renderAll();
        showToast(`Imported ${fresh.length} trade(s)` + (skipped ? ` (${skipped} invalid row(s) skipped)` : ''));
      } catch (err) {
        console.error(err);
        showToast('Failed to import CSV: ' + errMsg(err), true);
        try { await loadAll(); renderAll(); } catch (e2) { /* ignore */ }
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

    const chronological = scopedTrades().slice().sort((a, b) => new Date(a.date) - new Date(b.date));
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

    const list = scopedTrades();
    const wins = list.filter((t) => t.result === 'WIN').length;
    const losses = list.filter((t) => t.result === 'LOSS').length;
    const be = list.filter((t) => t.result === 'BE').length;

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
    scopedTrades().forEach((t) => {
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

    // journal switcher
    el.journalSwitch.addEventListener('click', (e) => {
      const act = e.target.closest('[data-jaction]');
      if (act) {
        if (act.dataset.jaction === 'new') openJournalDialog('new');
        else if (act.dataset.jaction === 'rename') openJournalDialog('rename');
        else if (act.dataset.jaction === 'delete') requestDeleteJournal();
        return;
      }
      const tabBtn = e.target.closest('.jtab');
      if (tabBtn) setJournal(tabBtn.dataset.journal);
    });
    $('#journalNameForm').addEventListener('submit', handleJournalNameSubmit);
    $('#journalNameCancel').addEventListener('click', () => closeOverlay($('#journalNameOverlay')));
    $('#journalNameOverlay').addEventListener('click', (e) => { if (e.target.id === 'journalNameOverlay') closeOverlay($('#journalNameOverlay')); });

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
      if ($('#journalNameOverlay').classList.contains('is-open')) closeOverlay($('#journalNameOverlay'));
    });

    // cloud: login / logout / one-time upload of old local data
    $('#authForm').addEventListener('submit', (e) => { e.preventDefault(); handleAuth('signin'); });
    $('#btnSignUp').addEventListener('click', () => handleAuth('signup'));
    $('#btnLogout').addEventListener('click', handleLogout);
    $('#btnMigrate').addEventListener('click', migrateLocalData);
    $('#btnMigrateDismiss').addEventListener('click', () => { $('#migrateBanner').hidden = true; });

    setupNavTabs();
  }

  /* ----------------------------------------------------------
     17. INIT
  ---------------------------------------------------------- */
  async function init() {
    wireEvents();
    renderAll();

    const cfgText = `${CFG.SUPABASE_URL || ''}${CFG.SUPABASE_ANON_KEY || ''}`;
    if (!CFG.SUPABASE_URL || !CFG.SUPABASE_ANON_KEY || /YOUR-/.test(cfgText)) {
      showAuth('setup');
      return;
    }
    if (!window.supabase || typeof window.supabase.createClient !== 'function') {
      showAuth('setup', 'The Supabase library could not load (blocked network or ad-blocker?). Check your connection and refresh.');
      return;
    }

    sb = window.supabase.createClient(CFG.SUPABASE_URL, CFG.SUPABASE_ANON_KEY);
    sb.auth.onAuthStateChange((event) => {
      // signed out from another tab, or the session could not be refreshed
      if (event === 'SIGNED_OUT' && currentUser) resetAfterSignOut();
    });

    try {
      const { data } = await sb.auth.getSession();
      if (data && data.session) { await onSignedIn(data.session.user); return; }
    } catch (err) {
      console.error(err);
    }
    showAuth('login');
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
