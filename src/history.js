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
const empty = (v) => v === null || v === undefined || v === '';
// Comparaison selon la nature du champ : 't' texte (« 00123 » n'est pas « 123 »), 'n' nombre (vide ≠ 0), 'z' nombre où vide vaut 0
const SAME = {
  t: (a, b) => String(a ?? '') === String(b ?? ''),
  n: (a, b) => (empty(a) || empty(b) ? empty(a) && empty(b) : Number(a) === Number(b)),
  z: (a, b) => (Number(a) || 0) === (Number(b) || 0),
};
const same = (a, b, kind = 't') => SAME[kind](a, b);
const quoted = (s, n) => `« ${short(s, n)} »`;

/**
 * Ancien et nouveau texte à citer. Pour un texte long, ce qui est identique au début et à la fin n'est pas répété :
 * on ne cite que les mots qui ont changé (sinon les deux côtés de la flèche montreraient le même début tronqué).
 */
function changedParts(a, b, cap = 300) {
  const x = String(a ?? ''), y = String(b ?? '');
  if (x.length <= 80 && y.length <= 80) return [x, y];
  let p = 0;
  while (p < x.length && p < y.length && x[p] === y[p]) p++;
  let s = 0;
  while (s < x.length - p && s < y.length - p && x[x.length - 1 - s] === y[y.length - 1 - s]) s++;
  // (on cite des mots entiers)
  while (p > 0 && !/\s/.test(x[p - 1])) p--;
  while (s > 0 && !/\s/.test(x[x.length - s])) s--;
  const part = (t) => `${p > 0 ? '… ' : ''}${short(t.slice(p, t.length - s), cap)}${s > 0 ? ' …' : ''}`;
  return [part(x), part(y)];
}
/** Un champ de texte libre : « ancien » → « nouveau », ou seulement ce qui a été ajouté ou retiré. */
function textChange(label, a, b) {
  const x = String(a ?? ''), y = String(b ?? '');
  if (!x.trim()) return `${label} : ${quoted(y, 300)}`;
  if (!y.trim()) return `${label} : effacé (avant : ${quoted(x, 300)})`;
  if (y.startsWith(x)) return `${label} : ajout ${quoted(y.slice(x.length), 300)}`;
  if (x.startsWith(y)) return `${label} : retiré ${quoted(x.slice(y.length), 300)}`;
  const [o, n] = changedParts(x, y);
  return `${label} : « ${o} » → « ${n} »`;
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
      for (const [key, label, fmt, kind] of fields) {
        if (same(a[key], b[key], kind)) continue;
        if (key === 'description') { const [o, n] = changedParts(a.description, b.description, 120); ch.push(`désignation « ${o} » → « ${n} »`); }
        else if (key === 'done') ch.push(b.done ? 'marquée « fait »' : 'n’est plus marquée « fait »');
        else ch.push(`${label} ${shown(fmt(a))} → ${shown(fmt(b))}`);
      }
      if (ch.length) out.push(`Ligne ${quoted(b.description || a.description || 'sans désignation', 50)} : ${ch.join(', ')}`);
    }
  }
  // (un document de cent lignes toutes modifiées : les premières sont citées, le reste est compté — les champs et le total restent)
  return out.length > MAX_LINES ? [...out.slice(0, MAX_LINES), `… et ${out.length - MAX_LINES} autres lignes modifiées`] : out;
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
  ['status', 'Statut', (d) => STATUS[d.status] || d.status, 't'],
  ['customer_id', 'Client', (d) => d.customer_name, 'n'],
  ['vehicle_id', 'Véhicule', (d) => [d.plate, d.make, d.model].filter(Boolean).join(' '), 'n'],
  ['mileage', 'Kilométrage', (d) => (d.mileage === null || d.mileage === undefined || d.mileage === '' ? '' : `${Number(d.mileage).toLocaleString('fr-LU')} km`), 'n'],
  ['date', 'Date', (d) => fdate(d.date), 't'],
  ['due_date', 'Échéance', (d) => fdate(d.due_date), 't'],
  ['reference', 'Référence', (d) => d.reference, 't'],
  ['mechanic_id', 'Mécanicien', (d) => d.mechanic_name, 'n'],
  ['promised_at', 'Promis pour', (d) => fdatetime(d.promised_at), 't'],
];
const DOC_TEXTS = [['customer_complaint', 'Demande du client'], ['diagnosis', 'Diagnostic'], ['notes', 'Notes (imprimées)'], ['internal_notes', 'Notes internes']];
const DOC_LINE_FIELDS = [
  ['description', 'désignation', (l) => l.description, 't'],
  ['kind', 'type', (l) => KIND[l.kind] || l.kind, 't'],
  ['quantity', 'quantité', (l) => num(l.quantity), 'z'],
  ['unit_price', 'prix unitaire', (l) => money(l.unit_price), 'z'],
  ['discount', 'remise', (l) => `${num(l.discount || 0)} %`, 'z'],
  ['tax_rate', 'TVA', (l) => `${num(l.tax_rate)} %`, 'z'],
  ['planned_hours', 'temps prévu', (l) => (l.planned_hours === null || l.planned_hours === undefined || l.planned_hours === '' ? '' : `${num(l.planned_hours)} h`), 'n'],
  ['mechanic_id', 'mécanicien', (l) => l.mechanic_name, 'n'],
  ['done', 'fait', (l) => (l.done ? 'oui' : 'non'), 'z'],
];

/** Ce qui a changé entre deux états d'un document (liste de phrases, vide si rien). */
export function diffDocument(a, b) {
  if (!a || !b) return [];
  const out = [];
  for (const [key, label, fmt, kind] of DOC_FIELDS) if (!same(a[key], b[key], kind)) out.push(`${label} : ${shown(fmt(a))} → ${shown(fmt(b))}`);
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
  ['status', 'Statut', (p) => STATUS[p.status] || p.status, 't'],
  ['supplier_id', 'Fournisseur', (p) => p.supplier_name, 'n'],
  ['date', 'Date', (p) => fdate(p.date), 't'],
  ['supplier_ref', 'N° de facture du fournisseur', (p) => p.supplier_ref, 't'],
  ['due_date', 'Échéance', (p) => fdate(p.due_date), 't'],
];
const BUY_LINE_FIELDS = [
  ['description', 'désignation', (l) => l.description, 't'],
  ['quantity', 'quantité', (l) => num(l.quantity), 'z'],
  ['unit_price', 'prix unitaire', (l) => money(l.unit_price), 'z'],
  ['tax_rate', 'TVA', (l) => `${num(l.tax_rate)} %`, 'z'],
  ['account_code', 'compte de charge', (l) => l.account_code, 't'],
  ['received_qty', 'reçu', (l) => num(l.received_qty || 0), 'z'],
];
/**
 * Ce qui a changé sur un achat. Ses lignes sont réécrites à chaque enregistrement (nouveaux identifiants) : `sent` est la
 * liste envoyée par l'écran, dans l'ordre, dont chaque élément porte l'identifiant de la ligne d'avant (ou aucun).
 */
export function diffPurchase(a, b, sent = null) {
  if (!a || !b) return [];
  const out = [];
  for (const [key, label, fmt, kind] of BUY_FIELDS) if (!same(a[key], b[key], kind)) out.push(`${label} : ${shown(fmt(a))} → ${shown(fmt(b))}`);
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
  logMessage(model, id, `✏️ Modification\n${changes.map((c) => `• ${c}`).join('\n')}`, userId, 'system');
}
