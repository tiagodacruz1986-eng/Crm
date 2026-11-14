// Personnalisation des fiches (façon « Studio » d'Odoo) : le gérant ajoute lui-même, sans programmer,
// des zones de texte et autres champs, des zones de dépôt de fichiers PDF et des boutons sur les fiches
// (client, véhicule, devis, ordre de réparation, facture, article, achat, opportunité).
import { db, all, get, run, insert, update, tx, today, localDateTime, isDate } from './db.js';
import { saveAttachment } from './bills.js';
import { logMessage, createActivity, ACTIVITY_TYPES } from './mail.js';
import { BusinessError } from './business.js';
import { can } from './access.js';

db.exec(`
CREATE TABLE IF NOT EXISTS studio_fields (
  id INTEGER PRIMARY KEY, target TEXT NOT NULL, kind TEXT NOT NULL, label TEXT NOT NULL, help TEXT, options TEXT,
  sequence INTEGER DEFAULT 0, active INTEGER DEFAULT 1, created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_studio_fields ON studio_fields(target, sequence);
CREATE TABLE IF NOT EXISTS studio_values (
  field_id INTEGER NOT NULL, record_id INTEGER NOT NULL, value TEXT, updated_at TEXT, updated_by INTEGER,
  PRIMARY KEY(field_id, record_id)
);`);
// Fichier déposé dans une zone personnalisée : il reste une pièce jointe de la fiche, rangée dans sa zone
if (!all('PRAGMA table_info(attachments)').some((c) => c.name === 'zone_id')) db.exec('ALTER TABLE attachments ADD COLUMN zone_id INTEGER');

/** Fiches personnalisables. « model » : le type de fiche en base (les devis, OR et factures sont tous des documents). */
export const TARGETS = {
  customer: { label: 'Client', model: 'customer' },
  vehicle: { label: 'Véhicule', model: 'vehicle' },
  quote: { label: 'Devis', model: 'document' },
  order: { label: 'Ordre de réparation', model: 'document' },
  invoice: { label: 'Facture et avoir', model: 'document' },
  product: { label: 'Article', model: 'product' },
  purchase: { label: 'Achat / facture fournisseur', model: 'purchase' },
  lead: { label: 'Opportunité (CRM)', model: 'lead' },
};
export const MODELS = [...new Set(Object.values(TARGETS).map((t) => t.model))];
export const KINDS = {
  text: 'Zone de texte (une ligne)', textarea: 'Zone de texte (plusieurs lignes)', number: 'Nombre', date: 'Date',
  checkbox: 'Case à cocher', select: 'Liste de choix', file: 'Zone de fichiers (PDF)', button: 'Bouton',
};
export const ACTIONS = { link: 'Ouvrir un lien (site, catalogue…)', email: 'Préparer un e-mail', activity: 'Planifier une activité', stamp: 'Remplir un champ (date du jour, case cochée…)' };
const VALUE_KINDS = ['text', 'textarea', 'number', 'date', 'checkbox', 'select'];
const STAMP_KINDS = ['date', 'checkbox', 'text'];
const FILE_MIMES = { pdf: ['application/pdf'], any: ['application/pdf', 'image/jpeg', 'image/png', 'image/webp'] };
const MAX_FILES = 30, MAX_FIELDS = 40;

/** Mots à remplacer dans les liens et les e-mails des boutons : {plaque}, {client}… selon la fiche. */
export const PLACEHOLDERS = {
  customer: ['client', 'societe', 'email', 'telephone'],
  vehicle: ['plaque', 'vin', 'marque', 'modele', 'client', 'email', 'telephone'],
  quote: ['numero', 'client', 'email', 'telephone', 'plaque', 'vin', 'marque', 'modele', 'total'],
  order: ['numero', 'client', 'email', 'telephone', 'plaque', 'vin', 'marque', 'modele', 'total'],
  invoice: ['numero', 'client', 'email', 'telephone', 'plaque', 'vin', 'marque', 'modele', 'total'],
  product: ['reference', 'article'],
  purchase: ['numero', 'fournisseur', 'reference'],
  lead: ['opportunite', 'client', 'email', 'telephone', 'plaque'],
};

const str = (v, max) => String(v ?? '').trim().slice(0, max);
const parse = (s) => { try { return JSON.parse(s || '{}') || {}; } catch { return {}; } };
const out = (f) => ({ id: f.id, target: f.target, kind: f.kind, label: f.label, help: f.help || '', options: parse(f.options), sequence: f.sequence, active: f.active });

/** À quelle fiche personnalisable correspond cet enregistrement ? (un document dépend de son type) */
export function targetOf(model, id) {
  if (!MODELS.includes(model)) throw new BusinessError('Type de fiche inconnu');
  const table = { customer: 'customers', vehicle: 'vehicles', document: 'documents', product: 'products', purchase: 'purchases', lead: 'crm_leads' }[model];
  const row = get(`SELECT ${model === 'document' ? 'type' : 'id'} AS v FROM ${table} WHERE id=?`, Number(id) || 0);
  if (!row) throw new BusinessError('Fiche introuvable', 404);
  if (model !== 'document') return model;
  return { quote: 'quote', order: 'order', invoice: 'invoice', credit_note: 'invoice' }[row.v] || 'invoice';
}

export function listFields(target, { all: every = false } = {}) {
  if (!TARGETS[target]) throw new BusinessError('Fiche inconnue');
  return all(`SELECT * FROM studio_fields WHERE target=? ${every ? '' : 'AND active=1'} ORDER BY sequence, id`, target).map(out);
}

/** Options contrôlées selon le type d'élément. */
function cleanOptions(kind, o = {}, target, selfId = null, prev = {}) {
  if (!o || typeof o !== 'object' || Array.isArray(o)) o = {};
  const res = {};
  if (kind === 'text' || kind === 'textarea') res.placeholder = str(o.placeholder, 80);
  if (kind === 'number') res.unit = str(o.unit, 12);
  if (kind === 'select') {
    const choices = [...new Set((Array.isArray(o.choices) ? o.choices : String(o.choices || '').split('\n')).map((c) => str(c, 60)).filter(Boolean))].slice(0, 30);
    if (!choices.length) throw new BusinessError('Liste de choix : indiquez au moins un choix (un par ligne)');
    res.choices = choices;
  }
  if (kind === 'file') res.accept = o.accept === 'any' ? 'any' : 'pdf';
  if (kind === 'button') {
    if (!ACTIONS[o.action]) throw new BusinessError('Bouton : choisissez ce qu\'il doit faire');
    res.action = o.action;
    if (o.action === 'link') {
      res.url = str(o.url, 500);
      // adresse web, e-mail ou téléphone uniquement (jamais de script)
      if (/^https?:/i.test(res.url) && /\s/.test(res.url)) throw new BusinessError('Bouton « lien » : l\'adresse ne doit pas contenir d\'espace (remplacez-les par %20)');
      if (!/^(https?:\/\/[^\s]+|mailto:[^\s?]+(\?[^\r\n]*)?|tel:(\{[a-z_]+\}|[+\d][\d\s().-]*))$/i.test(res.url)) throw new BusinessError('Bouton « lien » : l\'adresse doit commencer par https:// (ou mailto: pour un e-mail, tel: pour un numéro de téléphone)');
    }
    if (o.action === 'email') {
      res.subject = str(o.subject, 200); res.body = String(o.body ?? '').slice(0, 5000);
      if (!res.subject) throw new BusinessError('Bouton « e-mail » : indiquez l\'objet du message');
    }
    if (o.action === 'activity') {
      res.summary = str(o.summary, 200);
      if (!res.summary) throw new BusinessError('Bouton « activité » : indiquez ce qu\'il faudra faire');
      res.activity_type = ACTIVITY_TYPES[o.activity_type] ? o.activity_type : 'todo';
      const days = o.days === undefined || o.days === null || o.days === '' ? 0 : Number(o.days);
      if (!Number.isInteger(days) || days < 0 || days > 365) throw new BusinessError('Bouton « activité » : le délai doit être compris entre 0 et 365 jours');
      res.days = days;
    }
    if (o.action === 'stamp') {
      // le champ doit être affiché sur les fiches ; un bouton déjà en place garde le sien, même masqué depuis
      const f = get('SELECT id, kind, active FROM studio_fields WHERE id=? AND target=?', Number(o.field_id) || 0, target);
      if (!f || f.id === selfId || !STAMP_KINDS.includes(f.kind) || (!f.active && f.id !== prev?.field_id)) throw new BusinessError('Bouton « remplir un champ » : choisissez un champ date, case à cocher ou texte de cette fiche');
      res.field_id = f.id;
    }
  }
  return res;
}

/** Crée ou modifie un élément (réservé à l'administrateur). Le type et la fiche d'un élément existant ne changent pas. */
export function saveField(data, id = null) {
  if (!data || typeof data !== 'object') throw new BusinessError('Élément vide');
  const cur = id ? get('SELECT * FROM studio_fields WHERE id=?', id) : null;
  if (id && !cur) throw new BusinessError('Élément introuvable', 404);
  const target = cur ? cur.target : data.target, kind = cur ? cur.kind : data.kind;
  if (!TARGETS[target]) throw new BusinessError('Fiche inconnue');
  if (!KINDS[kind]) throw new BusinessError('Type d\'élément inconnu');
  const label = str(data.label ?? cur?.label, 60);
  if (!label) throw new BusinessError('Donnez un nom à cet élément');
  const prev = cur ? parse(cur.options) : {};
  const row = { target, kind, label, help: str(data.help ?? cur?.help, 200) || null,
    options: JSON.stringify(cleanOptions(kind, data.options === undefined && cur ? prev : data.options, target, id, prev)),
    active: data.active === undefined ? (cur ? cur.active : 1) : data.active ? 1 : 0 };
  if (cur) {
    if (cur.active && !row.active) { const b = stampButtons(cur); if (b.length) throw new BusinessError(`Le bouton « ${b[0].label} » remplit ce champ : masquez ou modifiez d'abord le bouton.`); }
    update('studio_fields', id, row, ['label', 'help', 'options', 'active']);
    return id;
  }
  if (get('SELECT COUNT(*) n FROM studio_fields WHERE target=?', target).n >= MAX_FIELDS) throw new BusinessError(`Maximum ${MAX_FIELDS} éléments par fiche`);
  row.sequence = (get('SELECT COALESCE(MAX(sequence), 0) + 1 AS n FROM studio_fields WHERE target=?', target)).n;
  return insert('studio_fields', row, ['target', 'kind', 'label', 'help', 'options', 'sequence', 'active']);
}

/** Boutons « remplir un champ » qui visent cet élément. */
const stampButtons = (f) => all("SELECT id, label, options FROM studio_fields WHERE target=? AND kind='button' AND id!=?", f.target, f.id)
  .filter((b) => { const o = parse(b.options); return o.action === 'stamp' && o.field_id === f.id; });

/**
 * Après la modification d'une liste de choix : message si des fiches utilisent encore un choix retiré ou renommé
 * (ce choix reste affiché sur ces fiches, marqué « ancien choix », tant qu'on n'en choisit pas un autre).
 */
export function choicesNotice(id) {
  const f = get("SELECT options FROM studio_fields WHERE id=? AND kind='select'", id);
  if (!f) return null;
  const choices = parse(f.options).choices || [];
  const old = all('SELECT value, COUNT(*) AS n FROM studio_values WHERE field_id=? GROUP BY value', id).filter((v) => !choices.includes(v.value));
  if (!old.length) return null;
  const n = old.reduce((s, v) => s + v.n, 0);
  return `${n} fiche(s) utilisent encore ${old.length > 1 ? 'd\'anciens choix' : 'l\'ancien choix'} (${old.slice(0, 3).map((v) => `« ${v.value} »`).join(', ')}) : il reste affiché sur ces fiches jusqu'à ce qu'on en choisisse un autre.`;
}

/**
 * Supprime un élément et les valeurs saisies. Une zone qui contient encore des fichiers ne se supprime pas
 * (ils deviendraient introuvables) : on la masque, ou on retire d'abord les fichiers.
 */
export function deleteField(id) {
  const f = get('SELECT * FROM studio_fields WHERE id=?', id);
  if (!f) throw new BusinessError('Élément introuvable', 404);
  const used = stampButtons(f);
  if (used.length) throw new BusinessError(`Le bouton « ${used[0].label} » remplit ce champ : supprimez ou modifiez d'abord le bouton.`);
  if (f.kind === 'file') {
    const files = get('SELECT COUNT(*) AS n, COUNT(DISTINCT record_id) AS r FROM attachments WHERE zone_id=?', id);
    if (files.n) throw new BusinessError(`Cette zone contient encore ${files.n} fichier(s) sur ${files.r} fiche(s). Pour ne rien perdre, masquez-la (décochez « Affiché sur les fiches ») ou retirez d'abord ces fichiers.`);
  }
  tx(() => {
    run('DELETE FROM studio_values WHERE field_id=?', id);
    run('DELETE FROM studio_fields WHERE id=?', id);
  });
  return { ok: true };
}

/** Nouvel ordre d'affichage des éléments d'une fiche. */
export function orderFields(target, ids) {
  if (!TARGETS[target] || !Array.isArray(ids)) throw new BusinessError('Ordre invalide');
  const known = new Set(all('SELECT id FROM studio_fields WHERE target=?', target).map((f) => f.id));
  tx(() => { ids.map(Number).filter((i) => known.has(i)).forEach((fid, i) => run('UPDATE studio_fields SET sequence=? WHERE id=?', i + 1, fid)); });
  return listFields(target, { all: true });
}

/** Valeur contrôlée d'un champ ; null = vide. */
function cleanValue(f, v, stored = null) {
  const o = f.options || {};
  if (v === null || v === undefined || v === '') return null;
  switch (f.kind) {
    case 'text': if (typeof v !== 'string' && typeof v !== 'number') throw new BusinessError(`${f.label} : texte attendu`); return String(v).replace(/[\r\n]+/g, ' ').slice(0, 500);
    case 'textarea': if (typeof v !== 'string') throw new BusinessError(`${f.label} : texte attendu`); return v.slice(0, 10000);
    case 'number': {
      // « 1 234,5 » comme « 1234.5 » ; ni lettres, ni notation scientifique
      let n = NaN;
      if (typeof v === 'number') n = v;
      else if (typeof v === 'string') {
        const s = v.replace(/[\s\u00a0\u202f]/g, '');
        if (s === '') return null;
        if (/^-?\d+([.,]\d+)?$/.test(s)) n = Number(s.replace(',', '.'));
      }
      if (!Number.isFinite(n) || Math.abs(n) > 1e12) throw new BusinessError(`${f.label} : nombre invalide (exemple : 12,5)`);
      return String(n);
    }
    case 'date': if (!isDate(v)) throw new BusinessError(`${f.label} : date invalide`); return v;
    case 'checkbox': return v === true || v === 1 || v === '1' ? '1' : null;
    // un ancien choix (retiré de la liste depuis) peut rester tel quel sur la fiche
    case 'select': if (!(o.choices || []).includes(v) && v !== stored) throw new BusinessError(`${f.label} : choix inconnu`); return v;
    default: throw new BusinessError(`${f.label} ne se remplit pas`);
  }
}
const typed = (f, v) => (v === null || v === undefined ? null : f.kind === 'number' ? Number(v) : f.kind === 'checkbox' ? v === '1' : v);

/** Mots {plaque}, {client}… disponibles pour cette fiche (liens et e-mails des boutons). */
export function context(model, id, user = null) {
  // sur un véhicule ou un document, l'e-mail et le téléphone du client ne sont donnés qu'à qui peut lire les Contacts
  const hide = user && (model === 'vehicle' || model === 'document') && !can(user, 'contacts', 'read');
  const pick = (r, map) => Object.fromEntries(Object.entries(map).map(([k, col]) => [k, hide && (k === 'email' || k === 'telephone') ? '' : r?.[col] ?? '']));
  if (model === 'customer') return pick(get('SELECT name, company, email, COALESCE(mobile, phone) AS tel FROM customers WHERE id=?', id), { client: 'name', societe: 'company', email: 'email', telephone: 'tel' });
  if (model === 'vehicle') return pick(get(`SELECT v.plate, v.vin, v.make, v.model, c.name, c.email, COALESCE(c.mobile, c.phone) AS tel FROM vehicles v LEFT JOIN customers c ON c.id=v.customer_id WHERE v.id=?`, id),
    { plaque: 'plate', vin: 'vin', marque: 'make', modele: 'model', client: 'name', email: 'email', telephone: 'tel' });
  if (model === 'document') return pick(get(`SELECT d.number, d.total, c.name, c.email, COALESCE(c.mobile, c.phone) AS tel, v.plate, v.vin, v.make, v.model FROM documents d
    LEFT JOIN customers c ON c.id=d.customer_id LEFT JOIN vehicles v ON v.id=d.vehicle_id WHERE d.id=?`, id),
  { numero: 'number', client: 'name', email: 'email', telephone: 'tel', plaque: 'plate', vin: 'vin', marque: 'make', modele: 'model', total: 'total' });
  if (model === 'product') return pick(get('SELECT ref, name FROM products WHERE id=?', id), { reference: 'ref', article: 'name' });
  if (model === 'purchase') return pick(get('SELECT p.number, p.supplier_ref, s.name FROM purchases p LEFT JOIN suppliers s ON s.id=p.supplier_id WHERE p.id=?', id), { numero: 'number', fournisseur: 'name', reference: 'supplier_ref' });
  if (model === 'lead') return pick(get('SELECT name, contact_name, email, phone, vehicle_plate FROM crm_leads WHERE id=?', id), { opportunite: 'name', client: 'contact_name', email: 'email', telephone: 'phone', plaque: 'vehicle_plate' });
  return {};
}
/** Remplace {plaque}, {client}… ; dans une adresse web, les valeurs sont encodées. */
const euros = new Intl.NumberFormat('fr-LU', { style: 'currency', currency: 'EUR' });
export function fill(template, ctx, encode = false) {
  return String(template || '').replace(/\{([a-z_]+)\}/gi, (m, k) => {
    const key = k.toLowerCase();
    if (!Object.hasOwn(ctx, key)) return m;
    if (encode) return encodeURIComponent(String(ctx[key] ?? ''));
    return key === 'total' && ctx[key] !== '' ? euros.format(Number(ctx[key]) || 0) : String(ctx[key] ?? '');
  });
}
/** Adresse d'un bouton « lien », avec les informations de la fiche. */
function linkHref(url, ctx) {
  // téléphone : seulement des chiffres et « + »
  if (/^tel:/i.test(url)) return `tel:${fill(url.slice(4), ctx).replace(/[^\d+]/g, '')}`;
  // e-mail : l'adresse telle quelle (sans rien qui puisse ajouter un champ), l'objet et le texte encodés
  if (/^mailto:/i.test(url)) {
    const i = url.indexOf('?');
    const to = fill(i < 0 ? url : url.slice(0, i), ctx).replace(/[?&\s]/g, '');
    return i < 0 ? to : to + fill(url.slice(i), ctx, true).replace(/ /g, '%20'); // l'objet peut contenir des espaces
  }
  return fill(url, ctx, true);
}

/** Tout ce qu'il faut pour afficher la zone personnalisée d'une fiche : éléments, valeurs, fichiers, liens prêts. */
export function recordData(model, id, user = null) {
  id = Number(id);
  const target = targetOf(model, id);
  const fields = listFields(target);
  const values = Object.fromEntries(all(`SELECT v.field_id, v.value FROM studio_values v JOIN studio_fields f ON f.id=v.field_id WHERE v.record_id=? AND f.target=?`, id, target).map((v) => [v.field_id, v.value]));
  const files = {};
  for (const a of all('SELECT id, filename, mime, size, created_at, zone_id FROM attachments WHERE model=? AND record_id=? AND zone_id IS NOT NULL ORDER BY id', model, id)) (files[a.zone_id] ||= []).push(a);
  const ctx = context(model, id, user);
  return {
    model, id, target, target_label: TARGETS[target].label,
    // un bouton « remplir un champ » dont le champ est masqué n'est pas proposé (il ne pourrait qu'échouer)
    fields: fields.filter((f) => !(f.kind === 'button' && f.options.action === 'stamp' && !fields.some((x) => x.id === f.options.field_id))).map((f) => {
      const item = { ...f };
      if (VALUE_KINDS.includes(f.kind)) item.value = typed(f, values[f.id] ?? null);
      if (f.kind === 'file') item.files = files[f.id] || [];
      if (f.kind === 'button') {
        const o = f.options;
        // le lien et le message sont préparés ici, avec les informations de la fiche
        if (o.action === 'link') item.href = linkHref(o.url, ctx);
        if (o.action === 'email') item.mail = { subject: fill(o.subject, ctx), body: fill(o.body, ctx) };
      }
      return item;
    }),
  };
}

/** Enregistre les valeurs saisies sur une fiche : { idDuChamp: valeur }. Les champs inconnus ou d'une autre fiche sont refusés. */
export function saveValues(model, id, values, user) {
  const userId = user?.id ?? null;
  id = Number(id);
  const target = targetOf(model, id);
  if (!values || typeof values !== 'object' || Array.isArray(values)) throw new BusinessError('Valeurs invalides');
  const fields = new Map(listFields(target).map((f) => [f.id, f]));
  const now = localDateTime();
  tx(() => {
    for (const [k, raw] of Object.entries(values)) {
      const f = fields.get(Number(k));
      if (!f || !VALUE_KINDS.includes(f.kind)) throw new BusinessError('Champ inconnu sur cette fiche');
      const v = cleanValue(f, raw, get('SELECT value FROM studio_values WHERE field_id=? AND record_id=?', f.id, id)?.value ?? null);
      if (v === null) run('DELETE FROM studio_values WHERE field_id=? AND record_id=?', f.id, id);
      else run(`INSERT INTO studio_values(field_id, record_id, value, updated_at, updated_by) VALUES(?,?,?,?,?)
        ON CONFLICT(field_id, record_id) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at, updated_by=excluded.updated_by`, f.id, id, v, now, userId || null);
    }
  });
  return recordData(model, id, user);
}

/** Dépose un fichier dans une zone de la fiche (PDF ; images aussi si la zone les accepte). */
export function addFile(model, id, fieldId, file) {
  id = Number(id);
  const target = targetOf(model, id);
  const f = listFields(target).find((x) => x.id === Number(fieldId) && x.kind === 'file');
  if (!f) throw new BusinessError('Zone de fichiers inconnue sur cette fiche');
  if (!file?.buffer?.length) throw new BusinessError('Fichier vide');
  const allowed = FILE_MIMES[f.options.accept] || FILE_MIMES.pdf;
  if (!allowed.includes(file.mime)) throw new BusinessError(f.options.accept === 'any' ? 'Cette zone accepte les PDF et les images (JPEG, PNG, WebP)' : 'Cette zone accepte uniquement les fichiers PDF');
  // le contenu doit vraiment être un PDF (un fichier renommé en .pdf est refusé)
  if (file.mime === 'application/pdf' && file.buffer.subarray(0, 1024).indexOf('%PDF-') < 0) throw new BusinessError('Ce fichier n\'est pas un vrai PDF');
  if (get('SELECT COUNT(*) n FROM attachments WHERE model=? AND record_id=? AND zone_id=?', model, id, f.id).n >= MAX_FILES) throw new BusinessError(`Maximum ${MAX_FILES} fichiers dans cette zone`);
  const attId = saveAttachment(model, id, { ...file, source: 'studio' });
  run('UPDATE attachments SET zone_id=? WHERE id=?', f.id, attId);
  return { id: attId };
}

/** Bouton « remplir un champ » ou « planifier une activité » : exécuté par le serveur, avec une trace dans l'historique de la fiche. */
export function pressButton(model, id, fieldId, user, { force = false } = {}) {
  id = Number(id);
  const target = targetOf(model, id);
  const fields = listFields(target);
  const b = fields.find((x) => x.id === Number(fieldId) && x.kind === 'button');
  if (!b) throw new BusinessError('Bouton inconnu sur cette fiche');
  const o = b.options;
  if (o.action === 'stamp') {
    const f = fields.find((x) => x.id === o.field_id);
    if (!f) throw new BusinessError('Le champ rempli par ce bouton n\'existe plus : modifiez le bouton dans la personnalisation.');
    const day = today().split('-').reverse().join('/'), hour = localDateTime().slice(11, 16);
    const value = f.kind === 'date' ? today() : f.kind === 'checkbox' ? true : `${user.name} — ${day} ${hour}`;
    // le champ contient déjà autre chose : on demande avant de remplacer, et l'ancienne valeur reste dans l'historique
    const old = get('SELECT value FROM studio_values WHERE field_id=? AND record_id=?', f.id, id)?.value ?? null;
    const shown = old === null ? '' : f.kind === 'date' ? old.split('-').reverse().join('/') : old;
    if (old !== null && f.kind !== 'checkbox' && old !== value && !force) return { confirm: `« ${f.label} » contient déjà : ${shown.slice(0, 120)}\nLe remplacer ?` };
    saveValues(model, id, { [f.id]: value }, user);
    logMessage(model, id, `${b.label} : « ${f.label} » rempli par ${user.name} le ${day} à ${hour}${old !== null && f.kind !== 'checkbox' && old !== value ? ` (avant : ${shown.slice(0, 200)})` : ''}`, user.id, 'system');
    return { done: `${f.label} : enregistré`, record: recordData(model, id, user) };
  }
  if (o.action === 'activity') {
    const d = new Date(); d.setDate(d.getDate() + (o.days || 0));
    const due = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const ctx = context(model, id, user);
    createActivity({ model, record_id: id, type: o.activity_type || 'todo', summary: fill(o.summary, ctx).slice(0, 200), due_date: due, user_id: user.id }, user.id);
    return { done: `Activité planifiée pour le ${due.split('-').reverse().join('/')}`, record: recordData(model, id, user) };
  }
  throw new BusinessError('Ce bouton s\'utilise directement depuis la fiche');
}

/** Une fiche supprimée emporte ses valeurs personnalisées. */
export function forgetValues(model, id) {
  const targets = Object.entries(TARGETS).filter(([, t]) => t.model === model).map(([k]) => k);
  if (!targets.length) return;
  run(`DELETE FROM studio_values WHERE record_id=? AND field_id IN (SELECT id FROM studio_fields WHERE target IN (${targets.map(() => '?').join(',')}))`, Number(id), ...targets);
}

export const meta = () => ({
  targets: Object.entries(TARGETS).map(([key, t]) => ({ key, label: t.label, placeholders: PLACEHOLDERS[key], count: get('SELECT COUNT(*) n FROM studio_fields WHERE target=?', key).n })),
  kinds: KINDS, actions: ACTIONS, activity_types: ACTIVITY_TYPES,
});
