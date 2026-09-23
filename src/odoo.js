// Import des données depuis Odoo (clients, fournisseurs, véhicules, articles) via l'API JSON-RPC.
// L'import est rejouable : chaque enregistrement garde son identifiant Odoo et est mis à jour au lieu d'être dupliqué.
import { db, all, get, insert, update, getSettings, setSetting, round2 } from './db.js';
import { addStockMove, BusinessError } from './business.js';

// Colonnes de correspondance avec Odoo (ajoutées aux bases existantes si besoin)
for (const table of ['customers', 'suppliers', 'vehicles', 'products']) {
  const cols = all(`PRAGMA table_info(${table})`).map((c) => c.name);
  if (!cols.includes('odoo_id')) db.exec(`ALTER TABLE ${table} ADD COLUMN odoo_id INTEGER`);
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_${table}_odoo ON ${table}(odoo_id) WHERE odoo_id IS NOT NULL`);
}

export function odooConfig() {
  return getSettings().odoo || {};
}
export function publicOdooConfig() {
  const { api_key, ...rest } = odooConfig();
  return { ...rest, has_key: Boolean(api_key) };
}
export function saveOdooConfig(cfg) {
  const cur = odooConfig();
  setSetting('odoo', {
    url: (cfg.url ?? cur.url ?? '').trim().replace(/\/+$/, ''),
    db: (cfg.db ?? cur.db ?? '').trim(),
    login: (cfg.login ?? cur.login ?? '').trim(),
    api_key: cfg.api_key ? cfg.api_key.trim() : cur.api_key,
  });
}

class Odoo {
  constructor({ url, db: database, login, api_key }) {
    if (!url || !database || !login || !api_key) throw new BusinessError('Renseignez l\'adresse Odoo, la base, l\'identifiant et la clé API.');
    Object.assign(this, { url, database, user: login, key: api_key });
  }
  async rpc(service, method, args) {
    let res;
    try {
      res = await fetch(`${this.url}/jsonrpc`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', method: 'call', params: { service, method, args }, id: Date.now() }),
        signal: AbortSignal.timeout(120_000),
      });
    } catch (e) {
      throw new BusinessError(`Odoo injoignable (${e.cause?.code || e.message}). Vérifiez l'adresse.`);
    }
    if (!res.ok) throw new BusinessError(`Odoo a répondu ${res.status}. Vérifiez l'adresse.`);
    const data = await res.json();
    if (data.error) throw new BusinessError(`Odoo : ${data.error.data?.message || data.error.message}`);
    return data.result;
  }
  async login() {
    this.uid = await this.rpc('common', 'authenticate', [this.database, this.user, this.key, {}]);
    if (!this.uid) throw new BusinessError('Connexion Odoo refusée : vérifiez la base, l\'identifiant et la clé API.');
    return this.uid;
  }
  call(model, method, args = [], kwargs = {}) {
    return this.rpc('object', 'execute_kw', [this.database, this.uid, this.key, model, method, args, kwargs]);
  }
  async fields(model) {
    return Object.keys(await this.call(model, 'fields_get', [], { attributes: ['type'] }));
  }
  // Lecture par pages, en ne demandant que les champs qui existent sur cette installation
  async *readAll(model, domain, wanted, pageSize = 500) {
    const available = new Set(await this.fields(model));
    const fields = wanted.filter((f) => available.has(f));
    for (let offset = 0; ; offset += pageSize) {
      const page = await this.call(model, 'search_read', [domain], { fields, limit: pageSize, offset, order: 'id', context: { active_test: true } });
      if (!page.length) return;
      yield page;
      if (page.length < pageSize) return;
    }
  }
}

export async function testConnection(cfg = odooConfig()) {
  const o = new Odoo(cfg);
  await o.login();
  const [partners, vehicles, products] = await Promise.all([
    o.call('res.partner', 'search_count', [[['parent_id', '=', false]]]),
    o.call('fleet.vehicle', 'search_count', [[]]).catch(() => 0),
    o.call('product.product', 'search_count', [[]]),
  ]);
  return { partners, vehicles, products };
}

// ---------- Correspondances ----------
const val = (v) => (v === false || v === '' ? null : v);
const m2oName = (v) => (Array.isArray(v) ? v[1] : null);
const m2oId = (v) => (Array.isArray(v) ? v[0] : null);
const FUEL = {
  diesel: 'Diesel', gasoline: 'Essence', petrol: 'Essence', hybrid: 'Hybride', full_hybrid: 'Hybride',
  plug_in_hybrid_diesel: 'Hybride rechargeable', plug_in_hybrid_gasoline: 'Hybride rechargeable',
  electric: 'Électrique', lpg: 'GPL', cng: 'GNV', hydrogen: 'Hydrogène',
};
const PLACEHOLDER_PLATES = new Set(['0', '00', '000', '0000', '-', 'X', 'XX']);

function partnerRow(p) {
  const address = [val(p.street), val(p.street2)].filter(Boolean).join(', ') || null;
  return {
    name: p.name?.trim() || 'Sans nom', email: val(p.email), phone: val(p.phone), mobile: val(p.mobile),
    address, zip: val(p.zip), city: val(p.city), vat_number: val(p.vat),
    country: p.country_id ? (m2oName(p.country_id) === 'Luxembourg' ? 'LU' : m2oName(p.country_id)) : 'LU',
  };
}
function upsert(table, odooId, data, columns) {
  const cur = get(`SELECT id FROM ${table} WHERE odoo_id=?`, odooId);
  if (cur) { update(table, cur.id, data, columns); return { id: cur.id, created: false }; }
  return { id: insert(table, { ...data, odoo_id: odooId }, [...columns, 'odoo_id']), created: true };
}

// ---------- Import ----------
export const job = { running: false, step: '', done: {}, error: null, finished_at: null };

export async function runImport(options = { customers: true, suppliers: true, vehicles: true, products: true }) {
  if (job.running) throw new BusinessError('Un import est déjà en cours');
  Object.assign(job, { running: true, step: 'Connexion à Odoo…', done: {}, error: null, finished_at: null });
  const count = (k, created) => { job.done[k] ||= { created: 0, updated: 0 }; job.done[k][created ? 'created' : 'updated']++; };
  try {
    const o = new Odoo(odooConfig());
    await o.login();
    const PFIELDS = ['name', 'is_company', 'email', 'phone', 'mobile', 'street', 'street2', 'zip', 'city', 'country_id', 'vat', 'customer_rank', 'supplier_rank', 'comment'];

    // Propriétaires de véhicules : toujours importés comme clients
    let drivers = new Set();
    if (options.vehicles || options.customers) {
      const has = await o.call('ir.model', 'search_count', [[['model', '=', 'fleet.vehicle']]]);
      if (has) {
        job.step = 'Lecture des propriétaires de véhicules…';
        for await (const page of o.readAll('fleet.vehicle', [['driver_id', '!=', false]], ['driver_id'], 2000)) page.forEach((v) => drivers.add(m2oId(v.driver_id)));
      }
    }

    if (options.customers || options.suppliers || options.vehicles) {
      job.step = 'Import des contacts…';
      for await (const page of o.readAll('res.partner', [['parent_id', '=', false]], PFIELDS)) {
        db.exec('BEGIN');
        try {
          for (const p of page) {
            const row = partnerRow(p);
            const isSupplier = p.supplier_rank > 0;
            const isCustomer = p.customer_rank > 0 || drivers.has(p.id) || !isSupplier;
            if (options.suppliers && isSupplier) {
              const r = upsert('suppliers', p.id, { ...row, notes: val(p.comment)?.replace(/<[^>]+>/g, ' ') }, ['name', 'vat_number', 'email', 'phone', 'address', 'zip', 'city', 'country', 'notes']);
              count('suppliers', r.created);
            }
            if ((options.customers || (options.vehicles && drivers.has(p.id))) && isCustomer) {
              const r = upsert('customers', p.id, { ...row, type: p.is_company ? 'societe' : 'particulier', company: p.is_company ? row.name : null },
                ['type', 'name', 'company', 'vat_number', 'email', 'phone', 'mobile', 'address', 'zip', 'city', 'country']);
              count('customers', r.created);
            }
          }
          db.exec('COMMIT');
        } catch (e) { db.exec('ROLLBACK'); throw e; }
      }
    }

    if (options.vehicles) {
      const has = await o.call('ir.model', 'search_count', [[['model', '=', 'fleet.vehicle']]]);
      if (has) {
        job.step = 'Import des véhicules…';
        const VFIELDS = ['license_plate', 'vin_sn', 'model_id', 'brand_id', 'driver_id', 'odometer', 'model_year', 'fuel_type', 'acquisition_date', 'color',
          'gap_next_ct_date', 'x_studio_fin_du_contrle_technique', 'gap_next_service_date', 'x_studio_version', 'x_studio_dimension_pneus_avant_3', 'x_studio_dimension_pneus_avant_4', 'x_studio_type_de_carburant'];
        for await (const page of o.readAll('fleet.vehicle', [], VFIELDS)) {
          db.exec('BEGIN');
          try {
            for (const v of page) {
              const plate = val(v.license_plate)?.toUpperCase().trim();
              const brand = m2oName(v.brand_id);
              let model = m2oName(v.model_id) || '';
              const parts = model.split('/').map((s) => s.trim()).filter(Boolean);
              if (parts.length > 1 && brand && parts[0].toLowerCase() === brand.toLowerCase()) parts.shift();
              model = parts.join(' ') || null;
              const customer = v.driver_id ? get('SELECT id FROM customers WHERE odoo_id=?', m2oId(v.driver_id)) : null;
              const row = {
                customer_id: customer?.id ?? null,
                plate: plate && !PLACEHOLDER_PLATES.has(plate) ? plate : null,
                vin: val(v.vin_sn)?.toUpperCase().trim() || null,
                make: brand, model, version: val(v.x_studio_version),
                fuel: FUEL[v.fuel_type] || val(v.x_studio_type_de_carburant) || null,
                year: v.model_year ? Number(v.model_year) || null : null,
                first_registration: val(v.acquisition_date),
                mileage: v.odometer ? Math.round(v.odometer) : null,
                color: val(v.color),
                tyre_size: val(v.x_studio_dimension_pneus_avant_3) || val(v.x_studio_dimension_pneus_avant_4),
                next_inspection: val(v.gap_next_ct_date) || val(v.x_studio_fin_du_contrle_technique),
                next_service_date: val(v.gap_next_service_date),
              };
              const r = upsert('vehicles', v.id, row, Object.keys(row));
              count('vehicles', r.created);
            }
            db.exec('COMMIT');
          } catch (e) { db.exec('ROLLBACK'); throw e; }
        }
      }
    }

    if (options.products) {
      job.step = 'Import des articles et du stock…';
      const taxes = Object.fromEntries((await o.call('account.tax', 'search_read', [[['type_tax_use', '=', 'sale']]], { fields: ['amount'] })).map((t) => [t.id, t.amount]));
      const PRFIELDS = ['default_code', 'barcode', 'name', 'list_price', 'standard_price', 'qty_available', 'categ_id', 'type', 'is_storable', 'uom_id', 'taxes_id', 'seller_ids', 'active'];
      for await (const page of o.readAll('product.product', [], PRFIELDS)) {
        // Fournisseur principal de chaque article
        const sellerIds = page.flatMap((p) => (p.seller_ids || []).slice(0, 1));
        const sellers = sellerIds.length
          ? Object.fromEntries((await o.call('product.supplierinfo', 'read', [sellerIds], { fields: ['partner_id'] })).map((s) => [s.id, m2oId(s.partner_id)]))
          : {};
        db.exec('BEGIN');
        try {
          for (const p of page) {
            const supplierOdoo = p.seller_ids?.length ? sellers[p.seller_ids[0]] : null;
            const supplier = supplierOdoo ? get('SELECT id FROM suppliers WHERE odoo_id=?', supplierOdoo) : null;
            const isService = p.type === 'service' || (p.is_storable === false && p.type !== 'product');
            const taxRate = (p.taxes_id || []).map((id) => taxes[id]).find((x) => x !== undefined);
            const row = {
              ref: val(p.default_code), ean: val(p.barcode), name: p.name, category: m2oName(p.categ_id),
              purchase_price: round2(p.standard_price), sale_price: round2(p.list_price), tax_rate: taxRate ?? 17,
              unit: m2oName(p.uom_id) === 'Units' ? 'pce' : m2oName(p.uom_id) || 'pce', is_service: isService ? 1 : 0,
              supplier_id: supplier?.id ?? null, active: p.active === false ? 0 : 1,
            };
            const r = upsert('products', p.id, row, Object.keys(row));
            // Stock : on aligne la quantité sur celle d'Odoo via un mouvement d'inventaire
            if (!isService && p.qty_available !== undefined) {
              const cur = get('SELECT qty_on_hand FROM products WHERE id=?', r.id).qty_on_hand;
              const diff = round2((p.qty_available || 0) - cur);
              if (diff) addStockMove({ product_id: r.id, qty: diff, kind: 'adjust', unit_cost: row.purchase_price, note: 'Import Odoo' });
            }
            count('products', r.created);
          }
          db.exec('COMMIT');
        } catch (e) { db.exec('ROLLBACK'); throw e; }
      }
    }
    job.step = 'Terminé';
    setSetting('odoo_last_import', { at: new Date().toISOString(), done: job.done });
  } catch (e) {
    job.error = e.message;
    job.step = 'Erreur';
    if (!(e instanceof BusinessError)) console.error('Import Odoo', e);
  } finally {
    job.running = false;
    job.finished_at = new Date().toISOString();
  }
  return job;
}

