/* UI + Excel export. All processing happens in the browser. */
(function () {
  'use strict';
  const P = window.StatementParser;
  const PDFJS_VER = '3.11.174';
  // pdf.js wraps a cross-origin worker URL automatically and falls back to the main thread if workers are blocked
  pdfjsLib.GlobalWorkerOptions.workerSrc = `https://cdnjs.cloudflare.com/ajax/libs/pdf.js/${PDFJS_VER}/pdf.worker.min.js`;

  const $ = id => document.getElementById(id);
  const state = { statements: [], txns: [] };
  let uid = 0;

  const inr = n => (n == null || isNaN(n)) ? '—' : Number(n).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const short = acc => acc ? acc.slice(-4) : '????';
  const label = st => `${st.meta.bank || 'Bank'} ${short(st.meta.account)}`;

  // ---------- file intake ----------
  const drop = $('drop'), fileIn = $('file');
  drop.addEventListener('click', () => fileIn.click());
  drop.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') fileIn.click(); });
  drop.addEventListener('dragover', e => { e.preventDefault(); drop.classList.add('over'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('over'));
  drop.addEventListener('drop', e => { e.preventDefault(); drop.classList.remove('over'); handleFiles(e.dataTransfer.files); });
  fileIn.addEventListener('change', () => { handleFiles(fileIn.files); fileIn.value = ''; });

  async function handleFiles(list) {
    const files = [...list].filter(f => /\.pdf$/i.test(f.name) || f.type === 'application/pdf');
    for (const f of files) {
      const st = { id: ++uid, fileName: f.name, status: 'busy' };
      state.statements.push(st);
      renderFiles();
      try {
        const pages = await readPdf(f);
        Object.assign(st, P.parseStatement(pages, f.name));
        st.status = st.error ? 'bad' : (st.summary.reconciled ? 'ok' : 'warn');
      } catch (err) {
        st.status = 'bad';
        st.error = err && err.name === 'PasswordException' ? 'Password required / incorrect.' : ('Could not read PDF: ' + (err.message || err));
        st.meta = st.meta || {};
      }
      renderFiles();
    }
    if (!$('ownKw').value.trim()) $('ownKw').value = suggestKeywords();
    recompute();
  }

  async function readPdf(file) {
    const data = new Uint8Array(await file.arrayBuffer());
    const task = pdfjsLib.getDocument({ data });
    task.onPassword = (cb, reason) => {
      const pw = prompt(`${file.name} is password protected.${reason === 2 ? ' Wrong password, try again.' : ''}\nEnter password:`);
      if (pw === null) task.destroy(); else cb(pw);
    };
    const doc = await task.promise;
    const pages = [];
    for (let p = 1; p <= doc.numPages; p++) {
      const page = await doc.getPage(p);
      const tc = await page.getTextContent();
      pages.push({
        items: tc.items.filter(i => i.str && i.str.trim()).map(i => ({
          x: i.transform[4], y: i.transform[5], w: i.width,
          h: i.height || Math.hypot(i.transform[2], i.transform[3]), s: i.str.trim()
        }))
      });
    }
    return pages;
  }

  function suggestKeywords() {
    const names = state.statements.filter(s => s.meta && s.meta.name).map(s => s.meta.name);
    const counts = {};
    names.forEach(n => { const k = P.defaultOwnKeyword(n); if (k) counts[k] = (counts[k] || 0) + 1; });
    const best = Object.keys(counts).sort((a, b) => counts[b] - counts[a])[0];
    return best ? best : '';
  }

  // ---------- derived data ----------
  function recompute() {
    const good = state.statements.filter(s => s.status !== 'busy' && !s.error && s.transactions);
    const kws = $('ownKw').value.split(',').map(s => s.trim()).filter(Boolean);
    const own = P.ownMatcher(good.map(s => s.meta.account), kws);
    state.txns = [];
    good.forEach(st => st.transactions.forEach((t, i) => {
      let party = P.counterparty(t.description);
      const category = P.categorize(t, own, party);
      if (/^Interest|Bank Charges/.test(category)) party = (st.meta.bank || 'BANK').toUpperCase();
      if (/^Own Account/.test(category)) {
        const a = own.accountIn(t.description);
        const other = a && a !== st.meta.account && good.find(g => g.meta.account === a);
        party = other ? `OWN A/C – ${label(other).toUpperCase()}` : 'OWN ACCOUNT TRANSFER';
      }
      state.txns.push({ ...t, st, seq: i + 1, category, party: party || 'UNIDENTIFIED', channel: P.channel(t.description, t.chq) });
    }));
    render(good);
  }

  // ---------- rendering ----------
  function renderFiles() {
    $('files').innerHTML = state.statements.map(st => {
      const s = st.summary;
      const badge = st.status === 'busy' ? '<span class="badge busy">Reading…</span>'
        : st.error ? '<span class="badge bad">Failed</span>'
        : s.reconciled ? '<span class="badge ok">Reconciled</span>'
        : `<span class="badge warn">Check: diff ${inr(s.difference)}</span>`;
      const meta = st.error ? esc(st.error)
        : st.meta ? `${esc(st.meta.bank || 'Unknown bank')} · A/c ${esc(st.meta.account || '?')} · ${st.transactions ? st.transactions.length : 0} txns` : '';
      const warns = (st.warnings || []).slice(0, 4).map(w => `<li>${esc(w)}</li>`).join('');
      return `<div class="file"><span class="nm" title="${esc(st.fileName)}">${esc(st.fileName)}</span>${badge}<span class="meta">${meta}</span>
        <button class="x" data-id="${st.id}" title="Remove">✕</button>${warns ? `<ul class="warnlist">${warns}</ul>` : ''}</div>`;
    }).join('');
    $('files').querySelectorAll('.x').forEach(b => b.onclick = () => {
      state.statements = state.statements.filter(s => s.id !== +b.dataset.id);
      renderFiles(); recompute();
    });
  }

  function totals(txns) {
    const r = { cr: 0, dr: 0, ncr: 0, ndr: 0 };
    txns.forEach(t => { if (t.credit) { r.cr += t.credit; r.ncr++; } if (t.debit) { r.dr += t.debit; r.ndr++; } });
    return r;
  }

  function aggregate(key) {
    const m = new Map();
    state.txns.forEach(t => {
      const k = t[key];
      const o = m.get(k) || { key: k, n: 0, cr: 0, dr: 0 };
      o.n++; o.cr += t.credit; o.dr += t.debit; m.set(k, o);
    });
    return [...m.values()];
  }

  function render(good) {
    const has = good.length > 0;
    $('results').hidden = !has;
    $('btnExcel').disabled = !has;
    $('btnClear').disabled = state.statements.length === 0;
    if (!has) return;

    const sum = k => good.reduce((s, st) => s + (st.summary[k] || 0), 0);
    const ownIn = state.txns.filter(t => t.category === 'Own Account Transfer In').reduce((s, t) => s + t.credit, 0);
    const ownOut = state.txns.filter(t => t.category === 'Own Account Transfer Out').reduce((s, t) => s + t.debit, 0);
    const T = totals(state.txns);
    const cards = [
      ['Accounts', good.length, `${state.txns.length} transactions`],
      ['Opening balance (all)', inr(sum('opening')), ''],
      ['Total credits', inr(T.cr), `${T.ncr} entries`, 'cr'],
      ['Total debits', inr(T.dr), `${T.ndr} entries`, 'dr'],
      ['Closing balance (all)', inr(sum('closing')), ''],
      ['External receipts', inr(T.cr - ownIn), `excl. own transfers ${inr(ownIn)}`, 'cr'],
      ['External payments', inr(T.dr - ownOut), `excl. own transfers ${inr(ownOut)}`, 'dr']
    ];
    $('cards').innerHTML = cards.map(c => `<div class="card"><div class="k">${c[0]}</div><div class="v ${c[3] || ''}">${c[1]}</div><div class="s">${c[2]}</div></div>`).join('');

    // accounts
    const rows = good.map(st => {
      const s = st.summary;
      return `<tr><td>${esc(st.meta.bank || '')}</td><td>${esc(st.meta.account)}</td><td>${P.fmtDate(s.from)} – ${P.fmtDate(s.to)}</td>
        <td class="n">${inr(s.opening)}</td><td class="n cr">${inr(s.totalCredit)}</td><td class="n">${s.creditCount}</td>
        <td class="n dr">${inr(s.totalDebit)}</td><td class="n">${s.debitCount}</td><td class="n">${inr(s.closing)}</td>
        <td>${s.reconciled ? '<span class="badge ok">✓ Tallies</span>' : `<span class="badge warn">Diff ${inr(s.difference)}</span>`}</td></tr>`;
    }).join('');
    $('tblAccounts').innerHTML = `<thead><tr><th>Bank</th><th>Account</th><th>Period</th><th class="n">Opening</th><th class="n">Credits</th><th class="n">#</th><th class="n">Debits</th><th class="n">#</th><th class="n">Closing</th><th>Status</th></tr></thead>
      <tbody>${rows}</tbody><tfoot><tr><td colspan="3">Total</td><td class="n">${inr(sum('opening'))}</td><td class="n">${inr(sum('totalCredit'))}</td><td class="n">${sum('creditCount')}</td>
      <td class="n">${inr(sum('totalDebit'))}</td><td class="n">${sum('debitCount')}</td><td class="n">${inr(sum('closing'))}</td><td></td></tr></tfoot>`;

    // categories
    const cats = aggregate('category').sort((a, b) => (b.cr + b.dr) - (a.cr + a.dr));
    $('tblCats').innerHTML = `<thead><tr><th>Category</th><th class="n">#</th><th class="n">Credit</th><th class="n">Debit</th></tr></thead><tbody>` +
      cats.map(c => `<tr><td>${esc(c.key)}</td><td class="n">${c.n}</td><td class="n cr">${c.cr ? inr(c.cr) : ''}</td><td class="n dr">${c.dr ? inr(c.dr) : ''}</td></tr>`).join('') + '</tbody>';

    // counterparties
    const parties = aggregate('party').sort((a, b) => (b.cr + b.dr) - (a.cr + a.dr)).slice(0, 15);
    $('tblParties').innerHTML = `<thead><tr><th>Counterparty</th><th class="n">#</th><th class="n">Received</th><th class="n">Paid</th></tr></thead><tbody>` +
      parties.map(c => `<tr><td>${esc(c.key)}</td><td class="n">${c.n}</td><td class="n cr">${c.cr ? inr(c.cr) : ''}</td><td class="n dr">${c.dr ? inr(c.dr) : ''}</td></tr>`).join('') + '</tbody>';

    // filters
    const fAcc = $('fAcc'), prevAcc = fAcc.value, fCat = $('fCat'), prevCat = fCat.value;
    fAcc.innerHTML = '<option value="">All accounts</option>' + good.map(st => `<option value="${st.id}">${esc(label(st))}</option>`).join('');
    fAcc.value = good.some(s => String(s.id) === prevAcc) ? prevAcc : '';
    fCat.innerHTML = '<option value="">All categories</option>' + cats.map(c => `<option>${esc(c.key)}</option>`).join('');
    fCat.value = cats.some(c => c.key === prevCat) ? prevCat : '';
    renderTxns();
  }

  function filtered() {
    const acc = $('fAcc').value, ty = $('fType').value, cat = $('fCat').value, q = $('fSearch').value.trim().toLowerCase();
    return state.txns.filter(t => (!acc || String(t.st.id) === acc) && (!ty || (ty === 'cr' ? t.credit : t.debit)) &&
      (!cat || t.category === cat) && (!q || (t.description + ' ' + t.party + ' ' + t.chq).toLowerCase().includes(q)));
  }

  function renderTxns() {
    const list = filtered();
    const T = totals(list);
    const MAX = 2000;
    $('fCount').textContent = `${list.length} rows · Cr ${inr(T.cr)} · Dr ${inr(T.dr)}`;
    $('tblTxns').innerHTML = `<thead><tr><th>Account</th><th>Date</th><th>Description</th><th>Chq</th><th class="n">Debit</th><th class="n">Credit</th><th class="n">Balance</th><th>Category</th><th>Counterparty</th></tr></thead><tbody>` +
      list.slice(0, MAX).map(t => `<tr><td>${esc(label(t.st))}</td><td>${P.fmtDate(t.date)}</td><td class="desc">${esc(t.description)}</td><td>${esc(t.chq)}</td>
        <td class="n dr">${t.debit ? inr(t.debit) : ''}</td><td class="n cr">${t.credit ? inr(t.credit) : ''}</td><td class="n">${inr(t.balance)}</td>
        <td><span class="tag">${esc(t.category)}</span></td><td>${esc(t.party)}</td></tr>`).join('') +
      (list.length > MAX ? `<tr><td colspan="9" class="muted">Showing first ${MAX} rows — the Excel file contains all.</td></tr>` : '') + '</tbody>';
  }
  ['fAcc', 'fType', 'fCat'].forEach(id => $(id).addEventListener('change', renderTxns));
  $('fSearch').addEventListener('input', renderTxns);
  $('btnApply').addEventListener('click', recompute);
  $('ownKw').addEventListener('keydown', e => { if (e.key === 'Enter') recompute(); });
  $('btnClear').addEventListener('click', () => { state.statements = []; state.txns = []; $('ownKw').value = ''; renderFiles(); recompute(); });

  // ---------- Excel export ----------
  const NUM = '#,##0.00';
  function sheet(aoa, widths, numCols, dateCols, startRow) {
    const ws = XLSX.utils.aoa_to_sheet(aoa, { cellDates: true });
    const range = XLSX.utils.decode_range(ws['!ref']);
    for (let r = startRow || 1; r <= range.e.r; r++) {
      numCols.forEach(c => { const cell = ws[XLSX.utils.encode_cell({ r, c })]; if (cell && cell.t === 'n') cell.z = NUM; });
      (dateCols || []).forEach(c => { const cell = ws[XLSX.utils.encode_cell({ r, c })]; if (cell && cell.t === 'd') cell.z = 'dd/mm/yyyy'; });
    }
    ws['!cols'] = widths.map(w => ({ wch: w }));
    return ws;
  }
  const d = x => x ? new Date(x.getUTCFullYear(), x.getUTCMonth(), x.getUTCDate()) : '';
  const v = x => (x === 0 || x) ? x : '';

  function exportExcel() {
    const good = state.statements.filter(s => !s.error && s.transactions);
    const wb = XLSX.utils.book_new();
    const company = (good.find(s => s.meta.name) || { meta: {} }).meta.name || '';

    // Summary
    const head = ['Bank', 'Account No', 'Account Name', 'Source File', 'From', 'To', 'Opening Balance', 'No. of Credits', 'Total Credits',
      'No. of Debits', 'Total Debits', 'Closing Balance (Statement)', 'Closing (Calculated)', 'Difference', 'Status', 'Own Transfers In', 'Own Transfers Out'];
    const aoa = [[`Bank Statement Summary${company ? ' — ' + company : ''}`], [`Generated ${new Date().toLocaleString('en-IN')}`], [], head];
    good.forEach(st => {
      const s = st.summary, tx = state.txns.filter(t => t.st === st);
      aoa.push([st.meta.bank || '', st.meta.account, st.meta.name || '', st.fileName, d(s.from), d(s.to), v(s.opening), s.creditCount, s.totalCredit,
        s.debitCount, s.totalDebit, v(s.closing), v(s.calcClosing), v(s.difference), s.reconciled ? 'Reconciled' : 'Check',
        tx.filter(t => t.category === 'Own Account Transfer In').reduce((a, t) => a + t.credit, 0),
        tx.filter(t => t.category === 'Own Account Transfer Out').reduce((a, t) => a + t.debit, 0)]);
    });
    const first = 5, last = 4 + good.length;
    const totRow = ['TOTAL', '', '', '', '', ''];
    ['G', 'H', 'I', 'J', 'K', 'L', 'M', 'N'].forEach(c => totRow.push({ f: `SUM(${c}${first}:${c}${last})` }));
    totRow.push('', { f: `SUM(P${first}:P${last})` }, { f: `SUM(Q${first}:Q${last})` });
    aoa.push(totRow, []);
    const r0 = aoa.length + 1;
    aoa.push(['Consolidated view'], ['Total credits (all accounts)', { f: `I${last + 1}` }], ['Less: own-account transfers in', { f: `P${last + 1}` }],
      ['External receipts', { f: `B${r0 + 1}-B${r0 + 2}` }], ['Total debits (all accounts)', { f: `K${last + 1}` }], ['Less: own-account transfers out', { f: `Q${last + 1}` }],
      ['External payments', { f: `B${r0 + 4}-B${r0 + 5}` }], ['Net external flow', { f: `B${r0 + 3}-B${r0 + 6}` }]);
    const wsS = sheet(aoa, [26, 20, 32, 34, 12, 12, 18, 10, 18, 10, 18, 20, 20, 14, 12, 18, 18], [1, 6, 8, 10, 11, 12, 13, 15, 16], [4, 5], 3);
    // number-format formula cells too
    Object.keys(wsS).forEach(k => { if (k[0] !== '!' && wsS[k].f) wsS[k].z = NUM; });
    ['H', 'J'].forEach(c => { const cell = wsS[`${c}${last + 1}`]; if (cell) cell.z = '0'; });
    for (let r = first; r <= last; r++) ['H', 'J'].forEach(c => { const cell = wsS[`${c}${r}`]; if (cell) cell.z = '0'; });
    good.forEach((st, i) => { const c = wsS[`B${first + i}`]; if (c) { c.t = 's'; c.v = String(st.meta.account); delete c.z; } });
    XLSX.utils.book_append_sheet(wb, wsS, 'Summary');

    // Category summary (with per-account split)
    const cats = aggregate('category').sort((a, b) => (b.cr + b.dr) - (a.cr + a.dr));
    const cAoa = [['Category', 'No. of Txns', 'Credit', 'Debit', 'Net (Cr - Dr)', ...good.flatMap(st => [`${label(st)} Cr`, `${label(st)} Dr`])]];
    cats.forEach(c => {
      const per = good.flatMap(st => {
        const tx = state.txns.filter(t => t.st === st && t.category === c.key);
        return [tx.reduce((a, t) => a + t.credit, 0), tx.reduce((a, t) => a + t.debit, 0)];
      });
      cAoa.push([c.key, c.n, c.cr, c.dr, c.cr - c.dr, ...per]);
    });
    XLSX.utils.book_append_sheet(wb, sheet(cAoa, [28, 11, 18, 18, 18, ...good.flatMap(() => [16, 16])], [2, 3, 4, ...good.flatMap((_, i) => [5 + 2 * i, 6 + 2 * i])]), 'Category Summary');

    // Counterparty summary
    const parties = aggregate('party').sort((a, b) => (b.cr + b.dr) - (a.cr + a.dr));
    const pAoa = [['Counterparty', 'No. of Txns', 'Received (Cr)', 'Paid (Dr)', 'Net (Cr - Dr)']];
    parties.forEach(c => pAoa.push([c.key, c.n, c.cr, c.dr, c.cr - c.dr]));
    XLSX.utils.book_append_sheet(wb, sheet(pAoa, [40, 11, 18, 18, 18], [2, 3, 4]), 'Counterparty Summary');

    // Date-wise
    const byDate = new Map();
    state.txns.forEach(t => { const k = t.date ? t.date.getTime() : 0; const o = byDate.get(k) || { date: t.date, cr: 0, dr: 0, n: 0 }; o.cr += t.credit; o.dr += t.debit; o.n++; byDate.set(k, o); });
    const dAoa = [['Date', 'No. of Txns', 'Credits', 'Debits', 'Net']];
    [...byDate.values()].sort((a, b) => a.date - b.date).forEach(o => dAoa.push([d(o.date), o.n, o.cr, o.dr, o.cr - o.dr]));
    XLSX.utils.book_append_sheet(wb, sheet(dAoa, [12, 11, 18, 18, 18], [2, 3, 4], [0]), 'Date-wise');

    // All transactions
    const txHead = ['Bank', 'Account No', 'S.No', 'Txn Date', 'Value Date', 'Description', 'Cheque No', 'Debit', 'Credit', 'Balance', 'Channel', 'Category', 'Counterparty'];
    const tAoa = [txHead];
    state.txns.forEach(t => tAoa.push([t.st.meta.bank || '', String(t.st.meta.account), t.seq, d(t.date), d(t.valueDate), t.description, t.chq, v(t.debit || ''), v(t.credit || ''), v(t.balance), t.channel, t.category, t.party]));
    XLSX.utils.book_append_sheet(wb, sheet(tAoa, [20, 18, 6, 11, 11, 60, 10, 16, 16, 18, 16, 24, 32], [7, 8, 9], [3, 4]), 'All Transactions');

    // One sheet per account
    const used = new Set(wb.SheetNames);
    good.forEach(st => {
      let name = label(st).replace(/[\\\/?*\[\]:]/g, '').slice(0, 28);
      let n = name, i = 2; while (used.has(n)) n = `${name.slice(0, 26)} ${i++}`; used.add(n);
      const s = st.summary;
      const a = [[`${st.meta.bank || ''} — A/c ${st.meta.account}`], [`Period ${P.fmtDate(s.from)} to ${P.fmtDate(s.to)}`],
        ['Opening Balance', v(s.opening)], ['Total Credits', s.totalCredit], ['Total Debits', s.totalDebit], ['Closing Balance', v(s.closing)], [],
        ['S.No', 'Txn Date', 'Value Date', 'Description', 'Cheque No', 'Debit', 'Credit', 'Balance', 'Channel', 'Category', 'Counterparty']];
      state.txns.filter(t => t.st === st).forEach(t => a.push([t.seq, d(t.date), d(t.valueDate), t.description, t.chq, v(t.debit || ''), v(t.credit || ''), v(t.balance), t.channel, t.category, t.party]));
      const ws = sheet(a, [16, 11, 11, 60, 10, 16, 16, 18, 16, 24, 32], [1, 5, 6, 7], [1, 2], 2);
      XLSX.utils.book_append_sheet(wb, ws, n);
    });

    const stamp = new Date().toISOString().slice(0, 10);
    XLSX.writeFile(wb, `Bank_Statement_Summary_${stamp}.xlsx`);
  }
  $('btnExcel').addEventListener('click', exportExcel);
})();
