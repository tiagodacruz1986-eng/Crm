// Banque : import de relevés (CAMT.053 / CSV), rapprochement automatique, connecteurs.
import crypto from 'node:crypto';
import { db, all, get, run, insert, tx, round2, isDate, getSettings } from './db.js';
import { registerPayment, createMove, refreshPaymentStatus, BusinessError } from './business.js';

// Part d'une opération bancaire déjà affectée (un virement peut régler plusieurs factures)
if (!all('PRAGMA table_info(bank_lines)').some((c) => c.name === 'allocated')) db.exec('ALTER TABLE bank_lines ADD COLUMN allocated REAL DEFAULT 0');

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
  // « 45,00 EUR », « 12,50- », « (12,50) », « 1.234,56 € » …
  s = String(s).replace(/[€\s ]|[A-Za-z]{3}/g, '');
  let neg = false;
  if (/^\(.*\)$/.test(s)) { neg = true; s = s.slice(1, -1); }
  if (/-$/.test(s)) { neg = true; s = s.slice(0, -1); }
  if (!/^[+-]?[\d.,']+$/.test(s)) return NaN;
  s = s.replace(/'/g, '');
  if (/,\d{1,2}$/.test(s)) s = s.replace(/\./g, '').replace(',', '.');
  else s = s.replace(/,/g, '');
  const n = Number(s);
  return neg ? -n : n;
}
function parseDate(s) {
  if (!s) return null;
  s = String(s).trim();
  let m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s) || /^(\d{4})(\d{2})(\d{2})$/.exec(s);
  let d = m ? `${m[1]}-${m[2]}-${m[3]}` : null;
  if (!d && (m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})/.exec(s))) d = `${m[3].length === 2 ? '20' + m[3] : m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  return d && isDate(d) ? d : null; // 31/02 n'existe pas
}
// En-têtes comparés sans accents ni majuscules ; un fichier « Windows » mal décodé (D�bit) est reconnu aussi
const headKey = (h) => h.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/�/g, 'e').trim();
/**
 * Lit un relevé CSV. Renvoie la liste des opérations ; `.rejected` = nombre de lignes non comprises
 * (date ou montant illisible), pour pouvoir le signaler au lieu de les perdre en silence.
 */
export function parseCsv(text) {
  const rows = text.replace(/^﻿/, '').split(/\r?\n/).filter((l) => l.trim());
  const out = [];
  out.rejected = 0;
  if (rows.length < 2) return out;
  const sep = [';', ',', '\t'].sort((a, b) => rows[0].split(b).length - rows[0].split(a).length)[0];
  const head = splitCsv(rows[0], sep).map(headKey);
  // la première clé de la liste qui correspond gagne (« date comptable » avant « date valeur »)
  const find = (keys, skip = () => false) => { for (const k of keys) { const i = head.findIndex((h) => h.includes(k) && !skip(h)); if (i >= 0) return i; } return -1; };
  const isDebit = (h) => /debit|sortie|ausgang/.test(h), isCredit = (h) => /credit|entree|eingang/.test(h);
  const iDate = find(['date comptable', 'date operation', 'date d\'operation', 'booking date', 'buchungsdatum', 'date', 'datum']);
  const iDebit = head.findIndex(isDebit);
  const iCredit = head.findIndex(isCredit);
  // la colonne « Montant » unique ne doit pas être confondue avec « Montant débit » / « Montant crédit »
  const iAmount = find(['montant', 'amount', 'betrag'], (h) => isDebit(h) || isCredit(h));
  const iParty = find(['contrepartie', 'beneficiaire', 'counterparty', 'nom', 'name'], (h) => /compte|iban|account/.test(h));
  const iIban = find(['iban', 'compte contrepartie', 'compte de contrepartie']);
  const iComm = find(['communication', 'libelle', 'description', 'details', 'message', 'verwendungszweck']);
  for (const r of rows.slice(1)) {
    const c = splitCsv(r, sep);
    let amount = NaN;
    if (iDebit >= 0 || iCredit >= 0) {
      const d = parseAmount(c[iDebit]), k = parseAmount(c[iCredit]);
      if (!Number.isNaN(d) || !Number.isNaN(k)) amount = (k || 0) - Math.abs(d || 0);
    }
    if (Number.isNaN(amount) && iAmount >= 0) amount = parseAmount(c[iAmount]);
    const date = parseDate(c[iDate]);
    if (!date || Number.isNaN(amount)) { out.rejected++; continue; }
    out.push({
      date, amount: round2(amount), counterparty: iParty >= 0 ? c[iParty] || null : null,
      counterparty_iban: iIban >= 0 && iIban !== iParty ? c[iIban] || null : null,
      communication: iComm >= 0 ? c[iComm] || null : null,
    });
  }
  return out;
}

export function importLines(bankAccountId, lines) {
  if (!get('SELECT 1 FROM bank_accounts WHERE id=?', bankAccountId)) throw new BusinessError('Compte bancaire introuvable', 404);
  let added = 0, skipped = 0;
  const seen = {};
  tx(() => {
    for (const l of lines) {
      // Deux opérations identiques le même jour (deux paiements par carte de 25 €) sont deux vraies opérations :
      // la 2e reçoit un numéro d'ordre, ainsi réimporter le même fichier ne crée toujours aucun doublon
      const key = [bankAccountId, l.date, l.amount, l.ref || '', l.counterparty || '', l.communication || ''].join('|');
      const n = seen[key] = (seen[key] || 0) + 1;
      const hash = crypto.createHash('sha1').update(n > 1 && !l.ref ? `${key}#${n}` : key).digest('hex');
      const r = run(`INSERT OR IGNORE INTO bank_lines(bank_account_id,date,amount,counterparty,counterparty_iban,communication,hash) VALUES(?,?,?,?,?,?,?)`,
        bankAccountId, l.date, l.amount, l.counterparty, l.counterparty_iban, l.communication, hash);
      if (r.changes) added++; else skipped++;
    }
    run('UPDATE bank_accounts SET last_sync=? WHERE id=?', new Date().toISOString(), bankAccountId);
  });
  return { added, skipped, rejected: lines.rejected || 0, ...autoReconcile(bankAccountId) };
}

// ---------- Rapprochement ----------
const norm = (s) => (s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

/** Montant de l'opération qui reste à affecter (un virement peut régler plusieurs factures). */
export const remainingOf = (line) => round2(Math.abs(line.amount) - (Number(line.allocated) || 0));

export function suggestions(line) {
  const out = [];
  const comm = norm(line.communication) + norm(line.counterparty);
  const rest = remainingOf(line);
  if (line.amount > 0) {
    const open = all(`SELECT d.id, d.number, d.total, d.amount_paid, d.date, c.name AS partner FROM documents d LEFT JOIN customers c ON c.id=d.customer_id
      WHERE d.type='invoice' AND d.status IN ('posted','partial')`);
    for (const d of open) {
      const residual = round2(d.total - d.amount_paid);
      if (residual <= 0.009) continue;
      let score = 0;
      if (d.number && comm.includes(norm(d.number))) score += 70;
      if (Math.abs(residual - rest) < 0.01) score += 25;
      if (d.partner && norm(d.partner).length >= 3 && norm(line.counterparty).includes(norm(d.partner).slice(0, 8))) score += 15;
      if (score >= 25) out.push({ kind: 'invoice', id: d.id, number: d.number, partner: d.partner, residual, score });
    }
  } else {
    const open = all(`SELECT p.id, p.number, p.supplier_ref, p.total, p.amount_paid, s.name AS partner, s.iban FROM purchases p LEFT JOIN suppliers s ON s.id=p.supplier_id
      WHERE p.posted=1 AND p.status!='paid'`);
    for (const p of open) {
      const residual = round2(p.total - p.amount_paid);
      if (residual <= 0.009) continue;
      let score = 0;
      if (p.supplier_ref && norm(p.supplier_ref).length >= 3 && comm.includes(norm(p.supplier_ref))) score += 60;
      if (Math.abs(residual - rest) < 0.01) score += 25;
      if (p.iban && norm(p.iban) === norm(line.counterparty_iban)) score += 30;
      if (p.partner && norm(p.partner).length >= 3 && norm(line.counterparty).includes(norm(p.partner).slice(0, 8))) score += 15;
      if (score >= 25) out.push({ kind: 'purchase', id: p.id, number: p.supplier_ref || p.number, partner: p.partner, residual, score });
    }
  }
  return out.sort((a, b) => b.score - a.score).slice(0, 5);
}

function bankAccountCode(line) {
  return get('SELECT account_code FROM bank_accounts WHERE id=?', line.bank_account_id)?.account_code || '5131';
}

/**
 * Rapproche une opération bancaire d'une facture client (argent reçu) ou d'une facture fournisseur (argent sorti).
 * Le paiement est limité au reste dû du document : si le virement est plus élevé, le surplus reste à affecter
 * (à une autre facture, ou à un compte) et l'opération reste « à rapprocher ».
 */
export function matchLine(lineId, { kind, id } = {}) {
  return tx(() => {
    const line = get('SELECT * FROM bank_lines WHERE id=?', lineId);
    if (!line || line.status !== 'unmatched') throw new BusinessError('Ligne déjà traitée');
    if (!['invoice', 'purchase'].includes(kind)) throw new BusinessError('Type de document inconnu');
    // Sens de l'opération : une entrée d'argent pour une facture client, une sortie pour un fournisseur
    if ((kind === 'invoice') !== (line.amount > 0)) throw new BusinessError(kind === 'invoice' ? 'Cette opération est une sortie d\'argent : elle ne peut pas encaisser une facture client.' : 'Cette opération est une entrée d\'argent : elle ne peut pas payer une facture fournisseur.');
    const target = kind === 'invoice' ? get("SELECT total, amount_paid FROM documents WHERE id=? AND type='invoice'", id) : get('SELECT total, amount_paid FROM purchases WHERE id=?', id);
    if (!target) throw new BusinessError('Document introuvable', 404);
    const rest = remainingOf(line);
    const amount = Math.min(rest, round2(target.total - target.amount_paid));
    const pid = registerPayment({
      document_id: kind === 'invoice' ? id : undefined, purchase_id: kind === 'purchase' ? id : undefined,
      amount, date: line.date, method: 'bank', reference: line.communication, bank_line_id: line.id, bank_account_code: bankAccountCode(line),
    });
    const left = round2(rest - amount);
    run('UPDATE bank_lines SET allocated=ROUND(COALESCE(allocated,0)+?,2), status=?, payment_id=? WHERE id=?', amount, left > 0.009 ? 'unmatched' : 'matched', pid, lineId);
    return pid;
  });
}

// Affectation directe à un compte de charge / produit (frais bancaires, loyer, salaires…)
export function assignLine(lineId, accountCode, label) {
  const line = get('SELECT * FROM bank_lines WHERE id=?', lineId);
  if (!line || line.status !== 'unmatched') throw new BusinessError('Ligne déjà traitée');
  if (!get('SELECT code FROM accounts WHERE code=?', accountCode)) throw new BusinessError('Compte inconnu');
  const amt = remainingOf(line); // seulement ce qui n'a pas déjà servi à régler une facture
  const bankAcc = bankAccountCode(line);
  const lbl = label || line.communication || line.counterparty || 'Opération bancaire';
  return tx(() => {
    const moveId = createMove({ journal_code: 'BNK', date: line.date, ref: `BNK-${line.id}`, label: lbl, bank_line_id: line.id },
      line.amount > 0
        ? [{ account_code: bankAcc, label: lbl, debit: amt, credit: 0 }, { account_code: accountCode, label: lbl, debit: 0, credit: amt }]
        : [{ account_code: accountCode, label: lbl, debit: amt, credit: 0 }, { account_code: bankAcc, label: lbl, debit: 0, credit: amt }]);
    run("UPDATE bank_lines SET status='matched', allocated=ABS(amount), move_id=? WHERE id=?", moveId, lineId);
    return moveId;
  });
}

const assertOpenPeriod = (date) => {
  const lock = getSettings().options?.comptabilite?.lock_date;
  if (lock && date && date <= lock) throw new BusinessError(`Période clôturée (verrouillage au ${lock.split('-').reverse().join('/')}) : cette opération ne peut plus être annulée.`);
};
/** Annule un paiement enregistré par erreur : écriture supprimée, facture de nouveau « à payer », opération bancaire libérée. */
export function cancelPayment(id) {
  return tx(() => {
    const p = get('SELECT * FROM payments WHERE id=?', id);
    if (!p) throw new BusinessError('Paiement introuvable', 404);
    assertOpenPeriod(p.date);
    run('DELETE FROM moves WHERE payment_id=?', id);
    run('DELETE FROM payments WHERE id=?', id);
    if (p.document_id) {
      run('UPDATE documents SET amount_paid=MAX(0, ROUND(amount_paid-?,2)), updated_at=? WHERE id=?', p.amount, new Date().toISOString(), p.document_id);
      refreshPaymentStatus(p.document_id);
    }
    if (p.purchase_id) run("UPDATE purchases SET amount_paid=MAX(0, ROUND(amount_paid-?,2)), status=CASE WHEN status='paid' THEN 'billed' ELSE status END WHERE id=?", p.amount, p.purchase_id);
    if (p.bank_line_id) run("UPDATE bank_lines SET allocated=MAX(0, ROUND(COALESCE(allocated,0)-?,2)), status='unmatched', payment_id=NULL WHERE id=?", p.amount, p.bank_line_id);
    return { ok: true };
  });
}
/** Annule le traitement d'une opération bancaire (ignorée, rapprochée ou affectée à un compte) : elle redevient « à rapprocher ». */
export function unmatchLine(lineId) {
  return tx(() => {
    const line = get('SELECT * FROM bank_lines WHERE id=?', lineId);
    if (!line) throw new BusinessError('Opération introuvable', 404);
    for (const p of all('SELECT id FROM payments WHERE bank_line_id=?', lineId)) cancelPayment(p.id);
    if (line.move_id) { assertOpenPeriod(line.date); run('DELETE FROM moves WHERE id=?', line.move_id); }
    run("UPDATE bank_lines SET status='unmatched', allocated=0, payment_id=NULL, move_id=NULL WHERE id=?", lineId);
    return { ok: true };
  });
}

// Rapprochement automatique : uniquement les correspondances sûres (numéro + montant exact)
export function autoReconcile(bankAccountId) {
  let matched = 0;
  const lines = all("SELECT * FROM bank_lines WHERE status='unmatched'" + (bankAccountId ? ' AND bank_account_id=?' : ''), ...(bankAccountId ? [bankAccountId] : []));
  for (const l of lines) {
    const s = suggestions(l)[0];
    if (s && s.score >= 95 && Math.abs(s.residual - remainingOf(l)) < 0.01) {
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
