// Logique métier : documents (devis / OR / factures), stock, comptabilité, paiements.
import { all, get, run, insert, update, tx, round2, today, nextNumber, getSettings, localDate, localDateTime, isDate } from './db.js';
import { attachTimes, cleanPlanned, isIntervention, stopLineTimers, stopOrderTimers, currentWork } from './worktime.js';

export const DOC_COLS = [
  'type', 'number', 'status', 'customer_id', 'vehicle_id', 'mileage', 'date', 'due_date', 'reference',
  'customer_complaint', 'diagnosis', 'notes', 'internal_notes', 'mechanic_id', 'promised_at', 'parent_id',
];
export const LINE_COLS = [
  'document_id', 'sequence', 'kind', 'product_id', 'description', 'quantity', 'unit', 'unit_price',
  'discount', 'tax_rate', 'total_ht', 'mechanic_id', 'done', 'planned_hours',
];
const INCOME_ACCOUNT = { labor: '7030', part: '7040', fee: '7080' };

export class BusinessError extends Error {
  constructor(msg, status = 400) { super(msg); this.status = status; }
}

// ---------- Totaux ----------
export function lineTotal(l) {
  if (l.kind === 'text') return 0;
  return round2((Number(l.quantity) || 0) * (Number(l.unit_price) || 0) * (1 - (Number(l.discount) || 0) / 100));
}
export function computeTotals(lines) {
  const byRate = {};
  let subtotal = 0;
  for (const l of lines) {
    if (l.kind === 'text') continue;
    const t = lineTotal(l);
    subtotal += t;
    const rate = Number(l.tax_rate) || 0;
    byRate[rate] = (byRate[rate] || 0) + t;
  }
  const taxes = Object.entries(byRate).map(([rate, base]) => ({
    rate: Number(rate), base: round2(base), amount: round2((round2(base) * Number(rate)) / 100),
  }));
  const tax_total = round2(taxes.reduce((s, t) => s + t.amount, 0));
  subtotal = round2(subtotal);
  return { subtotal, tax_total, total: round2(subtotal + tax_total), taxes };
}

// ---------- Documents ----------
export function getDocument(id) {
  const d = get(
    `SELECT d.*, c.name AS customer_name, c.company AS customer_company, c.email AS customer_email,
       c.address AS customer_address, c.zip AS customer_zip, c.city AS customer_city, c.country AS customer_country,
       c.vat_number AS customer_vat, c.phone AS customer_phone, c.mobile AS customer_mobile,
       v.plate, v.make, v.model, v.vin, v.version, u.name AS mechanic_name
     FROM documents d LEFT JOIN customers c ON c.id=d.customer_id LEFT JOIN vehicles v ON v.id=d.vehicle_id
     LEFT JOIN users u ON u.id=d.mechanic_id WHERE d.id=?`, id);
  if (!d) throw new BusinessError('Document introuvable', 404);
  d.lines = all(
    `SELECT l.*, p.ref AS product_ref, p.qty_on_hand FROM document_lines l LEFT JOIN products p ON p.id=l.product_id
     WHERE l.document_id=? ORDER BY l.sequence, l.id`, id);
  d.taxes = computeTotals(d.lines).taxes;
  d.payments = all('SELECT * FROM payments WHERE document_id=? ORDER BY date', id);
  d.children = all('SELECT id,type,number,status,total FROM documents WHERE parent_id=?', id);
  d.parent = d.parent_id ? get('SELECT id,type,number,status FROM documents WHERE id=?', d.parent_id) : null;
  // OR : temps prévu / temps passé de chaque intervention, pointages, totaux
  if (d.type === 'order') attachTimes(d);
  return d;
}

export function durationHours(t) {
  const end = t.end ? new Date(t.end) : new Date();
  return Math.max(0, (end - new Date(t.start)) / 3600000);
}

function isLocked(doc) {
  return doc.type === 'invoice' || doc.type === 'credit_note' ? doc.status !== 'draft' : doc.status === 'invoiced';
}

/** Échéance d'une facture : délai de paiement du client, sinon celui du garage. */
function dueDate(date, customerId) {
  const cust = customerId ? get('SELECT payment_terms FROM customers WHERE id=?', customerId) : null;
  const days = Number(cust?.payment_terms ?? getSettings().workshop.payment_terms) || 0;
  const d = new Date(date + 'T12:00:00'); d.setDate(d.getDate() + days);
  return localDate(d);
}
/** Marque le document comme modifié (les écrans ouverts ailleurs le sauront avant d'écraser ces changements). */
export function touchDocument(id) { run('UPDATE documents SET updated_at=? WHERE id=?', new Date().toISOString(), id); }

const num = (v, label) => {
  const n = typeof v === 'string' ? Number(v.replace(',', '.')) : Number(v);
  if (!Number.isFinite(n)) throw new BusinessError(`${label} : nombre invalide`);
  return n;
};
/** Ligne de document contrôlée : quantité, prix, remise (0 à 100 %) et TVA sont de vrais nombres. */
function cleanLine(l, defaultTax) {
  if (!l || typeof l !== 'object') throw new BusinessError('Ligne invalide');
  if (l.kind === 'text') return { ...l, quantity: 1, unit_price: 0, discount: 0, tax_rate: Number(l.tax_rate) || 0, planned_hours: l.planned_hours === undefined ? undefined : null };
  const line = { ...l, quantity: num(l.quantity ?? 1, 'Quantité'), unit_price: num(l.unit_price ?? 0, 'Prix unitaire'), discount: num(l.discount ?? 0, 'Remise'), tax_rate: num(l.tax_rate ?? defaultTax ?? 0, 'TVA') };
  // Temps prévu de l'intervention (main-d'œuvre ou forfait), en heures. Non transmis = inchangé.
  if (l.planned_hours !== undefined) {
    line.planned_hours = isIntervention(line) ? cleanPlanned(l.planned_hours) : null;
    if (line.planned_hours === undefined) throw new BusinessError('Temps prévu invalide : indiquez un nombre d\'heures (par exemple 1,5 pour 1 h 30)');
  }
  if (line.discount < 0 || line.discount > 100) throw new BusinessError('La remise doit être comprise entre 0 et 100 %');
  if (line.tax_rate < 0 || line.tax_rate > 100) throw new BusinessError('Taux de TVA invalide');
  return line;
}

export function saveDocument(data, id = null) {
  if (!data || typeof data !== 'object') throw new BusinessError('Document vide');
  return tx(() => {
    const s = getSettings();
    for (const k of ['date', 'due_date']) if (data[k] && !isDate(data[k])) throw new BusinessError(k === 'date' ? 'Date du document invalide' : 'Date d\'échéance invalide');
    if (data.customer_id && !get('SELECT 1 FROM customers WHERE id=?', data.customer_id)) throw new BusinessError('Client introuvable');
    if (data.vehicle_id && !get('SELECT 1 FROM vehicles WHERE id=?', data.vehicle_id)) throw new BusinessError('Véhicule introuvable');
    if (data.mileage !== undefined && data.mileage !== null && data.mileage !== '' && !(Number(data.mileage) >= 0)) throw new BusinessError('Kilométrage invalide');
    if (id) {
      const cur = get('SELECT * FROM documents WHERE id=?', id);
      if (!cur) throw new BusinessError('Document introuvable', 404);
      // Quelqu'un d'autre (mécanicien au kiosque, client sur le suivi, collègue) a modifié le document depuis son ouverture :
      // on refuse d'écraser ses changements
      if (data.updated_at && cur.updated_at && data.updated_at !== cur.updated_at) {
        throw new BusinessError('Ce document a été modifié entre-temps (atelier, client ou collègue). Rechargez la page pour voir la dernière version, puis refaites votre modification.', 409);
      }
      if (isLocked(cur)) {
        // Seules les notes internes restent modifiables sur un document verrouillé
        update('documents', id, { internal_notes: data.internal_notes, updated_at: new Date().toISOString() }, ['internal_notes', 'updated_at']);
        return id;
      }
      // Le type, le numéro et le statut ne se changent jamais ici (statut : boutons dédiés, validation, conversion, kiosque)
      const { type, number, parent_id, status, ...rest } = data;
      if (rest.date === '' || rest.date === null) delete rest.date;
      update('documents', id, { ...rest, updated_at: new Date().toISOString() }, [...DOC_COLS, 'updated_at'].filter((c) => !['type', 'number', 'parent_id', 'status'].includes(c)));
    } else {
      const type = data.type;
      if (!['quote', 'order', 'invoice', 'credit_note'].includes(type)) throw new BusinessError('Type de document invalide');
      const status = { quote: 'draft', order: 'open', invoice: 'draft', credit_note: 'draft' }[type];
      const date = data.date || today();
      const number = type === 'quote' || type === 'order' ? nextNumber(type, date) : null;
      const due = data.due_date || (type === 'invoice' ? dueDate(date, data.customer_id) : null);
      id = insert('documents', { ...data, type, status, number, date, due_date: due, updated_at: new Date().toISOString() }, [...DOC_COLS, 'updated_at']);
    }
    if (Array.isArray(data.lines)) {
      const lines = data.lines.map((l) => cleanLine(l, s.workshop.default_tax));
      // Les lignes déjà enregistrées gardent leur identifiant (le kiosque et le suivi client s'y réfèrent pour cocher « fait ») ;
      // seules les lignes retirées sont supprimées, les nouvelles ajoutées
      const existing = new Map(all('SELECT id, done FROM document_lines WHERE document_id=?', id).map((l) => [l.id, l.done]));
      const kept = new Set();
      const now = localDateTime();
      lines.forEach((l, i) => {
        const row = { ...l, document_id: id, sequence: i, total_ht: lineTotal(l), done: l.done ? 1 : 0 };
        if (existing.has(l.id) && !kept.has(l.id)) {
          kept.add(l.id);
          update('document_lines', l.id, { ...row, product_id: l.product_id ?? null, unit: l.unit ?? null, mechanic_id: l.mechanic_id ?? null }, LINE_COLS);
          // Intervention cochée « fait » par le bureau : les chronos encore en cours dessus s'arrêtent
          if (row.done && !existing.get(l.id)) stopLineTimers(id, l.id, now);
        } else insert('document_lines', { ...row, id: undefined }, LINE_COLS);
      });
      for (const old of existing.keys()) {
        if (kept.has(old)) continue;
        // Ligne retirée : le temps déjà pointé dessus reste sur l'OR (sans intervention précise)
        run('UPDATE time_entries SET line_id=NULL WHERE line_id=? AND document_id=?', old, id);
        run('DELETE FROM document_lines WHERE id=?', old);
      }
    }
    refreshTotals(id);
    // Mise à jour du kilométrage du véhicule
    if (data.vehicle_id && data.mileage) {
      run('UPDATE vehicles SET mileage=? WHERE id=? AND (mileage IS NULL OR mileage<?)', data.mileage, data.vehicle_id, data.mileage);
    }
    return id;
  });
}

export function refreshTotals(id) {
  const lines = all('SELECT * FROM document_lines WHERE document_id=?', id);
  const t = computeTotals(lines);
  run('UPDATE documents SET subtotal=?, tax_total=?, total=? WHERE id=?', t.subtotal, t.tax_total, t.total, id);
}

// Conversion : devis -> OR -> facture ; facture -> note de crédit
export function convertDocument(id, targetType) {
  return tx(() => {
    const src = getDocument(id);
    const allowed = { quote: ['order', 'invoice'], order: ['invoice'], invoice: ['credit_note'] };
    if (!allowed[src.type]?.includes(targetType)) throw new BusinessError('Conversion impossible');
    if (targetType === 'credit_note' && src.status === 'draft') throw new BusinessError('La facture doit être validée');
    // Une seule conversion : un double clic ne doit pas créer deux factures (ou deux OR) pour le même travail
    const kids = src.children.filter((c) => c.type === targetType && c.status !== 'cancelled');
    const NAMES = { order: 'Un ordre de réparation', invoice: 'Une facture', credit_note: 'Une note de crédit' };
    if (targetType !== 'credit_note') {
      if (src.status === 'cancelled') throw new BusinessError('Ce document est annulé');
      if (kids.length || src.status === 'invoiced') throw new BusinessError(`${NAMES[targetType]} existe déjà pour ce document${kids[0] ? ` (${kids[0].number || 'brouillon'})` : ''}.`);
      // Un devis déjà transformé en OR se facture depuis l'OR (sinon le même travail serait facturé deux fois), et inversement
      const other = src.type === 'quote' ? src.children.find((c) => c.type !== targetType && c.type !== 'credit_note' && c.status !== 'cancelled') : null;
      if (other) throw new BusinessError(other.type === 'order' ? `Ce devis a déjà été transformé en ordre de réparation (${other.number || 'OR'}) : facturez depuis l'OR.` : `Ce devis a déjà été facturé (${other.number || 'facture en brouillon'}).`);
    } else {
      if (kids.some((c) => c.status === 'draft')) throw new BusinessError('Une note de crédit en brouillon existe déjà pour cette facture : complétez-la ou supprimez-la.');
      if (round2(kids.reduce((a, c) => a + c.total, 0)) >= src.total - 0.009) throw new BusinessError('Cette facture a déjà été entièrement créditée.');
    }
    const date = today();
    const status = { order: 'open', invoice: 'draft', credit_note: 'draft' }[targetType];
    const number = targetType === 'order' ? nextNumber('order', date) : null;
    const due = targetType === 'invoice' ? dueDate(date, src.customer_id) : null;
    const newId = insert('documents', {
      ...src, type: targetType, status, number, date, due_date: due, parent_id: src.id, updated_at: new Date().toISOString(),
      reference: targetType === 'credit_note' ? `Avoir sur ${src.number}` : src.reference,
    }, [...DOC_COLS, 'updated_at']);
    src.lines.forEach((l, i) => insert('document_lines', { ...l, document_id: newId, sequence: i, done: 0 }, LINE_COLS));
    refreshTotals(newId);
    if (src.type === 'quote') run("UPDATE documents SET status='accepted' WHERE id=?", src.id);
    if (src.type === 'order' && targetType === 'invoice') {
      run("UPDATE documents SET status='invoiced' WHERE id=?", src.id);
      stopOrderTimers(src.id); // OR facturé : plus aucun chrono ne tourne dessus
    }
    return newId;
  });
}

// Validation d'une facture / note de crédit : numéro définitif, sortie de stock, écriture comptable
export function postInvoice(id) {
  return tx(() => {
    const d = getDocument(id);
    if (!['invoice', 'credit_note'].includes(d.type)) throw new BusinessError('Seules les factures peuvent être validées');
    if (d.status !== 'draft') throw new BusinessError('Document déjà validé');
    if (!d.customer_id) throw new BusinessError('Client obligatoire');
    if (!d.lines.some((l) => l.kind !== 'text')) throw new BusinessError('La facture est vide');
    if (d.total < 0) throw new BusinessError('Le total est négatif : pour rembourser un client, créez une note de crédit depuis la facture.');
    if (d.date && !isDate(d.date)) throw new BusinessError('Date du document invalide');
    if (d.type === 'credit_note' && d.parent_id) {
      // Le total des notes de crédit ne peut pas dépasser la facture d'origine
      const parent = get('SELECT total, number FROM documents WHERE id=?', d.parent_id);
      const credited = get("SELECT COALESCE(SUM(total),0) v FROM documents WHERE parent_id=? AND type='credit_note' AND status NOT IN ('draft','cancelled') AND id!=?", d.parent_id, id).v;
      if (parent && round2(credited + d.total) > parent.total + 0.009) throw new BusinessError(`Cette note de crédit dépasse le montant restant à créditer sur la facture ${parent.number} (${round2(parent.total - credited).toFixed(2)} €).`);
    }
    const date = d.date || today();
    const number = nextNumber(d.type, date);
    const sign = d.type === 'credit_note' ? -1 : 1;

    // Stock
    for (const l of d.lines) {
      if (l.product_id && l.kind === 'part') {
        const p = get('SELECT is_service, purchase_price FROM products WHERE id=?', l.product_id);
        if (p && !p.is_service) {
          addStockMove({ product_id: l.product_id, qty: -sign * Number(l.quantity), kind: sign > 0 ? 'sale' : 'return', unit_cost: p.purchase_price, document_id: id, note: number });
        }
      }
    }

    // Comptabilité : D Clients / C Produits / C TVA collectée (inversé pour un avoir)
    const lines = [];
    const byAccount = {};
    for (const l of d.lines) {
      if (l.kind === 'text') continue;
      const acc = INCOME_ACCOUNT[l.kind] || '7040';
      byAccount[acc] = round2((byAccount[acc] || 0) + Number(l.total_ht));
    }
    lines.push(ml('4011', d.customer_id, `${number} ${d.customer_name}`, sign * d.total));
    for (const [acc, amt] of Object.entries(byAccount)) lines.push(ml(acc, d.customer_id, number, -sign * amt));
    for (const t of d.taxes) {
      if (!t.amount) continue;
      lines.push({ ...ml('461411', d.customer_id, `TVA ${t.rate}%`, -sign * t.amount), tax_rate: t.rate, tax_base: sign * t.base });
    }
    // (une facture à 0 € — geste commercial — n'a pas d'écriture comptable)
    if (lines.some((l) => l.debit || l.credit)) createMove({ journal_code: 'VTE', date, ref: number, label: `${d.type === 'credit_note' ? 'Avoir' : 'Facture'} ${d.customer_name}`, document_id: id }, lines);

    run("UPDATE documents SET number=?, status='posted', posted_at=?, date=?, updated_at=? WHERE id=?", number, new Date().toISOString(), date, new Date().toISOString(), id);
    // Une facture à 0 € est soldée tout de suite (sinon elle resterait « à payer » et serait relancée)
    refreshPaymentStatus(id);
    // Un avoir solde automatiquement la facture d'origine à hauteur de son montant
    if (d.type === 'credit_note' && d.parent_id) allocateCredits(d.parent_id);
    return number;
  });
}

/**
 * Impute les notes de crédit validées d'une facture sur ce qu'il lui reste à payer.
 * Appelé à la validation d'un avoir, et quand un paiement de la facture est annulé (le reste dû réapparaît).
 */
export function allocateCredits(invoiceId) {
  const inv = get("SELECT id, total, amount_paid FROM documents WHERE id=? AND type='invoice'", invoiceId);
  if (!inv) return;
  for (const cn of all("SELECT id, total, amount_paid FROM documents WHERE parent_id=? AND type='credit_note' AND status IN ('posted','partial') ORDER BY id", invoiceId)) {
    const alloc = round2(Math.min(round2(inv.total - inv.amount_paid), round2(cn.total - cn.amount_paid)));
    if (alloc <= 0.009) continue;
    run('UPDATE documents SET amount_paid=ROUND(amount_paid+?,2) WHERE id=?', alloc, inv.id);
    run('UPDATE documents SET amount_paid=ROUND(amount_paid+?,2) WHERE id=?', alloc, cn.id);
    inv.amount_paid = round2(inv.amount_paid + alloc);
    refreshPaymentStatus(cn.id);
  }
  refreshPaymentStatus(inv.id);
}

function ml(account_code, customerId, label, signedAmount) {
  const a = round2(signedAmount);
  return { account_code, partner_type: 'customer', partner_id: customerId, label, debit: a > 0 ? a : 0, credit: a < 0 ? -a : 0 };
}

export function createMove(move, lines) {
  // Date de verrouillage (option Comptabilité) : aucune écriture avant ou à cette date
  if (!isDate(move.date)) throw new BusinessError('Date de l\'écriture invalide');
  const lock = getSettings().options?.comptabilite?.lock_date;
  if (lock && move.date && move.date <= lock) throw new BusinessError(`Période clôturée : aucune écriture possible au ${move.date.split('-').reverse().join('/')} (verrouillage au ${lock.split('-').reverse().join('/')}).`);
  const debit = round2(lines.reduce((s, l) => s + (l.debit || 0), 0));
  const credit = round2(lines.reduce((s, l) => s + (l.credit || 0), 0));
  if (Math.abs(debit - credit) > 0.009) throw new BusinessError(`Écriture déséquilibrée (${debit} / ${credit})`);
  const moveId = insert('moves', move, ['journal_code', 'date', 'ref', 'label', 'document_id', 'purchase_id', 'payment_id', 'bank_line_id']);
  for (const l of lines) {
    if (!l.debit && !l.credit) continue;
    insert('move_lines', { ...l, move_id: moveId }, ['move_id', 'account_code', 'partner_type', 'partner_id', 'label', 'debit', 'credit', 'tax_rate', 'tax_base']);
  }
  return moveId;
}

export function refreshPaymentStatus(id) {
  const d = get('SELECT * FROM documents WHERE id=?', id);
  if (!d || d.status === 'draft' || d.status === 'cancelled') return;
  const residual = round2(d.total - d.amount_paid);
  const status = residual <= 0.009 ? 'paid' : d.amount_paid > 0 ? 'partial' : 'posted';
  run('UPDATE documents SET status=? WHERE id=?', status, id);
}
function refreshPurchasePayment(id) {
  const p = get('SELECT * FROM purchases WHERE id=?', id);
  if (!p) return;
  if (p.posted && round2(p.total - p.amount_paid) <= 0.009) run("UPDATE purchases SET status='paid' WHERE id=?", id);
}

const METHOD_ACCOUNT = { bank: '5131', cash: '5161', card: '5171', payconiq: '5171', digicash: '5171' };

// Encaissement client ou paiement fournisseur
export function registerPayment({ document_id, purchase_id, amount, date = today(), method = 'bank', reference, note, bank_line_id, bank_account_code }) {
  return tx(() => {
    amount = round2(amount);
    if (!(amount > 0)) throw new BusinessError('Montant invalide');
    date = date || today();
    if (!isDate(date)) throw new BusinessError('Date du paiement invalide');
    // Un paiement ne peut pas dépasser le reste à payer (faute de frappe, double clic…)
    const cap = (residual) => { if (amount > residual + 0.009) throw new BusinessError(residual > 0.009 ? `Le montant dépasse le reste à payer (${residual.toFixed(2)} €).` : 'Ce document est déjà entièrement payé.'); };
    const payAcc = bank_account_code || METHOD_ACCOUNT[method] || '5131';
    const journal = method === 'cash' ? 'CAI' : 'BNK';
    if (document_id) {
      const d = get('SELECT d.*, c.name AS customer_name FROM documents d LEFT JOIN customers c ON c.id=d.customer_id WHERE d.id=?', document_id);
      if (!d || !['invoice', 'credit_note'].includes(d.type) || d.status === 'draft') throw new BusinessError('Facture non validée');
      const refund = d.type === 'credit_note'; // remboursement d'un avoir au client
      cap(round2(d.total - d.amount_paid));
      const pid = insert('payments', { direction: refund ? 'out' : 'in', date, amount, method, document_id, customer_id: d.customer_id, reference, note, bank_line_id },
        ['direction', 'date', 'amount', 'method', 'document_id', 'customer_id', 'reference', 'note', 'bank_line_id']);
      const label = `${refund ? 'Remboursement' : 'Encaissement'} ${d.number}`;
      createMove({ journal_code: journal, date, ref: d.number, label: `${refund ? 'Remboursement' : 'Encaissement'} ${d.customer_name}`, payment_id: pid, bank_line_id }, [
        { account_code: payAcc, label, debit: refund ? 0 : amount, credit: refund ? amount : 0 },
        { account_code: '4011', partner_type: 'customer', partner_id: d.customer_id, label, debit: refund ? amount : 0, credit: refund ? 0 : amount },
      ]);
      run('UPDATE documents SET amount_paid=ROUND(amount_paid+?,2) WHERE id=?', amount, document_id);
      refreshPaymentStatus(document_id);
      return pid;
    }
    if (purchase_id) {
      const p = get('SELECT p.*, s.name AS supplier_name FROM purchases p LEFT JOIN suppliers s ON s.id=p.supplier_id WHERE p.id=?', purchase_id);
      if (!p || !p.posted) throw new BusinessError('Facture fournisseur non comptabilisée');
      cap(round2(p.total - p.amount_paid));
      const pid = insert('payments', { direction: 'out', date, amount, method, purchase_id, supplier_id: p.supplier_id, reference, note, bank_line_id },
        ['direction', 'date', 'amount', 'method', 'purchase_id', 'supplier_id', 'reference', 'note', 'bank_line_id']);
      createMove({ journal_code: journal, date, ref: p.supplier_ref || p.number, label: `Paiement ${p.supplier_name}`, payment_id: pid, bank_line_id }, [
        { account_code: '4411', partner_type: 'supplier', partner_id: p.supplier_id, label: `Paiement ${p.number}`, debit: amount, credit: 0 },
        { account_code: payAcc, label: `Paiement ${p.number}`, debit: 0, credit: amount },
      ]);
      run('UPDATE purchases SET amount_paid=ROUND(amount_paid+?,2) WHERE id=?', amount, purchase_id);
      refreshPurchasePayment(purchase_id);
      return pid;
    }
    throw new BusinessError('Document manquant');
  });
}

// ---------- Stock ----------
export function addStockMove({ product_id, qty, kind, unit_cost, document_id, purchase_id, note, user_id }) {
  // Option Inventaire : interdire le stock négatif lors d'une vente
  if (qty < 0 && kind === 'sale' && getSettings().options?.inventaire?.allow_negative === false) {
    const p = get('SELECT ref, name, qty_on_hand FROM products WHERE id=?', product_id);
    if (p && p.qty_on_hand + qty < -0.0001) throw new BusinessError(`Stock insuffisant pour ${p.ref ? p.ref + ' ' : ''}${p.name} : ${p.qty_on_hand} en stock, ${-qty} demandé(s).`);
  }
  insert('stock_moves', { product_id, qty, kind, unit_cost, document_id, purchase_id, note, user_id, date: new Date().toISOString() },
    ['product_id', 'qty', 'kind', 'unit_cost', 'document_id', 'purchase_id', 'note', 'user_id', 'date']);
  run('UPDATE products SET qty_on_hand = qty_on_hand + ? WHERE id=?', qty, product_id);
}

// ---------- Achats ----------
export const PURCHASE_COLS = ['number', 'supplier_id', 'status', 'date', 'supplier_ref', 'due_date', 'notes'];
export const PLINE_COLS = ['purchase_id', 'product_id', 'description', 'quantity', 'unit_price', 'tax_rate', 'total_ht', 'received_qty', 'account_code'];

export function getPurchase(id) {
  const p = get('SELECT p.*, s.name AS supplier_name, s.iban AS supplier_iban FROM purchases p LEFT JOIN suppliers s ON s.id=p.supplier_id WHERE p.id=?', id);
  if (!p) throw new BusinessError('Achat introuvable', 404);
  p.lines = all('SELECT l.*, pr.ref AS product_ref, pr.name AS product_name FROM purchase_lines l LEFT JOIN products pr ON pr.id=l.product_id WHERE purchase_id=? ORDER BY l.id', id);
  p.taxes = computeTotals(p.lines.map((l) => ({ ...l, kind: 'part' }))).taxes;
  p.payments = all('SELECT * FROM payments WHERE purchase_id=?', id);
  return p;
}

export function savePurchase(data, id = null) {
  return tx(() => {
    if (!data || typeof data !== 'object') throw new BusinessError('Achat vide');
    for (const k of ['date', 'due_date']) if (data[k] && !isDate(data[k])) throw new BusinessError(k === 'date' ? 'Date de l\'achat invalide' : 'Date d\'échéance invalide');
    if (data.supplier_id && !get('SELECT 1 FROM suppliers WHERE id=?', data.supplier_id)) throw new BusinessError('Fournisseur introuvable');
    if (id) {
      const cur = get('SELECT * FROM purchases WHERE id=?', id);
      if (!cur) throw new BusinessError('Achat introuvable', 404);
      if (cur.posted) { update('purchases', id, { notes: data.notes }, ['notes']); return id; }
      if (data.date === '' || data.date === null) data = { ...data, date: undefined };
      update('purchases', id, data, PURCHASE_COLS.filter((c) => c !== 'number' && c !== 'status'));
    } else {
      id = insert('purchases', { ...data, status: 'draft', number: nextNumber('purchase', data.date || today()), date: data.date || today() }, PURCHASE_COLS);
    }
    if (Array.isArray(data.lines)) {
      const before = all('SELECT id, product_id, description, received_qty FROM purchase_lines WHERE purchase_id=?', id);
      const received = Object.fromEntries(before.map((l) => [l.id, l.received_qty]));
      // Marchandise déjà entrée en stock : la ligne doit rester, pour le même article, avec au moins la quantité reçue
      for (const b of before.filter((l) => l.received_qty > 0)) {
        const now = data.lines.find((l) => l && l.id === b.id);
        if (!now || (now.product_id ?? null) !== b.product_id || !(Number(String(now.quantity ?? 1).replace(',', '.')) >= b.received_qty)) {
          throw new BusinessError(`« ${b.description || 'Ligne'} » : ${b.received_qty} déjà reçu(s) en stock. Cette ligne ne peut pas être supprimée, changée d'article ni réduite sous la quantité reçue (corrigez le stock par un inventaire si besoin).`);
        }
      }
      run('DELETE FROM purchase_lines WHERE purchase_id=?', id);
      for (const raw of data.lines) {
        const l = cleanLine({ ...raw, kind: 'part', discount: 0 }, 17);
        if (l.product_id && !get('SELECT 1 FROM products WHERE id=?', l.product_id)) throw new BusinessError('Article introuvable');
        insert('purchase_lines', { ...l, purchase_id: id, received_qty: received[raw.id] || 0, total_ht: lineTotal(l) }, PLINE_COLS);
      }
    }
    const t = computeTotals(all('SELECT * FROM purchase_lines WHERE purchase_id=?', id).map((l) => ({ ...l, kind: 'part' })));
    run('UPDATE purchases SET subtotal=?, tax_total=?, total=? WHERE id=?', t.subtotal, t.tax_total, t.total, id);
    return id;
  });
}

export function receivePurchase(id) {
  return tx(() => {
    const p = getPurchase(id);
    for (const l of p.lines) {
      const remaining = Number(l.quantity) - Number(l.received_qty || 0);
      if (l.product_id && remaining > 0) {
        addStockMove({ product_id: l.product_id, qty: remaining, kind: 'purchase', unit_cost: l.unit_price, purchase_id: id, note: p.number });
        run('UPDATE products SET purchase_price=? WHERE id=?', l.unit_price, l.product_id);
        run('UPDATE purchase_lines SET received_qty=quantity WHERE id=?', l.id);
      }
    }
    if (!p.posted) run("UPDATE purchases SET status='received' WHERE id=?", id);
  });
}

export function postPurchase(id) {
  return tx(() => {
    const p = getPurchase(id);
    if (p.posted) throw new BusinessError('Déjà comptabilisée');
    if (!p.supplier_id) throw new BusinessError('Fournisseur obligatoire');
    if (!p.lines.length || !p.total) throw new BusinessError('La facture fournisseur est vide : ajoutez au moins une ligne avec un montant.');
    if (p.total < 0) throw new BusinessError('Le total est négatif : encodez une facture fournisseur avec un montant positif.');
    const supplier = get('SELECT default_account FROM suppliers WHERE id=?', p.supplier_id);
    const byAcc = {};
    for (const l of p.lines) {
      const acc = l.account_code || supplier?.default_account || '6070';
      byAcc[acc] = round2((byAcc[acc] || 0) + Number(l.total_ht));
    }
    const lines = Object.entries(byAcc).map(([acc, amt]) => ({ account_code: acc, partner_type: 'supplier', partner_id: p.supplier_id, label: p.supplier_ref || p.number, debit: amt, credit: 0 }));
    for (const t of p.taxes) if (t.amount) lines.push({ account_code: '421611', partner_type: 'supplier', partner_id: p.supplier_id, label: `TVA ${t.rate}%`, debit: t.amount, credit: 0, tax_rate: t.rate, tax_base: t.base });
    lines.push({ account_code: '4411', partner_type: 'supplier', partner_id: p.supplier_id, label: `${p.supplier_name} ${p.supplier_ref || ''}`, debit: 0, credit: p.total });
    createMove({ journal_code: 'ACH', date: p.date, ref: p.supplier_ref || p.number, label: `Facture ${p.supplier_name}`, purchase_id: id }, lines);
    run("UPDATE purchases SET posted=1, status='billed' WHERE id=?", id);
  });
}

// ---------- Rapports ----------
export function dashboard() {
  const t = today();
  const month = t.slice(0, 7);
  const year = t.slice(0, 4);
  const sum = (sql, ...p) => round2(get(sql, ...p)?.v || 0);
  const salesMonth = sum(`SELECT SUM(CASE WHEN type='credit_note' THEN -subtotal ELSE subtotal END) v FROM documents WHERE type IN ('invoice','credit_note') AND status!='draft' AND substr(date,1,7)=?`, month);
  const salesYear = sum(`SELECT SUM(CASE WHEN type='credit_note' THEN -subtotal ELSE subtotal END) v FROM documents WHERE type IN ('invoice','credit_note') AND status!='draft' AND substr(date,1,4)=?`, year);
  const receivable = sum(`SELECT SUM(total-amount_paid) v FROM documents WHERE type='invoice' AND status IN ('posted','partial')`);
  const overdue = sum(`SELECT SUM(total-amount_paid) v FROM documents WHERE type='invoice' AND status IN ('posted','partial') AND due_date<?`, t);
  const payable = sum(`SELECT SUM(total-amount_paid) v FROM purchases WHERE posted=1 AND status!='paid'`);
  const bank = sum(`SELECT SUM(debit-credit) v FROM move_lines WHERE account_code IN (SELECT COALESCE(account_code,'5131') FROM bank_accounts UNION SELECT '5131' UNION SELECT '5161')`) + sum('SELECT SUM(opening_balance) v FROM bank_accounts');
  const ordersOpen = get(`SELECT COUNT(*) n FROM documents WHERE type='order' AND status NOT IN ('invoiced','cancelled')`).n;
  const quotesPending = get(`SELECT COUNT(*) n FROM documents WHERE type='quote' AND status IN ('draft','sent')`).n;
  const lowStock = all('SELECT id, ref, name, qty_on_hand, qty_min FROM products WHERE active=1 AND is_service=0 AND qty_on_hand<=qty_min AND qty_min>0 ORDER BY name LIMIT 20');
  const present = all(`SELECT u.id, u.name, u.color,
      (SELECT d.number FROM time_entries w JOIN documents d ON d.id=w.document_id WHERE w.user_id=u.id AND w.kind='work' AND w.end IS NULL LIMIT 1) AS working_on
    FROM users u WHERE u.active=1 AND u.role='mechanic' AND EXISTS (SELECT 1 FROM time_entries t WHERE t.user_id=u.id AND t.kind='presence' AND t.end IS NULL)`);
  for (const p of present) p.work = currentWork(p.id);
  const appointmentsToday = all(`SELECT a.*, c.name AS customer_name, v.plate, v.make, v.model, u.name AS mechanic_name FROM appointments a
    LEFT JOIN customers c ON c.id=a.customer_id LEFT JOIN vehicles v ON v.id=a.vehicle_id LEFT JOIN users u ON u.id=a.mechanic_id
    WHERE substr(a.start,1,10)=? ORDER BY a.start`, t);
  const unmatchedBank = get(`SELECT COUNT(*) n FROM bank_lines WHERE status='unmatched'`).n;
  const inspectionsSoon = all(`SELECT v.id, v.plate, v.make, v.model, v.next_inspection, c.name AS customer_name, c.phone, c.mobile FROM vehicles v
    LEFT JOIN customers c ON c.id=v.customer_id WHERE v.next_inspection BETWEEN ? AND date(?, '+30 days') ORDER BY v.next_inspection LIMIT 20`, t, t);
  const monthly = all(`SELECT substr(date,1,7) AS month, ROUND(SUM(CASE WHEN type='credit_note' THEN -subtotal ELSE subtotal END),2) AS total
    FROM documents WHERE type IN ('invoice','credit_note') AND status!='draft' AND date>=date(?, 'start of month', '-11 months')
    GROUP BY 1 ORDER BY 1`, t);
  // 12 derniers mois, y compris ceux sans chiffre d'affaires
  const months = [];
  const base = new Date(`${month}-15T12:00:00`);
  for (let i = 11; i >= 0; i--) {
    const d = new Date(base); d.setMonth(d.getMonth() - i);
    const m = localDate(d).slice(0, 7);
    months.push({ month: m, total: monthly.find((x) => x.month === m)?.total || 0 });
  }
  return { salesMonth, salesYear, receivable, overdue, payable, bank: round2(bank), ordersOpen, quotesPending, lowStock, present, appointmentsToday, unmatchedBank, inspectionsSoon, monthly: months };
}

export function trialBalance(from, to) {
  return all(`SELECT a.code, a.name, a.type, ROUND(COALESCE(SUM(l.debit),0),2) AS debit, ROUND(COALESCE(SUM(l.credit),0),2) AS credit,
      ROUND(COALESCE(SUM(l.debit-l.credit),0),2) AS balance
    FROM accounts a LEFT JOIN move_lines l ON l.account_code=a.code
      AND l.move_id IN (SELECT id FROM moves WHERE date BETWEEN ? AND ?)
    GROUP BY a.code HAVING debit!=0 OR credit!=0 ORDER BY a.code`, from, to);
}

export function vatReport(from, to) {
  const rows = all(`SELECT l.account_code, l.tax_rate, ROUND(SUM(l.credit-l.debit),2) AS tax, ROUND(SUM(l.tax_base),2) AS base
    FROM move_lines l JOIN moves m ON m.id=l.move_id WHERE m.date BETWEEN ? AND ? AND l.account_code IN ('461411','421611')
    GROUP BY l.account_code, l.tax_rate ORDER BY l.account_code, l.tax_rate`, from, to);
  const collected = rows.filter((r) => r.account_code === '461411').map((r) => ({ rate: r.tax_rate, base: r.base, tax: r.tax }));
  const deductible = rows.filter((r) => r.account_code === '421611').map((r) => ({ rate: r.tax_rate, base: r.base, tax: -r.tax }));
  // Chiffre d'affaires et achats à 0 % (exonéré, intracommunautaire) : aucune écriture de TVA, mais la base doit figurer dans la déclaration
  const zeroSales = get(`SELECT ROUND(SUM(CASE WHEN d.type='credit_note' THEN -l.total_ht ELSE l.total_ht END),2) v FROM document_lines l JOIN documents d ON d.id=l.document_id
    WHERE d.type IN ('invoice','credit_note') AND d.status NOT IN ('draft','cancelled') AND d.date BETWEEN ? AND ? AND l.kind!='text' AND COALESCE(l.tax_rate,0)=0`, from, to).v;
  if (zeroSales) collected.unshift({ rate: 0, base: zeroSales, tax: 0 });
  const zeroPurchases = get(`SELECT ROUND(SUM(l.total_ht),2) v FROM purchase_lines l JOIN purchases p ON p.id=l.purchase_id
    WHERE p.posted=1 AND p.date BETWEEN ? AND ? AND COALESCE(l.tax_rate,0)=0`, from, to).v;
  if (zeroPurchases) deductible.unshift({ rate: 0, base: zeroPurchases, tax: 0 });
  const totalCollected = round2(collected.reduce((s, r) => s + r.tax, 0));
  const totalDeductible = round2(deductible.reduce((s, r) => s + r.tax, 0));
  return { from, to, collected, deductible, totalCollected, totalDeductible, due: round2(totalCollected - totalDeductible) };
}

export function profitAndLoss(from, to) {
  const rows = trialBalance(from, to).filter((r) => r.type === 'income' || r.type === 'expense');
  const income = rows.filter((r) => r.type === 'income').map((r) => ({ ...r, amount: -r.balance }));
  const expense = rows.filter((r) => r.type === 'expense').map((r) => ({ ...r, amount: r.balance }));
  const ti = round2(income.reduce((s, r) => s + r.amount, 0));
  const te = round2(expense.reduce((s, r) => s + r.amount, 0));
  return { income, expense, totalIncome: ti, totalExpense: te, result: round2(ti - te) };
}
