// Historique des modifications (comme le suivi des champs d'Odoo) : pour chaque changement d'un document ou d'un achat,
// la fiche garde qui l'a fait, quand, et ce qui a changé (ancienne valeur → nouvelle valeur, lignes ajoutées, retirées
// ou modifiées). On compare la fiche avant et après l'action : rien n'est écrit si rien n'a changé.
import { all, get } from './db.js';
import { logMessage } from './mail.js';

const STATUS = {
  draft: 'Brouillon', sent: 'Envoyé', accepted: 'Accepté', refused: 'Refusé', open: 'À faire', in_progress: 'En cours', waiting_parts: 'Attente pièces',
  done: 'Terminé', invoiced: 'Facturé', cancelled: 'Annulé', posted: 'À payer', partial: 'Partiellement payée', paid: 'Payée',
  ordered: 'Commandé', received: 'Réceptionné', billed: 'Facturé',
};
const KIND = { labor: 'main-d’œuvre', part: 'pièce', fee: 'forfait', text: 'commentaire' };
export const DOC_NAMES = { quote: 'Devis', order: 'Ordre de réparation', invoice: 'Facture', credit_note: 'Note de crédit' };
const MAX_LINES = 30;

const money = (n) => `${Number(n || 0).toLocaleString('fr-LU', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} €`;
const num = (n) => (n === null || n === undefined || n === '' ? '' : String(Number(n)).replace('.', ','));
const fdate = (s) => (s ? `${s.slice(8, 10)}/${s.slice(5, 7)}/${s.slice(0, 4)}` : '');
const fdatetime = (s) => (s ? `${fdate(s)}${s.length > 10 ? ' ' + s.slice(11, 16) : ''}` : '');
const short = (s, n = 80) => { const t = String(s ?? '').replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n - 1) + '…' : t; };
const shown = (v) => (v === null || v === undefined || v === '' ? '(vide)' : v);
const same = (a, b) => (a ?? '') === (b ?? '') || (a !== null && b !== null && a !== '' && b !== '' && !Number.isNaN(Number(a)) && !Number.isNaN(Number(b)) && Number(a) === Number(b));
const quoted = (s, n) => `« ${short(s, n)} »`;

/** Un champ de texte libre : « ancien » → « nouveau », ou seulement ce qui a été ajouté à la fin (note de l'atelier). */
function textChange(label, a, b) {
  const x = String(a ?? ''), y = String(b ?? '');
  if (x.trim() && y.startsWith(x) && y.length > x.length) return `${label} : ajout ${quoted(y.slice(x.length), 160)}`;
  if (!x.trim()) return `${label} : ${quoted(y, 160)}`;
  if (!y.trim()) return `${label} : effacé (avant : ${quoted(x)})`;
  return `${label} : ${quoted(x)} → ${quoted(y)}`;
}

/** Changements entre deux listes de lignes déjà appariées : [{ before, after }] (before ou after absent = ligne retirée / ajoutée). */
function diffLines(pairs, fields) {
  const out = [];
  const what = (l) => (l.kind === 'text' ? `commentaire ${quoted(l.description, 60)}` : `${short(l.description || 'Ligne', 60)} — ${num(l.quantity)} × ${money(l.unit_price)}`);
  for (const { before: a, after: b } of pairs) {
    if (!a && b) out.push(`Ligne ajoutée : ${what(b)}`);
    else if (a && !b) out.push(`Ligne retirée : ${what(a)}`);
    else if (a && b) {
      const ch = [];
      for (const [key, label, fmt] of fields) {
        if (same(a[key], b[key])) continue;
        if (key === 'description') ch.push(`désignation ${quoted(a.description, 50)} → ${quoted(b.description, 50)}`);
        else if (key === 'done') ch.push(b.done ? 'marquée « fait »' : 'n’est plus marquée « fait »');
        else ch.push(`${label} ${shown(fmt(a))} → ${shown(fmt(b))}`);
      }
      if (ch.length) out.push(`Ligne ${quoted(b.description || a.description || 'sans désignation', 50)} : ${ch.join(', ')}`);
    }
  }
  return out;
}

// ---------- Documents : devis, ordres de réparation, factures, notes de crédit ----------
export function snapshotDocument(id) {
  const d = get(`SELECT d.*, c.name AS customer_name, v.plate, v.make, v.model, u.name AS mechanic_name
    FROM documents d LEFT JOIN customers c ON c.id=d.customer_id LEFT JOIN vehicles v ON v.id=d.vehicle_id LEFT JOIN users u ON u.id=d.mechanic_id WHERE d.id=?`, id);
  if (!d) return null;
  d.lines = all('SELECT l.*, u.name AS mechanic_name FROM document_lines l LEFT JOIN users u ON u.id=l.mechanic_id WHERE l.document_id=? ORDER BY l.sequence, l.id', id);
  return d;
}
const DOC_FIELDS = [
  ['status', 'Statut', (d) => STATUS[d.status] || d.status],
  ['customer_id', 'Client', (d) => d.customer_name],
  ['vehicle_id', 'Véhicule', (d) => [d.plate, d.make, d.model].filter(Boolean).join(' ')],
  ['mileage', 'Kilométrage', (d) => (d.mileage === null || d.mileage === undefined || d.mileage === '' ? '' : `${Number(d.mileage).toLocaleString('fr-LU')} km`)],
  ['date', 'Date', (d) => fdate(d.date)],
  ['due_date', 'Échéance', (d) => fdate(d.due_date)],
  ['reference', 'Référence', (d) => d.reference],
  ['mechanic_id', 'Mécanicien', (d) => d.mechanic_name],
  ['promised_at', 'Promis pour', (d) => fdatetime(d.promised_at)],
];
const DOC_TEXTS = [['customer_complaint', 'Demande du client'], ['diagnosis', 'Diagnostic'], ['notes', 'Notes (imprimées)'], ['internal_notes', 'Notes internes']];
const DOC_LINE_FIELDS = [
  ['description', 'désignation', (l) => l.description],
  ['kind', 'type', (l) => KIND[l.kind] || l.kind],
  ['quantity', 'quantité', (l) => num(l.quantity)],
  ['unit_price', 'prix unitaire', (l) => money(l.unit_price)],
  ['discount', 'remise', (l) => `${num(l.discount || 0)} %`],
  ['tax_rate', 'TVA', (l) => `${num(l.tax_rate)} %`],
  ['planned_hours', 'temps prévu', (l) => (l.planned_hours === null || l.planned_hours === undefined || l.planned_hours === '' ? '' : `${num(l.planned_hours)} h`)],
  ['mechanic_id', 'mécanicien', (l) => l.mechanic_name],
  ['done', 'fait', (l) => (l.done ? 'oui' : 'non')],
];

/** Ce qui a changé entre deux états d'un document (liste de phrases, vide si rien). */
export function diffDocument(a, b) {
  if (!a || !b) return [];
  const out = [];
  for (const [key, label, fmt] of DOC_FIELDS) if (!same(a[key], b[key])) out.push(`${label} : ${shown(fmt(a))} → ${shown(fmt(b))}`);
  for (const [key, label] of DOC_TEXTS) if ((a[key] ?? '') !== (b[key] ?? '')) out.push(textChange(label, a[key], b[key]));
  const before = new Map(a.lines.map((l) => [l.id, l]));
  const pairs = b.lines.map((l) => ({ before: before.get(l.id), after: l }));
  const kept = new Set(b.lines.map((l) => l.id));
  for (const l of a.lines) if (!kept.has(l.id)) pairs.push({ before: l, after: null });
  out.push(...diffLines(pairs, DOC_LINE_FIELDS));
  // lignes seulement déplacées
  const order = (d) => d.lines.filter((l) => before.has(l.id) && kept.has(l.id)).map((l) => l.id).join(',');
  if (order(a) !== order(b)) out.push('Ordre des lignes modifié');
  if (Math.abs((a.total || 0) - (b.total || 0)) > 0.004) out.push(`Total TTC : ${money(a.total)} → ${money(b.total)}`);
  return out;
}

// ---------- Achats : bons de commande et factures fournisseurs ----------
export function snapshotPurchase(id) {
  const p = get('SELECT p.*, s.name AS supplier_name FROM purchases p LEFT JOIN suppliers s ON s.id=p.supplier_id WHERE p.id=?', id);
  if (!p) return null;
  p.lines = all('SELECT * FROM purchase_lines WHERE purchase_id=? ORDER BY id', id);
  return p;
}
const BUY_FIELDS = [
  ['status', 'Statut', (p) => STATUS[p.status] || p.status],
  ['supplier_id', 'Fournisseur', (p) => p.supplier_name],
  ['date', 'Date', (p) => fdate(p.date)],
  ['supplier_ref', 'N° de facture du fournisseur', (p) => p.supplier_ref],
  ['due_date', 'Échéance', (p) => fdate(p.due_date)],
];
const BUY_LINE_FIELDS = [
  ['description', 'désignation', (l) => l.description],
  ['quantity', 'quantité', (l) => num(l.quantity)],
  ['unit_price', 'prix unitaire', (l) => money(l.unit_price)],
  ['tax_rate', 'TVA', (l) => `${num(l.tax_rate)} %`],
  ['account_code', 'compte de charge', (l) => l.account_code],
  ['received_qty', 'reçu', (l) => num(l.received_qty || 0)],
];
/**
 * Ce qui a changé sur un achat. Ses lignes sont réécrites à chaque enregistrement (nouveaux identifiants) : `sent` est la
 * liste envoyée par l'écran, dans l'ordre, dont chaque élément porte l'identifiant de la ligne d'avant (ou aucun).
 */
export function diffPurchase(a, b, sent = null) {
  if (!a || !b) return [];
  const out = [];
  for (const [key, label, fmt] of BUY_FIELDS) if (!same(a[key], b[key])) out.push(`${label} : ${shown(fmt(a))} → ${shown(fmt(b))}`);
  if ((a.notes ?? '') !== (b.notes ?? '')) out.push(textChange('Notes', a.notes, b.notes));
  const before = new Map(a.lines.map((l) => [l.id, l]));
  let pairs;
  if (Array.isArray(sent) && sent.length === b.lines.length) {
    const used = new Set();
    pairs = b.lines.map((l, i) => { const old = before.get(sent[i]?.id); if (old && !used.has(old.id)) { used.add(old.id); return { before: old, after: l }; } return { before: null, after: l }; });
    for (const l of a.lines) if (!used.has(l.id)) pairs.push({ before: l, after: null });
  } else {
    pairs = b.lines.map((l) => ({ before: before.get(l.id), after: l }));
    const kept = new Set(b.lines.map((l) => l.id));
    for (const l of a.lines) if (!kept.has(l.id)) pairs.push({ before: l, after: null });
  }
  out.push(...diffLines(pairs, BUY_LINE_FIELDS));
  if (Math.abs((a.total || 0) - (b.total || 0)) > 0.004) out.push(`Total TTC : ${money(a.total)} → ${money(b.total)}`);
  return out;
}

/** Écrit les changements dans l'historique de la fiche, au nom de la personne qui les a faits. */
export function logChanges(model, id, changes, userId) {
  if (!changes?.length) return;
  const list = changes.length > MAX_LINES ? [...changes.slice(0, MAX_LINES), `… et ${changes.length - MAX_LINES} autres changements`] : changes;
  logMessage(model, id, `✏️ Modification\n${list.map((c) => `• ${c}`).join('\n')}`, userId, 'system');
}
