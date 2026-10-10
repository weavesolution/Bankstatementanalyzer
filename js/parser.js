/*
 * Bank statement PDF parser (runs fully in the browser; also loadable in Node for testing).
 * Input: pages extracted with pdf.js -> [{ items: [{x, y, w, h, s}] }]
 * Works on column-based statements by locating the table header, building column
 * ranges from it and grouping wrapped cell text into transaction records.
 */
(function (root) {
  'use strict';

  // ---------- small helpers ----------
  const DATE_RE = /^(\d{1,2})[\/\-. ](\d{1,2}|[A-Za-z]{3})[\/\-. ](\d{2,4})(?:\s+\d{1,2}:\d{2}(?::\d{2}(?:\.\d+)?)?)?$/;
  const ISO_RE = /^(\d{4})-(\d{2})-(\d{2})(?:[ T]\d{1,2}:\d{2}(?::\d{2}(?:\.\d+)?)?)?$/;
  const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
  const AMT_RE = /^(?:INR|Rs\.?|₹)?\s*-?\s*[\d,]*\d(?:\.\d*)?\s*(?:Dr\.?|Cr\.?|DR|CR)?$|^(?:INR|Rs\.?|₹)?\s*-?\s*[\d,]+\.$/i;

  const IFSC_BANKS = {
    UTIB: 'Axis Bank', IBKL: 'IDBI Bank', IOBA: 'Indian Overseas Bank', PUNB: 'Punjab National Bank',
    SBIN: 'State Bank of India', HDFC: 'HDFC Bank', ICIC: 'ICICI Bank', KKBK: 'Kotak Mahindra Bank',
    CNRB: 'Canara Bank', BARB: 'Bank of Baroda', UBIN: 'Union Bank of India', BKID: 'Bank of India',
    YESB: 'Yes Bank', INDB: 'IndusInd Bank', FDRL: 'Federal Bank', IDFB: 'IDFC First Bank',
    MAHB: 'Bank of Maharashtra', CBIN: 'Central Bank of India', UCBA: 'UCO Bank', IDIB: 'Indian Bank',
    PSIB: 'Punjab & Sind Bank', KARB: 'Karnataka Bank', RATN: 'RBL Bank', BDBL: 'Bandhan Bank'
  };

  function parseDate(s) {
    s = (s || '').trim();
    let m = s.match(ISO_RE);
    if (m) return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
    m = s.match(DATE_RE);
    if (!m) return null;
    let d = +m[1], mo = isNaN(+m[2]) ? MONTHS[m[2].toLowerCase()] : +m[2], y = +m[3];
    if (!mo || mo > 12 || d > 31) return null;
    if (y < 100) y += 2000;
    return new Date(Date.UTC(y, mo - 1, d));
  }
  function isDate(s) { return !!parseDate(s); }

  function parseAmount(s) {
    if (s == null) return null;
    let t = String(s).replace(/INR|Rs\.?|₹/gi, '').replace(/\s+/g, '');
    if (!t) return null;
    let sign = 1;
    if (/(Dr\.?|DR)$/i.test(t)) { sign = -1; t = t.replace(/(Dr\.?|DR)$/i, ''); }
    else if (/(Cr\.?|CR)$/i.test(t)) { t = t.replace(/(Cr\.?|CR)$/i, ''); }
    if (/^-/.test(t)) { sign *= -1; t = t.slice(1); }
    if (/-$/.test(t)) { sign *= -1; t = t.slice(0, -1); }
    t = t.replace(/,/g, '');
    if (!/^\d+(\.\d*)?$|^\d*\.\d+$/.test(t)) {
      // scientific notation e.g. 1.7879E7
      if (/^\d+(\.\d+)?E\d+$/i.test(t)) return sign * parseFloat(t);
      return null;
    }
    return sign * parseFloat(t);
  }
  const round2 = n => Math.round(n * 100) / 100;
  const median = a => { if (!a.length) return 0; const b = [...a].sort((x, y) => x - y); return b[Math.floor(b.length / 2)]; };
  const fmtDate = d => d ? `${String(d.getUTCDate()).padStart(2, '0')}/${String(d.getUTCMonth() + 1).padStart(2, '0')}/${d.getUTCFullYear()}` : '';

  function groupLines(items, tol) {
    const sorted = [...items].sort((a, b) => b.y - a.y || a.x - b.x);
    const lines = [];
    for (const it of sorted) {
      const last = lines[lines.length - 1];
      if (last && Math.abs(last.y - it.y) <= tol) last.items.push(it);
      else lines.push({ y: it.y, items: [it] });
    }
    lines.forEach(l => l.items.sort((a, b) => a.x - b.x));
    lines.forEach(l => (l.text = l.items.map(i => i.s).join(' ')));
    return lines;
  }

  // ---------- header detection ----------
  function classify(label) {
    const l = label.toLowerCase().replace(/\s+/g, ' ').trim();
    if (/value\s*d(ate|t)/.test(l)) return 'vdate';
    if (/(cr\s*\/\s*dr|dr\s*\/\s*cr|transaction type|txn type|^type$)/.test(l)) return 'type';
    if (/balance/.test(l)) return 'balance';
    if (/withdraw|debit|dr\.?\s*amount|^dr$|^dr\./.test(l)) return 'debit';
    if (/deposit|credit|cr\.?\s*amount|^cr$|^cr\./.test(l)) return 'credit';
    if (/particular|narration|description/.test(l)) return 'desc';
    if (/date/.test(l)) return 'date';
    if (/cheque|chq|instrument/.test(l)) return 'chq';
    if (/amount/.test(l)) return 'amount';
    if (/details|remarks/.test(l)) return 'desc2';
    return 'other';
  }

  function findHeader(pages) {
    for (let p = 0; p < pages.length; p++) {
      const lines = groupLines(pages[p].items, 2);
      for (const ln of lines) {
        const t = ln.text.toLowerCase();
        if (!/balance/.test(t) || !/date/.test(t)) continue;
        if (!/(particular|narration|description|details|remarks)/.test(t)) continue;
        // collect header items within a vertical window (multi-line headers)
        const win = pages[p].items.filter(i => Math.abs(i.y - ln.y) <= 12);
        // merge stacked fragments into cells
        const its = [...win].sort((a, b) => a.x - b.x);
        const cells = [];
        for (const it of its) {
          const c = cells.find(c => it.x < c.x1 + 2 && it.x + it.w > c.x0 - 2 && !(Math.abs(it.y - c.y) <= 2));
          if (c) { c.parts.push(it); c.x0 = Math.min(c.x0, it.x); c.x1 = Math.max(c.x1, it.x + it.w); }
          else cells.push({ x0: it.x, x1: it.x + it.w, y: it.y, parts: [it] });
        }
        cells.forEach(c => { c.label = c.parts.sort((a, b) => b.y - a.y).map(i => i.s).join(' '); c.key = classify(c.label); });
        cells.sort((a, b) => a.x0 - b.x0);
        // de-duplicate keys: first date = txn date, keep first desc
        let seen = {};
        for (const c of cells) {
          if (c.key === 'desc2') c.key = cells.some(o => o.key === 'desc') ? 'other' : 'desc';
          if (seen[c.key] && c.key !== 'other') c.key = c.key === 'date' ? 'vdate' : 'other';
          seen[c.key] = true;
        }
        const keys = cells.map(c => c.key);
        if (!keys.includes('balance') || !keys.includes('desc') || !(keys.includes('date') || keys.includes('vdate'))) continue;
        if (!keys.includes('amount') && !keys.includes('debit') && !keys.includes('credit')) continue;
        return { page: p, y: ln.y, bottom: Math.min(...win.map(i => i.y)), cells };
      }
    }
    return null;
  }

  function makeColumnizer(cells) {
    const n = cells.length;
    const ranges = cells.map((c, i) => ({ key: c.key, lo: c.x0 - 6, hi: i < n - 1 ? cells[i + 1].x0 - 6 : Infinity }));
    const di = cells.findIndex(c => c.key === 'desc');
    const dLo = di > 0 ? cells[di - 1].x1 + 1 : -Infinity;
    const dHi = di < n - 1 ? cells[di + 1].x0 - 1 : Infinity;
    return function (it) {
      const cx = it.x + it.w / 2;
      if (isFinite(dLo) && isFinite(dHi) && it.w > (dHi - dLo) * 1.6) return 'other';
      const numeric = AMT_RE.test(it.s.trim()) || /^(Dr\.?|Cr\.?)$/i.test(it.s.trim());
      if (cx > dLo && cx < dHi && !(numeric && it.x + it.w > dHi - 4)) return 'desc';
      const ref = numeric ? it.x + it.w - 2 : it.x;
      for (const r of ranges) if (ref >= r.lo && ref < r.hi) return r.key;
      return ref < ranges[0].lo ? ranges[0].key : 'other';
    };
  }

  // ---------- metadata ----------
  function extractMeta(pages) {
    const lines = pages.slice(0, 2).flatMap(p => groupLines(p.items, 2).map(l => l.text));
    const all = lines.join('\n');
    const meta = {};
    let m;
    m = all.match(/IFSC(?:\s*Code)?\s*[:\-]?\s*([A-Z]{4})0[A-Z0-9]{6}/i);
    if (m) meta.ifsc = m[0].match(/[A-Z]{4}0[A-Z0-9]{6}/i)[0].toUpperCase();
    meta.bank = (meta.ifsc && IFSC_BANKS[meta.ifsc.slice(0, 4)]) || null;
    if (!meta.bank) {
      const full = pages.flatMap(p => p.items.map(i => i.s)).join(' ');
      const guesses = [[/IDBI/i, 'IDBI Bank'], [/AXIS BANK/i, 'Axis Bank'], [/Indian Overseas/i, 'Indian Overseas Bank'],
        [/punjab national/i, 'Punjab National Bank'], [/HDFC BANK/i, 'HDFC Bank'], [/ICICI BANK/i, 'ICICI Bank'],
        [/State Bank of India/i, 'State Bank of India'], [/Kotak/i, 'Kotak Mahindra Bank'], [/Bank of Baroda/i, 'Bank of Baroda'], [/Canara/i, 'Canara Bank']];
      for (const [re, b] of guesses) if (re.test(full)) { meta.bank = b; break; }
    }
    m = all.match(/(?:Account|A\/C)\s*(?:No\.?|Number)\s*(?:[-:]|\s)*\s*:?\s*(\d{9,20})/i) || all.match(/\b(\d{11,20})\b/);
    meta.account = m ? m[1] : '';
    m = all.match(/(?:Account Name|Account Holder Name|Customer Name|A\/c Name)\s*:\s*([A-Z][A-Z0-9&.,()' \-]{3,})/i) ||
        all.match(/:\s*([A-Z][A-Z&.\- ]+(?:LIMITED|LTD|LLP|PVT|PRIVATE)[A-Z.]*)/) ||
        all.match(/\b([A-Z][A-Z&.\- ]{3,}(?:LIMITED|LTD|LLP))\b/);
    meta.name = m ? m[1].replace(/\s+/g, ' ').trim() : '';
    m = all.match(/(\d{1,2}[\/\-.](?:\d{1,2}|[A-Za-z]{3})[\/\-.]\d{4})\s*(?:to|-|till)\s*:?\s*(\d{1,2}[\/\-.](?:\d{1,2}|[A-Za-z]{3})[\/\-.]\d{4})/i);
    if (m) { meta.from = parseDate(m[1]); meta.to = parseDate(m[2]); }
    const full = pages.flatMap(p => groupLines(p.items, 2).map(l => l.text)).join('\n');
    m = full.match(/Opening Balance[^\d\-]*(-?\s*[\d,]+\.\d{1,2}\s*(?:Dr|Cr)?)/i);
    if (m) meta.statedOpening = parseAmount(m[1]);
    m = full.match(/Closing Balance[^\d\-]*(-?\s*[\d,]+\.\d{1,2}\s*(?:Dr|Cr)?)/i);
    if (m) meta.statedClosing = parseAmount(m[1]);
    return meta;
  }

  // ---------- main ----------
  function parseStatement(pages, fileName) {
    const res = { fileName, meta: extractMeta(pages), transactions: [], warnings: [] };
    const hdr = findHeader(pages);
    if (!hdr) { res.error = 'Could not find a transaction table header (Date / Description / Balance). Scanned/image PDFs are not supported.'; return res; }
    const col = makeColumnizer(hdr.cells);
    const keys = new Set(hdr.cells.map(c => c.key));

    const allH = [];
    pages.forEach(p => p.items.forEach(i => i.h > 0 && allH.push(i.h)));
    const lineH = median(allH) || 8;
    const maxGap = Math.max(lineH * 1.9, 9);

    // centre-aligned rows? (text above the first date row on the header page)
    let records = [];
    let centerMode = null, lastSpacing = 0;

    for (let p = hdr.page; p < pages.length; p++) {
      const top = p === hdr.page ? hdr.bottom - 1 : Infinity;
      const items = pages[p].items.filter(i => i.y < top).map(i => ({ ...i, col: col(i) }));
      const lines = groupLines(items, 1.5);
      // anchors: a date in the date / value-date column
      let anchors = [];
      lines.forEach((ln, idx) => {
        const has = ln.items.some(i => (i.col === 'date' || i.col === 'vdate') && isDate(i.s));
        if (has) anchors.push(idx);
      });
      // merge anchors that are very close (split date/time cells)
      anchors = anchors.filter((a, k) => k === 0 || lines[anchors[k - 1]].y - lines[a].y > lineH * 0.9);
      if (!anchors.length) continue;
      if (centerMode === null) {
        centerMode = p === hdr.page && anchors[0] > 0;
      }
      const spacings = anchors.slice(1).map((a, k) => lines[anchors[k]].y - lines[a].y);
      if (spacings.length) lastSpacing = median(spacings);
      const maxExt = centerMode ? (lastSpacing ? lastSpacing * 0.6 : lineH * 4) : Infinity;
      const owner = new Array(lines.length).fill(-1);
      anchors.forEach(a => (owner[a] = a));
      lines.forEach((ln, idx) => {
        if (owner[idx] !== -1) return;
        let best = -1, bd = Infinity;
        for (const a of anchors) {
          const dy = lines[a].y - ln.y; // >0 : line below anchor
          if (!centerMode && dy < -1) continue;
          if (Math.abs(dy) < bd) { bd = Math.abs(dy); best = a; }
        }
        owner[idx] = best;
      });
      if (centerMode) {
        // between two anchors, split at the largest vertical gap (cell padding) rather than the midpoint
        for (let k = 0; k + 1 < anchors.length; k++) {
          const A = anchors[k], B = anchors[k + 1];
          if (B - A < 2) continue;
          let cut = A, big = -1;
          for (let i = A; i < B; i++) { const g = lines[i].y - lines[i + 1].y; if (g > big + 0.5) { big = g; cut = i; } }
          for (let i = A + 1; i < B; i++) owner[i] = i <= cut ? A : B;
        }
      }
      // connectivity: accept lines while consecutive gaps are small
      for (const a of anchors) {
        const recLines = [lines[a]];
        // below
        let prevY = lines[a].y;
        for (let i = a + 1; i < lines.length; i++) {
          if (owner[i] !== a) break;
          if (prevY - lines[i].y <= maxGap && lines[a].y - lines[i].y <= maxExt) { recLines.push(lines[i]); prevY = lines[i].y; } else break;
        }
        // above
        prevY = lines[a].y;
        for (let i = a - 1; i >= 0; i--) {
          if (owner[i] !== a) break;
          if (lines[i].y - prevY <= maxGap && lines[i].y - lines[a].y <= maxExt) { recLines.push(lines[i]); prevY = lines[i].y; } else break;
        }
        records.push(recLines.flatMap(l => l.items));
      }
    }

    // build transactions
    const txns = [];
    // wrapped narration: join digit-to-digit breaks (reference numbers) without a space
    const joinDesc = arr => {
      let out = '';
      arr.forEach((i, k) => {
        if (k === 0) { out = i.s; return; }
        const prev = arr[k - 1];
        const glue = Math.abs(prev.y - i.y) >= 1.5 && /\d$/.test(prev.s) && /^\d/.test(i.s);
        out += (glue ? '' : ' ') + i.s;
      });
      return out.replace(/\s+/g, ' ').trim();
    };
    for (const its of records) {
      const by = {};
      its.sort((a, b) => b.y - a.y || a.x - b.x).forEach(i => (by[i.col] = by[i.col] || []).push(i));
      const txt = k => (by[k] || []).map(i => i.s).join(' ').replace(/\s+/g, ' ').trim();
      const num = k => { const t = (by[k] || []).map(i => i.s).join('').trim(); return t ? parseAmount(t) : null; };
      const dateItems = [...(by.date || []), ...(by.vdate || [])].filter(i => isDate(i.s));
      const d = (by.date || []).map(i => parseDate(i.s)).find(Boolean) || dateItems.map(i => parseDate(i.s)).find(Boolean);
      const vd = (by.vdate || []).map(i => parseDate(i.s)).find(Boolean) || null;
      const t = { date: d, valueDate: vd, description: joinDesc(by.desc || []), chq: txt('chq').replace(/^-$/, ''), debit: 0, credit: 0, balance: num('balance') };
      const typeTxt = txt('type');
      if (keys.has('debit') || keys.has('credit')) {
        t.debit = Math.abs(num('debit') || 0);
        t.credit = Math.abs(num('credit') || 0);
      }
      if (keys.has('amount')) {
        const a = Math.abs(num('amount') || 0);
        if (/^(dr|d\b|debit|withdraw)/i.test(typeTxt)) t.debit = a;
        else if (/^(cr|c\b|credit|deposit)/i.test(typeTxt)) t.credit = a;
        else if (a) { t._unsigned = a; }
        const amtRaw = (by.amount || []).map(i => i.s).join('');
        if (!typeTxt && /Dr\.?$/i.test(amtRaw)) { t.debit = a; delete t._unsigned; }
        else if (!typeTxt && /Cr\.?$/i.test(amtRaw)) { t.credit = a; delete t._unsigned; }
      }
      if (!t.date || (!t.debit && !t.credit && !t._unsigned)) {
        if (t.date && t.balance != null && !t.description.match(/opening|b\/f|brought forward/i)) res.warnings.push(`Row on ${fmtDate(t.date)} has no amount: "${t.description.slice(0, 50)}"`);
        continue;
      }
      txns.push(t);
    }

    // chronological order
    if (txns.length > 1 && txns[0].date > txns[txns.length - 1].date) txns.reverse();

    // resolve unsigned amounts via balance movement
    let prev = res.meta.statedOpening != null ? res.meta.statedOpening : null;
    for (let i = 0; i < txns.length; i++) {
      const t = txns[i];
      if (t._unsigned) {
        let base = prev;
        if (base == null && i + 1 < txns.length && txns[i + 1].balance != null) base = null;
        if (base != null && t.balance != null) {
          if (Math.abs(round2(t.balance - base) - t._unsigned) < 0.02) t.credit = t._unsigned; else t.debit = t._unsigned;
        } else t.credit = t._unsigned, res.warnings.push('Direction of first transaction guessed as credit.');
        delete t._unsigned;
      }
      if (t.balance != null) prev = t.balance;
    }

    // opening / closing
    const sumCr = round2(txns.reduce((s, t) => s + t.credit, 0));
    const sumDr = round2(txns.reduce((s, t) => s + t.debit, 0));
    let opening = res.meta.statedOpening, closing = res.meta.statedClosing;
    if (opening == null && txns.length && txns[0].balance != null) opening = round2(txns[0].balance - txns[0].credit + txns[0].debit);
    if (closing == null && txns.length) closing = txns[txns.length - 1].balance;
    const calcClosing = opening != null ? round2(opening + sumCr - sumDr) : null;
    let chainBreaks = 0;
    for (let i = 1; i < txns.length; i++) {
      const a = txns[i - 1].balance, b = txns[i].balance;
      if (a != null && b != null && Math.abs(round2(a + txns[i].credit - txns[i].debit) - b) > 0.02) chainBreaks++;
    }
    res.transactions = txns.map(t => ({ ...t, debit: round2(t.debit), credit: round2(t.credit) }));
    res.summary = {
      opening, closing, calcClosing, totalCredit: sumCr, totalDebit: sumDr,
      creditCount: txns.filter(t => t.credit).length, debitCount: txns.filter(t => t.debit).length,
      reconciled: closing != null && calcClosing != null && Math.abs(closing - calcClosing) < 0.05,
      difference: closing != null && calcClosing != null ? round2(closing - calcClosing) : null,
      chainBreaks,
      from: res.meta.from || (txns[0] && txns[0].date), to: res.meta.to || (txns.length && txns[txns.length - 1].date)
    };
    if (!txns.length) res.error = 'Table header found but no transactions could be read.';
    return res;
  }

  // ---------- classification ----------
  const STOP = /^(neft|rtgs|imps|upi|inb|ift|ib|attn|fast|urgent|na|self|outward|inward|dr|cr|out|in|chrg|charge|charges|tparty transfer|bill payment|clg|by clg|to|by|ach|ipay|inst|nrtgs|ret|neft_out|neft_chrg|trf|transfer|payment|ecs|nach|mmt|ift|net|ac|a\/c|branch)$/i;
  const BANKISH = /\b(bank|sbi|icici|hdfc|axis|idbi|kotak|canara|punjab national|pnb|indian overseas|iob|baroda|boi|indusind|federal|reserve|rbi|ltd bank|banking|razorpay|nsdl)\b/i;

  function counterparty(desc) {
    const segs = desc.replace(/\s+/g, ' ').split(/[\/:_|]|\s-\s|(?<=[A-Za-z0-9])-(?=[A-Za-z0-9])/);
    for (let s of segs) {
      s = s.replace(/^(TO|BY|FROM)\s+/i, '').replace(/[@#].*$/, '').trim();
      s = s.split(' ').filter(tok => (tok.match(/\d/g) || []).length < 4).join(' ').trim();
      if (s.length < 3 || STOP.test(s)) continue;
      const letters = (s.match(/[A-Za-z]/g) || []).length;
      const digits = (s.match(/\d/g) || []).length;
      if (letters < 5 || letters / (letters + digits) < 0.75) continue;
      if (BANKISH.test(s)) continue;
      if (/^[A-Z]{4,5}$/.test(s) && (IFSC_BANKS[s.slice(0, 4)] || /^RBIS|^IOBA/.test(s))) continue;
      if (/^(payment towards|invoice|on ac|bill no)/i.test(s)) continue;
      return s.replace(/\s+/g, ' ').replace(/[\s\-.,&]+$/, '').toUpperCase();
    }
    return '';
  }

  function channel(desc, chq) {
    const d = desc.toUpperCase();
    if (/RTGS/.test(d)) return 'RTGS';
    if (/NEFT/.test(d)) return 'NEFT';
    if (/IMPS/.test(d)) return 'IMPS';
    if (/UPI/.test(d)) return 'UPI';
    if (/\bIFT\b|TPARTY|TRANSFER|\bTRF\b/.test(d)) return 'Internal Transfer';
    if (/\bACH\b|NACH|ECS/.test(d)) return 'ACH/NACH';
    if (/CLG|CLEARING|^\d{6}-|CHQ|CHEQUE/.test(d) || chq) return 'Cheque/Clearing';
    if (/\bDD\b/.test(d)) return 'Demand Draft';
    if (/CASH|ATM|CWDR/.test(d)) return 'Cash';
    if (/INT\.|INTEREST|CHARGE|CHRG|CHG/.test(d)) return 'Bank Internal';
    return 'Other';
  }

  function categorize(t, own, party) {
    const d = t.description, flat = d.replace(/\s+/g, '');
    if (/int\.?coll|^int\.?:|interest|int\.?pd/i.test(flat) || /int\.?\s*coll|int\.\s*:|\binterest\b|int\.?pd/i.test(d)) return t.debit ? 'Interest Charged' : 'Interest Received';
    if (/charge|chrg|chg\b|incidental|sms|commission|stamp duty|\bgst\b|annual fee|ledger folio/i.test(d)) return 'Bank Charges';
    if (/^ret-|return|reversal|dishon|cancl|cancel/i.test(d)) return 'Returns / Reversals';
    if (own.isOwn(d, party == null ? counterparty(d) : party)) return t.credit ? 'Own Account Transfer In' : 'Own Account Transfer Out';
    if (/loan|\bemi\b|ach-dr|repayment|nach/i.test(d)) return 'Loan / EMI';
    return t.credit ? 'Receipts' : 'Payments';
  }

  function ownMatcher(accounts, keywords) {
    const accs = accounts.filter(a => a && a.length >= 9);
    const kws = keywords.map(k => k.toUpperCase().replace(/[^A-Z0-9]/g, '')).filter(k => k.length >= 4);
    return {
      accountIn(desc) { const flat = desc.toUpperCase().replace(/[^A-Z0-9]/g, ''); return accs.find(a => flat.includes(a)) || null; },
      isOwn(desc, party) {
        const D = desc.toUpperCase();
        const flat = D.replace(/[^A-Z0-9]/g, '');
        if (/\/SELF\b|\bSELF\//.test(D)) return true;
        if (accs.some(a => flat.includes(a))) return true;
        const P = (party || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
        return !!P && kws.some(k => P.includes(k) || (P.length >= 6 && k.startsWith(P)));
      }
    };
  }

  function defaultOwnKeyword(name) {
    const w = (name || '').toUpperCase().replace(/[^A-Z ]/g, ' ').split(/\s+/).filter(x => x.length >= 3 && !/^(THE|AND|LTD|LIMITED|PVT|PRIVATE|LLP|M\/S)$/.test(x));
    if (!w.length) return '';
    return w.length > 1 ? `${w[0]} ${w[1].slice(0, 4)}` : w[0];
  }

  const api = { parseStatement, parseAmount, parseDate, fmtDate, counterparty, channel, categorize, ownMatcher, defaultOwnKeyword };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.StatementParser = api;
})(typeof window !== 'undefined' ? window : globalThis);
