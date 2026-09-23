// Import Odoo contre un faux serveur JSON-RPC reproduisant la structure d'Odoo (données fictives).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DATA = {
  'res.partner': [
    { id: 10, name: 'Jean Test', is_company: false, email: 'jean@test.lu', phone: '621000000', street: 'Rue A 1', street2: false, zip: 'L-4000', city: 'Esch', country_id: [133, 'Luxembourg'], vat: false, customer_rank: 3, supplier_rank: 0 },
    { id: 11, name: 'Pièces Test SA', is_company: true, email: false, phone: false, street: 'Zone B', street2: false, zip: 'L-3000', city: 'Bettembourg', country_id: [133, 'Luxembourg'], vat: 'LU11111111', customer_rank: 0, supplier_rank: 5 },
    { id: 12, name: 'Garage Partenaire', is_company: true, email: false, phone: false, street: false, street2: false, zip: false, city: false, country_id: false, vat: false, customer_rank: 0, supplier_rank: 2 },
  ],
  'fleet.vehicle': [
    { id: 100, license_plate: 'ab 123', vin_sn: 'wvwzzzauzjw000001', model_id: [1, 'Volkswagen/Golf'], brand_id: [1, 'Volkswagen'], driver_id: [10, 'Jean Test'], odometer: 120000.4, model_year: '2018', fuel_type: 'diesel', acquisition_date: '2018-03-01', color: false, gap_next_ct_date: '2026-10-15', gap_next_service_date: false, x_studio_version: '2.0 TDI', x_studio_dimension_pneus_avant_3: '205/55 R16' },
    { id: 101, license_plate: '0000', vin_sn: false, model_id: [2, 'Mercedes/109'], brand_id: [2, 'Mercedes'], driver_id: [12, 'Garage Partenaire'], odometer: 0, model_year: false, fuel_type: false, acquisition_date: false, color: false, gap_next_ct_date: false, gap_next_service_date: false, x_studio_version: false, x_studio_dimension_pneus_avant_3: false },
  ],
  'product.product': [
    { id: 500, default_code: '0 092 S40 050', barcode: false, name: 'Batterie de démarrage', list_price: 134.5, standard_price: 80.14, qty_available: 3, categ_id: [16, '320000 Electrique'], type: 'consu', is_storable: true, uom_id: [1, 'Units'], taxes_id: [258], seller_ids: [900], active: true },
    { id: 501, default_code: 'MO', barcode: false, name: "Main d'oeuvre", list_price: 85, standard_price: 0, qty_available: 0, categ_id: [1, 'Services'], type: 'service', is_storable: false, uom_id: [2, 'Hours'], taxes_id: [258], seller_ids: [], active: true },
  ],
};
let calls = 0;
const odoo = http.createServer((req, res) => {
  let b = '';
  req.on('data', (c) => (b += c));
  req.on('end', () => {
    calls++;
    const { params } = JSON.parse(b);
    const reply = (result) => res.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result }));
    if (params.service === 'common') return reply(params.args[2] === 'good-key' ? 7 : false);
    const [, , , model, method, args, kw] = params.args;
    if (method === 'fields_get') return reply(Object.fromEntries(Object.keys(DATA[model]?.[0] || {}).map((k) => [k, {}])));
    if (method === 'search_count') return reply(model === 'ir.model' ? 1 : (DATA[model] || []).length);
    if (model === 'account.tax') return reply([{ id: 258, amount: 17 }]);
    if (model === 'product.supplierinfo') return reply([{ id: 900, partner_id: [11, 'Pièces Test SA'] }]);
    if (method === 'search_read') {
      let rows = DATA[model] || [];
      const dom = args[0];
      if (dom.some((d) => d[0] === 'driver_id')) rows = rows.filter((r) => r.driver_id);
      rows = rows.slice(kw.offset, kw.offset + kw.limit);
      return reply(rows.map((r) => Object.fromEntries(['id', ...kw.fields].map((f) => [f, r[f]]))));
    }
    reply(false);
  });
});

const PORT = 3800 + Math.floor(Math.random() * 90);
const BASE = `http://localhost:${PORT}/api`;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'garage-odoo-'));
let server, token;
const call = async (method, url, body) => {
  const r = await fetch(BASE + url, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body && JSON.stringify(body) });
  const d = await r.json();
  if (!r.ok) throw new Error(d.error);
  return d;
};

before(async () => {
  await new Promise((r) => odoo.listen(0, r));
  server = spawn(process.execPath, ['server.js'], { env: { ...process.env, PORT: String(PORT), DATA_DIR: dataDir, ANTHROPIC_API_KEY: '' }, stdio: 'pipe' });
  for (let i = 0; i < 50; i++) { try { await fetch(`${BASE}/auth/status`); break; } catch { await new Promise((r) => setTimeout(r, 100)); } }
  ({ token } = await call('POST', '/auth/setup', { name: 'Admin', email: 'a@t.lu', password: 'secret123' }));
});
after(() => { server.kill(); odoo.close(); fs.rmSync(dataDir, { recursive: true, force: true }); });

async function importAndWait() {
  await call('POST', '/odoo/import', { options: { customers: true, suppliers: true, vehicles: true, products: true } });
  for (let i = 0; i < 100; i++) {
    const { job } = await call('GET', '/odoo');
    if (!job.running) return job;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('import trop long');
}

test('import Odoo : clients, fournisseurs, véhicules, articles, sans doublons', async () => {
  const url = `http://localhost:${odoo.address().port}`;
  await call('PUT', '/odoo', { url, db: 'test', login: 'a@t.lu', api_key: 'bad-key' });
  await assert.rejects(call('POST', '/odoo/test'), /refusée/);
  await call('PUT', '/odoo', { api_key: 'good-key' });
  const t = await call('POST', '/odoo/test');
  assert.equal(t.vehicles, 2);
  const settings = await call('GET', '/settings');
  assert.equal(settings.odoo, undefined); // la clé API n'est jamais renvoyée

  const job = await importAndWait();
  assert.equal(job.error, null);
  assert.deepEqual(job.done.customers, { created: 2, updated: 0 }); // Jean + le propriétaire du 2e véhicule
  assert.deepEqual(job.done.suppliers, { created: 2, updated: 0 });

  const vehicles = await call('GET', '/vehicles');
  const golf = vehicles.find((v) => v.vin === 'WVWZZZAUZJW000001');
  assert.equal(golf.plate, 'AB 123');
  assert.equal(golf.model, 'Golf');
  assert.equal(golf.fuel, 'Diesel');
  assert.equal(golf.next_inspection, '2026-10-15');
  assert.equal(golf.tyre_size, '205/55 R16');
  assert.equal(golf.customer_name, 'Jean Test');
  assert.equal(vehicles.find((v) => v.make === 'Mercedes').plate, null); // plaque « 0000 » ignorée

  const products = await call('GET', '/products');
  const bat = products.find((p) => p.ref === '0 092 S40 050');
  assert.equal(bat.qty_on_hand, 3);
  assert.equal(bat.supplier_name, 'Pièces Test SA');
  assert.equal(products.find((p) => p.ref === 'MO').is_service, 1);

  // Deuxième import : mise à jour, pas de doublons, stock réaligné
  DATA['product.product'][0].qty_available = 5;
  const job2 = await importAndWait();
  assert.deepEqual(job2.done.vehicles, { created: 0, updated: 2 });
  assert.equal((await call('GET', '/vehicles')).length, 2);
  assert.equal((await call('GET', '/products')).find((p) => p.ref === '0 092 S40 050').qty_on_hand, 5);
});
