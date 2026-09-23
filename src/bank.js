// Banque : import de relevés (CAMT.053 / CSV), rapprochement automatique, connecteurs.
import crypto from 'node:crypto';
import { all, get, run, insert, tx, round2 } from './db.js';
import { registerPayment, createMove, BusinessError } from './business.js';

// ---------- CAMT.053 (format XML standard ISO 20022 fourni par toutes les banques luxembourgeoises) ----------
const tag = (xml, name) => {
  const m = new RegExp(`<(?:\\w+:)?${name}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:\\w+:)?${name}>`).exec(xml);
  return m ? m[1].trim() : null;
};
const tags = (xml, name) => {
  const re = new RegExp(`<(?:\\w+:)?${name}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:\\w+:)?${name}>`, 'g');
  const out = [];
  let m;
  while ((m = re.exec(xml))) out.push(m[1]);
  return out;
};
const decode = (s) => (s || '').replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&apos;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, ' ').trim();

export function parseCamt(xml) {
  const statements = tags(xml, 'Stmt').length ? tags(xml, 'Stmt') : tags(xml, 'Rpt');
  const lines = [];
  for (const st of statements) {
    const iban = decode(tag(tag(st, 'Acct') || '', 'IBAN'));
    for (const ntry of tags(st, 'Ntry')) {
      const amt = Number(decode(tag(ntry, 'Amt')));
      const cd = decode(tag(ntry, 'CdtDbtInd'));
      const date = decode(tag(tag(ntry, 'BookgDt') || '', 'Dt') || tag(tag(ntry, 'BookgDt') || '', 'DtTm') || tag(tag(ntry, 'ValDt') || '', 'Dt')).slice(0, 10);
      const details = tag(ntry, 'NtryDtls') || '';
      const rltd = tag(details, 'RltdPties') || '';
      const party = cd === 'CRDT' ? tag(rltd, 'Dbtr') : tag(rltd, 'Cdtr');
      const partyAcct = cd === 'CRDT' ? tag(rltd, 'DbtrAcct') : tag(rltd, 'CdtrAcct');
      const ustrd = tags(details, 'Ustrd').map(decode).join(' ');
      const strd = decode(tag(details, 'Ref') || tag(details, 'CdtrRefInf') || '');
      const info = decode(tag(ntry, 'AddtlNtryInf'));
      lines.push({
        iban, date, amount: round2(cd === 'DBIT' ? -amt : amt),
        counterparty: decode(tag(party || '', 'Nm')) || null,
        counterparty_iban: decode(tag(partyAcct || '', 'IBAN')) || null,
        communication: [ustrd, strd, info].filter(Boolean).join(' | ') || null,
        ref: decode(tag(ntry, 'AcctSvcrRef') || tag(ntry, 'NtryRef')) || null,
      });
    }
  }
  return lines;
}

// ---------- CSV (détection automatique des colonnes) ----------
function splitCsv(line, sep) {
  const out = [];
  let cur = '', q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') { if (q && line[i + 1] === '"') { cur += '"'; i++; } else q = !q; }
    else if (c === sep && !q) { out.push(cur); cur = ''; }
    else cur += c;
  }
  out.push(cur);
  return out.map((s) => s.trim());
}
function parseAmount(s) {
  if (!s) return NaN;
  s = s.replace(/[€\s]/g, '');
  if (/,\d{1,2}$/.test(s)) s = s.replace(/\./g, '').replace(',', '.');
  else s = s.replace(/,/g, '');
  return Number(s);
}
function parseDate(s) {
  if (!s) return null;
  let m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})/.exec(s);
  if (m) return `${m[3].length === 2 ? '20' + m[3] : m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  return null;
}
export function parseCsv(text) {
  const rows = text.replace(/^﻿/, '').split(/\r?\n/).filter((l) => l.trim());
  if (rows.length < 2) return [];
  const sep = [';', ',', '\t'].sort((a, b) => rows[0].split(b).length - rows[0].split(a).length)[0];
  const head = splitCsv(rows[0], sep).map((h) => h.toLowerCase());
  const find = (...keys) => head.findIndex((h) => keys.some((k) => h.includes(k)));
  const iDate = find('date comptable', 'booking date', 'date', 'datum');
  const iAmount = find('montant', 'amount', 'betrag');
  const iDebit = find('débit', 'debit');
  const iCredit = find('crédit', 'credit');
  const iParty = find('contrepartie', 'bénéficiaire', 'beneficiaire', 'counterparty', 'nom', 'name');
  const iIban = find('iban', 'compte contrepartie');
  const iComm = find('communication', 'libellé', 'libelle', 'description', 'détails', 'details', 'message');
  const out = [];
  for (const r of rows.slice(1)) {
    const c = splitCsv(r, sep);
    let amount = iAmount >= 0 ? parseAmount(c[iAmount]) : NaN;
    if (Number.isNaN(amount) && (iDebit >= 0 || iCredit >= 0)) {
      const d = parseAmount(c[iDebit]) || 0, k = parseAmount(c[iCredit]) || 0;
      amount = k - Math.abs(d);
    }
    const date = parseDate(c[iDate]);
    if (!date || Number.isNaN(amount)) continue;
    out.push({
      date, amount: round2(amount), counterparty: iParty >= 0 ? c[iParty] || null : null,
      counterparty_iban: iIban >= 0 && iIban !== iParty ? c[iIban] || null : null,
      communication: iComm >= 0 ? c[iComm] || null : null,
    });
  }
  return out;
}

export function importLines(bankAccountId, lines) {
  let added = 0, skipped = 0;
  tx(() => {
    for (const l of lines) {
      const hash = crypto.createHash('sha1')
        .update([bankAccountId, l.date, l.amount, l.ref || '', l.counterparty || '', l.communication || ''].join('|')).digest('hex');
      const r = run(`INSERT OR IGNORE INTO bank_lines(bank_account_id,date,amount,counterparty,counterparty_iban,communication,hash) VALUES(?,?,?,?,?,?,?)`,
        bankAccountId, l.date, l.amount, l.counterparty, l.counterparty_iban, l.communication, hash);
      if (r.changes) added++; else skipped++;
    }
    run('UPDATE bank_accounts SET last_sync=? WHERE id=?', new Date().toISOString(), bankAccountId);
  });
  return { added, skipped, ...autoReconcile(bankAccountId) };
}

// ---------- Rapprochement ----------
const norm = (s) => (s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

export function suggestions(line) {
  const out = [];
  const comm = norm(line.communication) + norm(line.counterparty);
  if (line.amount > 0) {
    const open = all(`SELECT d.id, d.number, d.total, d.amount_paid, d.date, c.name AS partner FROM documents d LEFT JOIN customers c ON c.id=d.customer_id
      WHERE d.type='invoice' AND d.status IN ('posted','partial')`);
    for (const d of open) {
      const residual = round2(d.total - d.amount_paid);
      let score = 0;
      if (d.number && comm.includes(norm(d.number))) score += 70;
      if (Math.abs(residual - line.amount) < 0.01) score += 25;
      if (d.partner && norm(line.counterparty).includes(norm(d.partner).slice(0, 8))) score += 15;
      if (score >= 25) out.push({ kind: 'invoice', id: d.id, number: d.number, partner: d.partner, residual, score });
    }
  } else {
    const open = all(`SELECT p.id, p.number, p.supplier_ref, p.total, p.amount_paid, s.name AS partner, s.iban FROM purchases p LEFT JOIN suppliers s ON s.id=p.supplier_id
      WHERE p.posted=1 AND p.status!='paid'`);
    for (const p of open) {
      const residual = round2(p.total - p.amount_paid);
      let score = 0;
      if (p.supplier_ref && comm.includes(norm(p.supplier_ref))) score += 60;
      if (Math.abs(residual + line.amount) < 0.01) score += 25;
      if (p.iban && norm(p.iban) === norm(line.counterparty_iban)) score += 30;
      if (p.partner && norm(line.counterparty).includes(norm(p.partner).slice(0, 8))) score += 15;
      if (score >= 25) out.push({ kind: 'purchase', id: p.id, number: p.supplier_ref || p.number, partner: p.partner, residual, score });
    }
  }
  return out.sort((a, b) => b.score - a.score).slice(0, 5);
}

function bankAccountCode(line) {
  return get('SELECT account_code FROM bank_accounts WHERE id=?', line.bank_account_id)?.account_code || '5131';
}

export function matchLine(lineId, { kind, id }) {
  const line = get('SELECT * FROM bank_lines WHERE id=?', lineId);
  if (!line || line.status !== 'unmatched') throw new BusinessError('Ligne déjà traitée');
  const amount = Math.abs(line.amount);
  const pid = registerPayment({
    document_id: kind === 'invoice' ? id : undefined, purchase_id: kind === 'purchase' ? id : undefined,
    amount, date: line.date, method: 'bank', reference: line.communication, bank_line_id: line.id, bank_account_code: bankAccountCode(line),
  });
  run("UPDATE bank_lines SET status='matched', payment_id=? WHERE id=?", pid, lineId);
  return pid;
}

// Affectation directe à un compte de charge / produit (frais bancaires, loyer, salaires…)
export function assignLine(lineId, accountCode, label) {
  const line = get('SELECT * FROM bank_lines WHERE id=?', lineId);
  if (!line || line.status !== 'unmatched') throw new BusinessError('Ligne déjà traitée');
  if (!get('SELECT code FROM accounts WHERE code=?', accountCode)) throw new BusinessError('Compte inconnu');
  const amt = Math.abs(line.amount);
  const bankAcc = bankAccountCode(line);
  const lbl = label || line.communication || line.counterparty || 'Opération bancaire';
  return tx(() => {
    const moveId = createMove({ journal_code: 'BNK', date: line.date, ref: `BNK-${line.id}`, label: lbl, bank_line_id: line.id },
      line.amount > 0
        ? [{ account_code: bankAcc, label: lbl, debit: amt, credit: 0 }, { account_code: accountCode, label: lbl, debit: 0, credit: amt }]
        : [{ account_code: accountCode, label: lbl, debit: amt, credit: 0 }, { account_code: bankAcc, label: lbl, debit: 0, credit: amt }]);
    run("UPDATE bank_lines SET status='matched', move_id=? WHERE id=?", moveId, lineId);
    return moveId;
  });
}

// Rapprochement automatique : uniquement les correspondances sûres (numéro + montant exact)
export function autoReconcile(bankAccountId) {
  let matched = 0;
  const lines = all("SELECT * FROM bank_lines WHERE status='unmatched'" + (bankAccountId ? ' AND bank_account_id=?' : ''), ...(bankAccountId ? [bankAccountId] : []));
  for (const l of lines) {
    const s = suggestions(l)[0];
    if (s && s.score >= 95 && Math.abs(s.residual - Math.abs(l.amount)) < 0.01) {
      try { matchLine(l.id, s); matched++; } catch { /* ignore */ }
    }
  }
  return { matched };
}

// ---------- Connecteurs de synchronisation directe ----------
// La synchronisation automatique passe par un agrégateur PSD2 agréé (ex. Ponto / Isabel Group, qui couvre
// BCEE, BGL BNP Paribas, BIL, POST Finance, Raiffeisen, ING Luxembourg). Un contrat avec le fournisseur
// est nécessaire ; en attendant, l'import CAMT.053 (disponible dans toutes les banques en ligne) fonctionne.
export const PROVIDERS = {
  import: { name: 'Import manuel (CAMT.053 / CSV)', ready: true },
  ponto: { name: 'Ponto (Isabel Group) — PSD2', ready: false },
};

export async function syncAccount(bankAccountId) {
  const acc = get('SELECT * FROM bank_accounts WHERE id=?', bankAccountId);
  if (!acc) throw new BusinessError('Compte introuvable', 404);
  if (acc.provider === 'import') throw new BusinessError('Ce compte est en import manuel : importez un relevé CAMT.053 ou CSV.');
  throw new BusinessError(`Le connecteur « ${PROVIDERS[acc.provider]?.name || acc.provider} » nécessite des identifiants API du fournisseur. Voir README > Banque.`);
}
