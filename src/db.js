// Base de données SQLite intégrée à Node (aucune installation séparée nécessaire).
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

const DATA_DIR = process.env.DATA_DIR || path.resolve('data');
fs.mkdirSync(DATA_DIR, { recursive: true });

export const dataDir = DATA_DIR;
export const db = new DatabaseSync(path.join(DATA_DIR, process.env.DB_FILE || 'garage.db'));
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, email TEXT UNIQUE, role TEXT NOT NULL DEFAULT 'mechanic',
  password_hash TEXT, pin_hash TEXT, hourly_cost REAL DEFAULT 0, color TEXT DEFAULT '#3b82f6',
  active INTEGER DEFAULT 1, created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT DEFAULT 'web', created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS customers (
  id INTEGER PRIMARY KEY, type TEXT DEFAULT 'particulier', name TEXT NOT NULL, company TEXT,
  vat_number TEXT, email TEXT, phone TEXT, mobile TEXT, address TEXT, zip TEXT, city TEXT,
  country TEXT DEFAULT 'LU', payment_terms INTEGER, notes TEXT, marketing_ok INTEGER DEFAULT 1,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS vehicles (
  id INTEGER PRIMARY KEY, customer_id INTEGER REFERENCES customers(id) ON DELETE SET NULL,
  plate TEXT, vin TEXT, make TEXT, model TEXT, version TEXT, fuel TEXT, year INTEGER,
  first_registration TEXT, mileage INTEGER, color TEXT, engine_code TEXT, tyre_size TEXT,
  next_inspection TEXT, next_service_date TEXT, next_service_km INTEGER, notes TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_vehicles_plate ON vehicles(plate);

CREATE TABLE IF NOT EXISTS suppliers (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, vat_number TEXT, email TEXT, phone TEXT,
  address TEXT, zip TEXT, city TEXT, country TEXT DEFAULT 'LU', iban TEXT, website TEXT,
  default_account TEXT DEFAULT '6070', notes TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS products (
  id INTEGER PRIMARY KEY, ref TEXT, ean TEXT, name TEXT NOT NULL, category TEXT, brand TEXT,
  supplier_id INTEGER REFERENCES suppliers(id) ON DELETE SET NULL,
  purchase_price REAL DEFAULT 0, sale_price REAL DEFAULT 0, tax_rate REAL DEFAULT 17,
  qty_on_hand REAL DEFAULT 0, qty_min REAL DEFAULT 0, location TEXT, unit TEXT DEFAULT 'pce',
  is_service INTEGER DEFAULT 0, labor_hours REAL, active INTEGER DEFAULT 1,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_products_ref ON products(ref);
CREATE TABLE IF NOT EXISTS stock_moves (
  id INTEGER PRIMARY KEY, product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  qty REAL NOT NULL, kind TEXT NOT NULL, unit_cost REAL, document_id INTEGER, purchase_id INTEGER,
  note TEXT, date TEXT DEFAULT CURRENT_TIMESTAMP, user_id INTEGER
);

CREATE TABLE IF NOT EXISTS documents (
  id INTEGER PRIMARY KEY, type TEXT NOT NULL, number TEXT, status TEXT NOT NULL DEFAULT 'draft',
  customer_id INTEGER REFERENCES customers(id), vehicle_id INTEGER REFERENCES vehicles(id),
  mileage INTEGER, date TEXT, due_date TEXT, reference TEXT, customer_complaint TEXT,
  diagnosis TEXT, notes TEXT, internal_notes TEXT, mechanic_id INTEGER REFERENCES users(id),
  promised_at TEXT, parent_id INTEGER REFERENCES documents(id),
  subtotal REAL DEFAULT 0, tax_total REAL DEFAULT 0, total REAL DEFAULT 0, amount_paid REAL DEFAULT 0,
  posted_at TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP, updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_documents_type ON documents(type, status);
CREATE TABLE IF NOT EXISTS document_lines (
  id INTEGER PRIMARY KEY, document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  sequence INTEGER DEFAULT 0, kind TEXT NOT NULL DEFAULT 'part', product_id INTEGER REFERENCES products(id),
  description TEXT, quantity REAL DEFAULT 1, unit TEXT, unit_price REAL DEFAULT 0, discount REAL DEFAULT 0,
  tax_rate REAL DEFAULT 17, total_ht REAL DEFAULT 0, mechanic_id INTEGER, done INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS time_entries (
  id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL DEFAULT 'work', document_id INTEGER REFERENCES documents(id) ON DELETE SET NULL,
  line_id INTEGER, start TEXT NOT NULL, end TEXT, note TEXT
);
CREATE INDEX IF NOT EXISTS idx_time_user ON time_entries(user_id, start);

CREATE TABLE IF NOT EXISTS appointments (
  id INTEGER PRIMARY KEY, customer_id INTEGER REFERENCES customers(id) ON DELETE SET NULL,
  vehicle_id INTEGER REFERENCES vehicles(id) ON DELETE SET NULL, mechanic_id INTEGER REFERENCES users(id),
  start TEXT NOT NULL, end TEXT NOT NULL, title TEXT, notes TEXT, status TEXT DEFAULT 'planned',
  document_id INTEGER REFERENCES documents(id) ON DELETE SET NULL, courtesy_car INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS purchases (
  id INTEGER PRIMARY KEY, number TEXT, supplier_id INTEGER REFERENCES suppliers(id),
  status TEXT DEFAULT 'draft', date TEXT, supplier_ref TEXT, due_date TEXT,
  subtotal REAL DEFAULT 0, tax_total REAL DEFAULT 0, total REAL DEFAULT 0, amount_paid REAL DEFAULT 0,
  posted INTEGER DEFAULT 0, notes TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS purchase_lines (
  id INTEGER PRIMARY KEY, purchase_id INTEGER NOT NULL REFERENCES purchases(id) ON DELETE CASCADE,
  product_id INTEGER REFERENCES products(id), description TEXT, quantity REAL DEFAULT 1,
  unit_price REAL DEFAULT 0, tax_rate REAL DEFAULT 17, total_ht REAL DEFAULT 0,
  received_qty REAL DEFAULT 0, account_code TEXT
);

CREATE TABLE IF NOT EXISTS accounts (
  code TEXT PRIMARY KEY, name TEXT NOT NULL, type TEXT NOT NULL, reconcilable INTEGER DEFAULT 0
);
CREATE TABLE IF NOT EXISTS journals (code TEXT PRIMARY KEY, name TEXT NOT NULL, type TEXT);
CREATE TABLE IF NOT EXISTS moves (
  id INTEGER PRIMARY KEY, journal_code TEXT NOT NULL REFERENCES journals(code), date TEXT NOT NULL,
  ref TEXT, label TEXT, document_id INTEGER, purchase_id INTEGER, payment_id INTEGER, bank_line_id INTEGER,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS move_lines (
  id INTEGER PRIMARY KEY, move_id INTEGER NOT NULL REFERENCES moves(id) ON DELETE CASCADE,
  account_code TEXT NOT NULL REFERENCES accounts(code), partner_type TEXT, partner_id INTEGER,
  label TEXT, debit REAL DEFAULT 0, credit REAL DEFAULT 0, tax_rate REAL, tax_base REAL
);
CREATE INDEX IF NOT EXISTS idx_move_lines_acc ON move_lines(account_code);

CREATE TABLE IF NOT EXISTS payments (
  id INTEGER PRIMARY KEY, direction TEXT NOT NULL, date TEXT NOT NULL, amount REAL NOT NULL,
  method TEXT DEFAULT 'bank', document_id INTEGER REFERENCES documents(id),
  purchase_id INTEGER REFERENCES purchases(id), bank_line_id INTEGER, customer_id INTEGER,
  supplier_id INTEGER, reference TEXT, note TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS bank_accounts (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, iban TEXT, bic TEXT, bank_name TEXT,
  account_code TEXT DEFAULT '5131', opening_balance REAL DEFAULT 0, provider TEXT DEFAULT 'import',
  provider_config TEXT, last_sync TEXT
);
CREATE TABLE IF NOT EXISTS bank_lines (
  id INTEGER PRIMARY KEY, bank_account_id INTEGER NOT NULL REFERENCES bank_accounts(id) ON DELETE CASCADE,
  date TEXT NOT NULL, amount REAL NOT NULL, counterparty TEXT, counterparty_iban TEXT,
  communication TEXT, hash TEXT UNIQUE, status TEXT DEFAULT 'unmatched', payment_id INTEGER,
  move_id INTEGER, created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS agent_messages (
  id INTEGER PRIMARY KEY, agent_id TEXT NOT NULL, role TEXT NOT NULL, content TEXT NOT NULL,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS agent_tasks (
  id INTEGER PRIMARY KEY, agent_id TEXT NOT NULL, title TEXT NOT NULL, prompt TEXT NOT NULL,
  schedule_type TEXT NOT NULL DEFAULT 'once', schedule_time TEXT, schedule_day INTEGER,
  run_at TEXT, next_run TEXT, active INTEGER DEFAULT 1, last_run TEXT, last_status TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS agent_results (
  id INTEGER PRIMARY KEY, task_id INTEGER, agent_id TEXT NOT NULL, title TEXT, content TEXT,
  status TEXT DEFAULT 'ok', read INTEGER DEFAULT 0, created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
`;
db.exec(SCHEMA);

// ---------- Helpers ----------
export const all = (sql, ...p) => db.prepare(sql).all(...p).map((r) => ({ ...r }));
export const get = (sql, ...p) => {
  const r = db.prepare(sql).get(...p);
  return r ? { ...r } : null;
};
export const run = (sql, ...p) => db.prepare(sql).run(...p);

export function tx(fn) {
  db.exec('BEGIN');
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

export const round2 = (n) => Math.round((Number(n) || 0) * 100 + Number.EPSILON) / 100;
export const today = () => localDate(new Date());
export function localDate(d) {
  const z = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())}`;
}
export function localDateTime(d = new Date()) {
  const z = (n) => String(n).padStart(2, '0');
  return `${localDate(d)}T${z(d.getHours())}:${z(d.getMinutes())}:${z(d.getSeconds())}`;
}

// Insert / update génériques limités aux colonnes autorisées
export function insert(table, data, columns) {
  const cols = columns.filter((c) => data[c] !== undefined);
  const r = run(
    `INSERT INTO ${table} (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`,
    ...cols.map((c) => normalize(data[c]))
  );
  return Number(r.lastInsertRowid);
}
export function update(table, id, data, columns, idCol = 'id') {
  const cols = columns.filter((c) => data[c] !== undefined);
  if (!cols.length) return;
  run(`UPDATE ${table} SET ${cols.map((c) => `${c}=?`).join(',')} WHERE ${idCol}=?`, ...cols.map((c) => normalize(data[c])), id);
}
function normalize(v) {
  if (v === '' ) return null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (v !== null && typeof v === 'object') return JSON.stringify(v);
  return v;
}

// ---------- Paramètres ----------
export const DEFAULT_SETTINGS = {
  company: {
    name: 'Mon Garage', legal_form: 'SARL', address: '', zip: '', city: '', country: 'Luxembourg',
    phone: '', email: '', website: '', rcs: '', vat_number: 'LU', matricule: '', autorisation: '',
    iban: '', bic: '', bank_name: '',
  },
  workshop: { labor_rate: 85, default_tax: 17, payment_terms: 15, opening: '08:00', closing: '18:00', bays: 4 },
  numbering: { quote: 'D', order: 'OR', invoice: 'F', credit_note: 'NC', purchase: 'A' },
  invoice_footer: 'Merci pour votre confiance. Paiement par virement en mentionnant le numéro de facture.',
  ai: { garage_context: '' },
  // Mise en page des documents (devis, OR, factures, avoirs) — comme « Configurer la mise en page » d'Odoo
  layout: {
    template: 'moderne', font: 'inter', primary: '#2563eb', secondary: '#0f172a', paper: 'A4', logo_size: 'm', logo_version: null,
    tagline: '', header_note: '', terms: '',
    show_logo: true, show_qr: true, show_bank: true, show_vehicle: true, show_signature: true, show_paid_stamp: true, show_discount: true,
  },
};

export function getSettings() {
  const out = structuredClone(DEFAULT_SETTINGS);
  for (const r of all('SELECT key, value FROM settings')) {
    try {
      const v = JSON.parse(r.value);
      out[r.key] = typeof v === 'object' && v && !Array.isArray(v) ? { ...(out[r.key] || {}), ...v } : v;
    } catch { /* ignore */ }
  }
  return out;
}
export function setSetting(key, value) {
  run('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', key, JSON.stringify(value));
}

// Numérotation séquentielle par type et par année (ex : F2026-0001)
export function nextNumber(kind, date = today()) {
  const prefix = getSettings().numbering[kind] || kind.toUpperCase();
  const year = String(date).slice(0, 4);
  const key = `seq_${kind}_${year}`;
  const cur = get('SELECT value FROM settings WHERE key=?', key);
  const n = (cur ? Number(JSON.parse(cur.value)) : 0) + 1;
  setSetting(key, n);
  return `${prefix}${year}-${String(n).padStart(4, '0')}`;
}

// ---------- Données initiales comptables ----------
// Plan comptable simplifié inspiré du PCN luxembourgeois — à faire valider par votre fiduciaire.
const ACCOUNTS = [
  ['1011', 'Capital souscrit', 'equity', 0],
  ['1411', 'Résultats reportés', 'equity', 0],
  ['2231', 'Installations et outillage', 'asset', 0],
  ['2241', 'Matériel de transport', 'asset', 0],
  ['3611', 'Stock de marchandises (pièces)', 'asset', 0],
  ['4011', 'Clients', 'asset', 1],
  ['4211', 'Personnel - avances', 'asset', 0],
  ['421611', 'TVA en amont (déductible)', 'asset', 0],
  ['4411', 'Fournisseurs', 'liability', 1],
  ['4621', 'Rémunérations dues au personnel', 'liability', 0],
  ['4631', 'Dettes envers la sécurité sociale (CCSS)', 'liability', 0],
  ['461411', 'TVA en aval (collectée)', 'liability', 0],
  ['461418', 'TVA à payer / décompte', 'liability', 0],
  ['5131', 'Banque - compte courant', 'asset', 0],
  ['5161', 'Caisse', 'asset', 0],
  ['5171', 'Virements internes / terminal carte', 'asset', 1],
  ['6070', 'Achats de marchandises (pièces)', 'expense', 0],
  ['6037', 'Variation des stocks de marchandises', 'expense', 0],
  ['6061', 'Électricité, eau, chauffage', 'expense', 0],
  ['6063', 'Petit outillage et fournitures', 'expense', 0],
  ['6111', 'Loyers', 'expense', 0],
  ['6131', 'Honoraires (fiduciaire, avocat)', 'expense', 0],
  ['6141', 'Assurances', 'expense', 0],
  ['6151', 'Entretien et réparations', 'expense', 0],
  ['6161', 'Publicité et marketing', 'expense', 0],
  ['6165', 'Frais de télécommunication et logiciels', 'expense', 0],
  ['6171', 'Carburant et frais de déplacement', 'expense', 0],
  ['6181', 'Frais bancaires', 'expense', 0],
  ['6211', 'Salaires', 'expense', 0],
  ['6231', 'Charges sociales patronales', 'expense', 0],
  ['6400', 'Impôts et taxes', 'expense', 0],
  ['6580', 'Autres charges', 'expense', 0],
  ['7030', "Prestations de services (main-d'œuvre)", 'income', 0],
  ['7040', 'Ventes de marchandises (pièces)', 'income', 0],
  ['7080', 'Autres produits (forfaits, locations)', 'income', 0],
  ['7580', 'Autres produits divers', 'income', 0],
];
const JOURNALS = [
  ['VTE', 'Ventes', 'sale'], ['ACH', 'Achats', 'purchase'], ['BNK', 'Banque', 'bank'],
  ['CAI', 'Caisse', 'cash'], ['OD', 'Opérations diverses', 'general'],
];
for (const a of ACCOUNTS) run('INSERT OR IGNORE INTO accounts(code,name,type,reconcilable) VALUES(?,?,?,?)', ...a);
for (const j of JOURNALS) run('INSERT OR IGNORE INTO journals(code,name,type) VALUES(?,?,?)', ...j);
