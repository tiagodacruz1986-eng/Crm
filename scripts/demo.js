// Remplit la base avec des données de démonstration : npm run demo
// (à utiliser sur une base vide, pour découvrir le logiciel)
process.env.TZ ||= 'Europe/Luxembourg';
const { get, insert, run, today, localDate, setSetting, getSettings } = await import('../src/db.js');
const { hashSecret } = await import('../src/auth.js');
const B = await import('../src/business.js');

if (get('SELECT COUNT(*) n FROM customers').n > 0) {
  console.log('La base contient déjà des clients : démo annulée.');
  process.exit(0);
}
const d = (n) => { const x = new Date(); x.setDate(x.getDate() + n); return localDate(x); };
const dt = (n, h) => `${d(n)}T${String(h).padStart(2, '0')}:00`;

if (!get("SELECT id FROM users WHERE role='admin'")) {
  insert('users', { name: 'Gérant Démo', email: 'demo@garage.lu', role: 'admin', password_hash: hashSecret('demo1234') }, ['name', 'email', 'role', 'password_hash']);
  console.log('Compte admin : demo@garage.lu / demo1234');
}
setSetting('company', { ...getSettings().company, name: getSettings().company.name === 'Mon Garage' ? 'Garage Démo' : getSettings().company.name, address: '12, rue de la Gare', zip: 'L-4040', city: 'Esch-sur-Alzette', phone: '+352 55 12 34', email: 'info@garage.lu', vat_number: 'LU12345678', rcs: 'B123456', iban: 'LU28 0019 4006 4475 0000', bic: 'BCEELULL', bank_name: 'Spuerkeess' });

const mech = [['Paulo', '#ef4444', '1111'], ['Kevin', '#22c55e', '2222'], ['Sven', '#a855f7', '3333']].map(([name, color, pin]) =>
  insert('users', { name, role: 'mechanic', color, pin_hash: hashSecret(pin), hourly_cost: 32 }, ['name', 'role', 'color', 'pin_hash', 'hourly_cost']));

const sup = [
  insert('suppliers', { name: 'Autodistribution Luxembourg', iban: 'LU120010001234567891', default_account: '6070' }, ['name', 'iban', 'default_account']),
  insert('suppliers', { name: 'Pneus Center SA', default_account: '6070' }, ['name', 'default_account']),
  insert('suppliers', { name: 'Enovos', default_account: '6061' }, ['name', 'default_account']),
];
const P = (ref, name, pp, sp, qty, min, s = 0, brand = '') => {
  const id = insert('products', { ref, name, purchase_price: pp, sale_price: sp, qty_min: min, supplier_id: sup[s], brand, category: '' }, ['ref', 'name', 'purchase_price', 'sale_price', 'qty_min', 'supplier_id', 'brand', 'category']);
  if (qty) B.addStockMove({ product_id: id, qty, kind: 'adjust', unit_cost: pp, note: 'Stock initial' });
  return id;
};
const prod = {
  oil: P('HU7008z', 'Filtre à huile Mann', 6.2, 14.5, 30, 5, 0, 'Mann'),
  air: P('C27009', 'Filtre à air Mann', 9.8, 22, 3, 4, 0, 'Mann'),
  pads: P('P85020', 'Plaquettes de frein AV Brembo', 32, 69, 4, 2, 0, 'Brembo'),
  disc: P('09.9772.11', 'Disque de frein AV Brembo', 38, 82, 1, 2, 0, 'Brembo'),
  oil5w30: P('5W30-1L', 'Huile moteur 5W30 (litre)', 6.5, 16, 150, 20, 0, 'Castrol'),
  wiper: P('A297S', 'Balais essuie-glace Bosch', 18, 39, 6, 3, 0, 'Bosch'),
  tyre: P('PS5-2055516', 'Pneu Michelin Primacy 205/55 R16', 72, 119, 8, 4, 1, 'Michelin'),
};
insert('products', { ref: 'F-VID', name: 'Forfait vidange + filtre', sale_price: 49, is_service: 1, labor_hours: 0.5 }, ['ref', 'name', 'sale_price', 'is_service', 'labor_hours']);
insert('products', { ref: 'F-CLIM', name: 'Forfait recharge climatisation', sale_price: 89, is_service: 1, labor_hours: 0.75 }, ['ref', 'name', 'sale_price', 'is_service', 'labor_hours']);

const C = (name, city, mobile, veh) => {
  const id = insert('customers', { name, city, mobile, email: name.split(' ')[0].toLowerCase() + '@mail.lu', country: 'LU' }, ['name', 'city', 'mobile', 'email', 'country']);
  const v = insert('vehicles', { customer_id: id, ...veh }, ['customer_id', 'plate', 'make', 'model', 'year', 'fuel', 'mileage', 'next_inspection', 'vin']);
  return { id, v };
};
const cs = [
  C('Jean Muller', 'Esch-sur-Alzette', '621 123 456', { plate: 'AB 1234', make: 'Volkswagen', model: 'Golf VII', year: 2018, fuel: 'Diesel', mileage: 124500, next_inspection: d(12), vin: 'WVWZZZAUZJW123456' }),
  C('Maria Da Silva', 'Differdange', '661 987 654', { plate: 'CD 5678', make: 'Peugeot', model: '308', year: 2020, fuel: 'Essence', mileage: 58000, next_inspection: d(25), vin: 'VF3LBHNZ6KS123456' }),
  C('Luc Weber', 'Luxembourg', '691 555 111', { plate: 'LW 2020', make: 'Tesla', model: 'Model 3', year: 2022, fuel: 'Électrique', mileage: 41000, next_inspection: d(200), vin: '5YJ3E7EB0NF123456' }),
  C('Sophie Schmit', 'Dudelange', '621 777 888', { plate: 'SS 42', make: 'BMW', model: 'X1', year: 2019, fuel: 'Diesel', mileage: 87000, next_inspection: d(5), vin: 'WBAJG110X0L123456' }),
  C('Transports Kieffer SARL', 'Bettembourg', '26 51 22 33', { plate: 'TK 3001', make: 'Renault', model: 'Master', year: 2021, fuel: 'Diesel', mileage: 152000, next_inspection: d(60), vin: 'VF1MA000123456789' }),
];
run("UPDATE customers SET type='societe', company='Transports Kieffer SARL', vat_number='LU87654321', payment_terms=30 WHERE id=?", cs[4].id);

const L = (kind, description, quantity, unit_price, product_id = null) => ({ kind, description, quantity, unit_price, tax_rate: 17, product_id });
const labor = getSettings().workshop.labor_rate;

// Factures passées (pour l'historique et la comptabilité)
for (let m = 5; m >= 1; m--) {
  for (const [i, c] of cs.entries()) {
    if ((m + i) % 2) continue;
    const id = B.saveDocument({ type: 'invoice', customer_id: c.id, vehicle_id: c.v, date: d(-m * 30 + i), lines: [L('labor', "Entretien — main-d'œuvre", 1 + (i % 3) * 0.5, labor), L('part', 'Filtre à huile Mann', 1, 14.5, prod.oil), L('part', 'Huile moteur 5W30 (litre)', 5, 16, prod.oil5w30)] });
    B.postInvoice(id);
    const doc = get('SELECT * FROM documents WHERE id=?', id);
    if (m > 1 || i === 0) B.registerPayment({ document_id: id, amount: doc.total, date: d(-m * 30 + i + 5), method: i % 2 ? 'card' : 'bank' });
  }
}
// Achat de pièces comptabilisé
const pur = B.savePurchase({ supplier_id: sup[0], supplier_ref: 'AD-2026-4471', date: d(-10), lines: [{ product_id: prod.pads, description: 'Plaquettes de frein AV Brembo', quantity: 4, unit_price: 32, tax_rate: 17 }, { product_id: prod.air, description: 'Filtre à air Mann', quantity: 6, unit_price: 9.8, tax_rate: 17 }] });
B.receivePurchase(pur); B.postPurchase(pur);
const elec = B.savePurchase({ supplier_id: sup[2], supplier_ref: 'ENO-889231', date: d(-8), lines: [{ description: 'Électricité atelier', quantity: 1, unit_price: 412, tax_rate: 8, account_code: '6061' }] });
B.postPurchase(elec);

// OR en cours dans l'atelier
const q = B.saveDocument({ type: 'quote', customer_id: cs[1].id, vehicle_id: cs[1].v, customer_complaint: 'Bruit au freinage à l’avant', lines: [L('labor', 'Remplacement disques + plaquettes AV', 1.5, labor), L('part', 'Disque de frein AV Brembo', 2, 82, prod.disc), L('part', 'Plaquettes de frein AV Brembo', 1, 69, prod.pads)] });
run("UPDATE documents SET status='sent' WHERE id=?", q);
const o1 = B.saveDocument({ type: 'order', customer_id: cs[0].id, vehicle_id: cs[0].v, mechanic_id: mech[0], mileage: 125300, promised_at: dt(0, 17), customer_complaint: 'Entretien annuel + contrôle avant CT', lines: [L('labor', 'Vidange + contrôle 30 points', 1, labor), L('part', 'Filtre à huile Mann', 1, 14.5, prod.oil), L('part', 'Huile moteur 5W30 (litre)', 5, 16, prod.oil5w30), L('part', 'Filtre à air Mann', 1, 22, prod.air)] });
const o2 = B.saveDocument({ type: 'order', customer_id: cs[3].id, vehicle_id: cs[3].v, mechanic_id: mech[1], promised_at: dt(1, 12), customer_complaint: 'Voyant moteur allumé, perte de puissance', lines: [L('labor', 'Diagnostic électronique', 1, labor)] });
run("UPDATE documents SET status='waiting_parts', diagnosis='Code P0299 — sous-pression turbo, durite fissurée' WHERE id=?", o2);
const o3 = B.saveDocument({ type: 'order', customer_id: cs[4].id, vehicle_id: cs[4].v, mechanic_id: mech[2], customer_complaint: 'Remplacement 4 pneus + géométrie', lines: [L('labor', 'Montage / équilibrage 4 pneus', 1, labor), L('part', 'Pneu Michelin Primacy 205/55 R16', 4, 119, prod.tyre)] });
run("UPDATE documents SET status='done' WHERE id=?", o3);
B.saveDocument({ type: 'order', customer_id: cs[2].id, vehicle_id: cs[2].v, customer_complaint: 'Remplacement balais essuie-glace + contrôle freins', lines: [L('part', 'Balais essuie-glace Bosch', 1, 39, prod.wiper), L('labor', 'Contrôle freinage', 0.5, labor)] });

// Pointages du jour
const t0 = (h, m = 0) => `${today()}T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00`;
for (const [i, u] of mech.entries()) insert('time_entries', { user_id: u, kind: 'presence', start: t0(7, 30 + i * 5) }, ['user_id', 'kind', 'start']);
insert('time_entries', { user_id: mech[0], kind: 'work', document_id: o1, start: t0(8) }, ['user_id', 'kind', 'document_id', 'start']);
run("UPDATE documents SET status='in_progress' WHERE id=?", o1);
insert('time_entries', { user_id: mech[2], kind: 'work', document_id: o3, start: t0(7, 45), end: t0(9, 10) }, ['user_id', 'kind', 'document_id', 'start', 'end']);

// Rendez-vous
const A = (n, h, c, title, m) => insert('appointments', { customer_id: c.id, vehicle_id: c.v, mechanic_id: m, start: dt(n, h), end: dt(n, h + 1), title }, ['customer_id', 'vehicle_id', 'mechanic_id', 'start', 'end', 'title']);
A(0, 14, cs[1], 'Freins avant (devis accepté ?)', mech[1]);
A(1, 9, cs[2], 'Contrôle freins + essuie-glaces', mech[0]);
A(2, 10, cs[3], 'Remplacement durite turbo', mech[1]);

// Compte bancaire
insert('bank_accounts', { name: 'Spuerkeess — compte courant', iban: 'LU28 0019 4006 4475 0000', bic: 'BCEELULL', bank_name: 'Spuerkeess', opening_balance: 25000 }, ['name', 'iban', 'bic', 'bank_name', 'opening_balance']);

console.log('✅ Données de démonstration créées.');
console.log('   Kiosque mécaniciens — PIN : Paulo 1111 · Kevin 2222 · Sven 3333');
