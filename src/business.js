// Logique métier : documents (devis / OR / factures), stock, comptabilité, paiements.
import { all, get, run, insert, update, tx, round2, today, nextNumber, getSettings, localDate } from './db.js';

export const DOC_COLS = [
  'type', 'number', 'status', 'customer_id', 'vehicle_id', 'mileage', 'date', 'due_date', 'reference',
  'customer_complaint', 'diagnosis', 'notes', 'internal_notes', 'mechanic_id', 'promised_at', 'parent_id',
];
export const LINE_COLS = [
  'document_id', 'sequence', 'kind', 'product_id', 'description', 'quantity', 'unit', 'unit_price',
  'discount', 'tax_rate', 'total_ht', 'mechanic_id', 'done',
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
    rate: Number(rate), base: round2(base), amount: round2((base * Number(rate)) / 100),
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
  if (d.type === 'order') {
    d.time_entries = all(
      `SELECT t.*, u.name AS user_name FROM time_entries t JOIN users u ON u.id=t.user_id
       WHERE t.document_id=? ORDER BY t.start`, id);
    d.hours_spent = round2(d.time_entries.reduce((s, t) => s + durationHours(t), 0));
    d.hours_sold = round2(d.lines.filter((l) => l.kind === 'labor').reduce((s, l) => s + Number(l.quantity || 0), 0));
  }
  return d;
}

export function durationHours(t) {
  const end = t.end ? new Date(t.end) : new Date();
  return Math.max(0, (end - new Date(t.start)) / 3600000);
}

function isLocked(doc) {
  return doc.type === 'invoice' || doc.type === 'credit_note' ? doc.status !== 'draft' : doc.status === 'invoiced';
}

export function saveDocument(data, id = null) {
  return tx(() => {
    const s = getSettings();
    if (id) {
      const cur = get('SELECT * FROM documents WHERE id=?', id);
      if (!cur) throw new BusinessError('Document introuvable', 404);
      if (isLocked(cur)) {
        // Seules les notes internes restent modifiables sur un document verrouillé
        update('documents', id, { internal_notes: data.internal_notes }, ['internal_notes']);
        return id;
      }
      const { type, number, parent_id, ...rest } = data;
      update('documents', id, { ...rest, updated_at: new Date().toISOString() }, [...DOC_COLS, 'updated_at'].filter((c) => !['type', 'number', 'parent_id'].includes(c)));
    } else {
      const type = data.type;
      if (!['quote', 'order', 'invoice', 'credit_note'].includes(type)) throw new BusinessError('Type de document invalide');
      const status = { quote: 'draft', order: 'open', invoice: 'draft', credit_note: 'draft' }[type];
      const date = data.date || today();
      const number = type === 'quote' || type === 'order' ? nextNumber(type, date) : null;
      let due = data.due_date;
      if (!due && type === 'invoice') {
        const cust = data.customer_id ? get('SELECT payment_terms FROM customers WHERE id=?', data.customer_id) : null;
        const days = cust?.payment_terms ?? s.workshop.payment_terms;
        const d = new Date(date); d.setDate(d.getDate() + Number(days || 0)); due = localDate(d);
      }
      id = insert('documents', { ...data, type, status, number, date, due_date: due }, DOC_COLS);
    }
    if (Array.isArray(data.lines)) {
      run('DELETE FROM document_lines WHERE document_id=?', id);
      data.lines.forEach((l, i) => {
        insert('document_lines', {
          ...l, id: undefined, document_id: id, sequence: i, total_ht: lineTotal(l),
          quantity: l.quantity ?? 1, tax_rate: l.tax_rate ?? s.workshop.default_tax,
        }, LINE_COLS);
      });
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
    const date = today();
    const status = { order: 'open', invoice: 'draft', credit_note: 'draft' }[targetType];
    const number = targetType === 'order' ? nextNumber('order', date) : null;
    let due = null;
    if (targetType === 'invoice') {
      const d = new Date(date); d.setDate(d.getDate() + Number(getSettings().workshop.payment_terms || 0)); due = localDate(d);
    }
    const newId = insert('documents', {
      ...src, type: targetType, status, number, date, due_date: due, parent_id: src.id,
      reference: targetType === 'credit_note' ? `Avoir sur ${src.number}` : src.reference,
    }, DOC_COLS);
    src.lines.forEach((l, i) => insert('document_lines', { ...l, document_id: newId, sequence: i, done: 0 }, LINE_COLS));
    refreshTotals(newId);
    if (src.type === 'quote') run("UPDATE documents SET status='accepted' WHERE id=?", src.id);
    if (src.type === 'order' && targetType === 'invoice') run("UPDATE documents SET status='invoiced' WHERE id=?", src.id);
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
    createMove({ journal_code: 'VTE', date, ref: number, label: `${d.type === 'credit_note' ? 'Avoir' : 'Facture'} ${d.customer_name}`, document_id: id }, lines);

    run("UPDATE documents SET number=?, status='posted', posted_at=?, date=? WHERE id=?", number, new Date().toISOString(), date, id);
    // Un avoir solde automatiquement la facture d'origine à hauteur de son montant
    if (d.type === 'credit_note' && d.parent_id) {
      const parent = get('SELECT * FROM documents WHERE id=?', d.parent_id);
      const residual = round2(parent.total - parent.amount_paid);
      const alloc = Math.min(residual, d.total);
      if (alloc > 0) {
        run('UPDATE documents SET amount_paid=amount_paid+? WHERE id=?', alloc, parent.id);
        run('UPDATE documents SET amount_paid=? WHERE id=?', alloc, id);
        refreshPaymentStatus(parent.id);
        refreshPaymentStatus(id);
      }
    }
    return number;
  });
}

function ml(account_code, customerId, label, signedAmount) {
  const a = round2(signedAmount);
  return { account_code, partner_type: 'customer', partner_id: customerId, label, debit: a > 0 ? a : 0, credit: a < 0 ? -a : 0 };
}

export function createMove(move, lines) {
  // Date de verrouillage (option Comptabilité) : aucune écriture avant ou à cette date
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
    const payAcc = bank_account_code || METHOD_ACCOUNT[method] || '5131';
    const journal = method === 'cash' ? 'CAI' : 'BNK';
    if (document_id) {
      const d = get('SELECT d.*, c.name AS customer_name FROM documents d LEFT JOIN customers c ON c.id=d.customer_id WHERE d.id=?', document_id);
      if (!d || !['invoice', 'credit_note'].includes(d.type) || d.status === 'draft') throw new BusinessError('Facture non validée');
      const refund = d.type === 'credit_note'; // remboursement d'un avoir au client
      const pid = insert('payments', { direction: refund ? 'out' : 'in', date, amount, method, document_id, customer_id: d.customer_id, reference, note, bank_line_id },
        ['direction', 'date', 'amount', 'method', 'document_id', 'customer_id', 'reference', 'note', 'bank_line_id']);
      const label = `${refund ? 'Remboursement' : 'Encaissement'} ${d.number}`;
      createMove({ journal_code: journal, date, ref: d.number, label: `${refund ? 'Remboursement' : 'Encaissement'} ${d.customer_name}`, payment_id: pid, bank_line_id }, [
        { account_code: payAcc, label, debit: refund ? 0 : amount, credit: refund ? amount : 0 },
        { account_code: '4011', partner_type: 'customer', partner_id: d.customer_id, label, debit: refund ? amount : 0, credit: refund ? 0 : amount },
      ]);
      run('UPDATE documents SET amount_paid=amount_paid+? WHERE id=?', amount, document_id);
      refreshPaymentStatus(document_id);
      return pid;
    }
    if (purchase_id) {
      const p = get('SELECT p.*, s.name AS supplier_name FROM purchases p LEFT JOIN suppliers s ON s.id=p.supplier_id WHERE p.id=?', purchase_id);
      if (!p || !p.posted) throw new BusinessError('Facture fournisseur non comptabilisée');
      const pid = insert('payments', { direction: 'out', date, amount, method, purchase_id, supplier_id: p.supplier_id, reference, note, bank_line_id },
        ['direction', 'date', 'amount', 'method', 'purchase_id', 'supplier_id', 'reference', 'note', 'bank_line_id']);
      createMove({ journal_code: journal, date, ref: p.supplier_ref || p.number, label: `Paiement ${p.supplier_name}`, payment_id: pid, bank_line_id }, [
        { account_code: '4411', partner_type: 'supplier', partner_id: p.supplier_id, label: `Paiement ${p.number}`, debit: amount, credit: 0 },
        { account_code: payAcc, label: `Paiement ${p.number}`, debit: 0, credit: amount },
      ]);
      run('UPDATE purchases SET amount_paid=amount_paid+? WHERE id=?', amount, purchase_id);
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
    if (id) {
      const cur = get('SELECT * FROM purchases WHERE id=?', id);
      if (cur.posted) { update('purchases', id, { notes: data.notes }, ['notes']); return id; }
      update('purchases', id, data, PURCHASE_COLS.filter((c) => c !== 'number' && c !== 'status'));
    } else {
      id = insert('purchases', { ...data, status: 'draft', number: nextNumber('purchase', data.date || today()), date: data.date || today() }, PURCHASE_COLS);
    }
    if (Array.isArray(data.lines)) {
      const received = Object.fromEntries(all('SELECT id, received_qty FROM purchase_lines WHERE purchase_id=?', id).map((l) => [l.id, l.received_qty]));
      run('DELETE FROM purchase_lines WHERE purchase_id=?', id);
      for (const l of data.lines) {
        insert('purchase_lines', { ...l, purchase_id: id, received_qty: received[l.id] || 0, total_ht: lineTotal({ ...l, kind: 'part' }) }, PLINE_COLS);
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
  const bank = sum(`SELECT SUM(debit-credit) v FROM move_lines WHERE account_code IN ('5131','5161')`) + sum('SELECT SUM(opening_balance) v FROM bank_accounts');
  const ordersOpen = get(`SELECT COUNT(*) n FROM documents WHERE type='order' AND status NOT IN ('invoiced','cancelled')`).n;
  const quotesPending = get(`SELECT COUNT(*) n FROM documents WHERE type='quote' AND status IN ('draft','sent')`).n;
  const lowStock = all('SELECT id, ref, name, qty_on_hand, qty_min FROM products WHERE active=1 AND is_service=0 AND qty_on_hand<=qty_min AND qty_min>0 ORDER BY name LIMIT 20');
  const present = all(`SELECT u.id, u.name, u.color,
      (SELECT d.number FROM time_entries w JOIN documents d ON d.id=w.document_id WHERE w.user_id=u.id AND w.kind='work' AND w.end IS NULL LIMIT 1) AS working_on
    FROM users u WHERE u.active=1 AND u.role='mechanic' AND EXISTS (SELECT 1 FROM time_entries t WHERE t.user_id=u.id AND t.kind='presence' AND t.end IS NULL)`);
  const appointmentsToday = all(`SELECT a.*, c.name AS customer_name, v.plate, v.make, v.model, u.name AS mechanic_name FROM appointments a
    LEFT JOIN customers c ON c.id=a.customer_id LEFT JOIN vehicles v ON v.id=a.vehicle_id LEFT JOIN users u ON u.id=a.mechanic_id
    WHERE substr(a.start,1,10)=? ORDER BY a.start`, t);
  const unmatchedBank = get(`SELECT COUNT(*) n FROM bank_lines WHERE status='unmatched'`).n;
  const inspectionsSoon = all(`SELECT v.id, v.plate, v.make, v.model, v.next_inspection, c.name AS customer_name, c.phone, c.mobile FROM vehicles v
    LEFT JOIN customers c ON c.id=v.customer_id WHERE v.next_inspection BETWEEN ? AND date(?, '+30 days') ORDER BY v.next_inspection LIMIT 20`, t, t);
  const monthly = all(`SELECT substr(date,1,7) AS month, ROUND(SUM(CASE WHEN type='credit_note' THEN -subtotal ELSE subtotal END),2) AS total
    FROM documents WHERE type IN ('invoice','credit_note') AND status!='draft' AND date>=date(?, '-11 months', 'start of month')
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
