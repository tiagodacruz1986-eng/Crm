import { ref, reactive, onMounted } from 'vue';
import { GET, POST, PUT, DEL, act, toast, money, date, DOC_TYPES_SHORT } from '../api.js';
import { route, go } from '../router.js';

const CUSTOMER_FIELDS = ['type', 'name', 'company', 'vat_number', 'email', 'phone', 'mobile', 'address', 'zip', 'city', 'country', 'payment_terms', 'notes', 'marketing_ok'];

// Constructeurs courants (WMI = 3 premiers caractères du VIN) pour un décodage hors-ligne
const WMI = {
  WVW: 'Volkswagen', WV1: 'Volkswagen VU', WV2: 'Volkswagen VU', WAU: 'Audi', WBA: 'BMW', WBS: 'BMW M', WBY: 'BMW i', WDD: 'Mercedes-Benz', WDB: 'Mercedes-Benz', W1K: 'Mercedes-Benz', W1N: 'Mercedes-Benz', WDC: 'Mercedes-Benz',
  VF1: 'Renault', VF3: 'Peugeot', VF7: 'Citroën', VR3: 'Peugeot', VR7: 'Citroën', VR1: 'DS', VF6: 'Renault Trucks', UU1: 'Dacia', VSS: 'Seat', VSK: 'Nissan', TMB: 'Škoda',
  ZFA: 'Fiat', ZAR: 'Alfa Romeo', ZFF: 'Ferrari', W0L: 'Opel', W0V: 'Opel', WF0: 'Ford', WMA: 'MAN', WP0: 'Porsche', WP1: 'Porsche', YV1: 'Volvo', YV4: 'Volvo', YS3: 'Saab',
  SAJ: 'Jaguar', SAL: 'Land Rover', SCC: 'Lotus', JTD: 'Toyota', JTE: 'Toyota', JT1: 'Toyota', SB1: 'Toyota', JHM: 'Honda', JN1: 'Nissan', SJN: 'Nissan', JMZ: 'Mazda', JMB: 'Mitsubishi',
  KMH: 'Hyundai', TMA: 'Hyundai', KNA: 'Kia', U5Y: 'Kia', LRW: 'Tesla', '5YJ': 'Tesla', XP7: 'Tesla', WMW: 'Mini', VNK: 'Toyota', NMT: 'Toyota', TSM: 'Suzuki', JSA: 'Suzuki', LVS: 'Ford (Chine)', LSJ: 'MG',
};
const YEAR_CODES = 'ABCDEFGHJKLMNPRSTVWXY123456789';
export async function decodeVin(vin) {
  vin = (vin || '').toUpperCase().trim();
  if (vin.length !== 17) throw new Error('Le VIN doit comporter 17 caractères');
  const out = { make: WMI[vin.slice(0, 3)] || null };
  const yc = YEAR_CODES.indexOf(vin[9]);
  if (yc >= 0) { let y = 2010 + yc; if (y > new Date().getFullYear() + 1) y -= 30; out.year = y; }
  try {
    const r = await fetch(`https://vpic.nhtsa.dot.gov/api/vehicles/DecodeVinValues/${vin}?format=json`, { signal: AbortSignal.timeout(6000) });
    const d = (await r.json()).Results?.[0] || {};
    if (d.Make) out.make = d.Make.charAt(0) + d.Make.slice(1).toLowerCase();
    if (d.Model) out.model = d.Model;
    if (d.ModelYear) out.year = Number(d.ModelYear);
    if (d.FuelTypePrimary) out.fuel = d.FuelTypePrimary;
    if (d.DisplacementL) out.engine_code = `${Number(d.DisplacementL).toFixed(1)} L`;
  } catch { /* hors-ligne : décodage local uniquement */ }
  return out;
}

export const CustomerList = {
  setup() {
    const rows = ref([]);
    const q = ref('');
    const creating = ref(false);
    const load = async () => { rows.value = await GET('/customers?q=' + encodeURIComponent(q.value)); };
    onMounted(load);
    return { rows, q, load, go, money, creating };
  },
  components: { },
  template: `
  <div>
    <div class="page-head"><h1>Clients</h1><div class="btns"><ModuleTools module="clients"/><button class="btn primary" @click="go('/customer/new')">+ Nouveau client</button></div></div>
    <div class="card">
      <div class="toolbar"><input v-model="q" @input="load" placeholder="Nom, téléphone, e-mail…"><span class="muted" style="margin-left:auto">{{ rows.length }} clients</span></div>
      <div class="table-wrap"><table>
        <thead><tr><th>Nom</th><th>Contact</th><th>Localité</th><th class="num">Véhicules</th><th class="num">Solde dû</th></tr></thead>
        <tbody><tr v-for="c in rows" class="click" @click="go('/customer/' + c.id)">
          <td><b>{{ c.name }}</b> <span class="muted" v-if="c.company">— {{ c.company }}</span></td>
          <td>{{ c.mobile || c.phone }} <span class="muted small">{{ c.email }}</span></td>
          <td>{{ c.zip }} {{ c.city }}</td><td class="num">{{ c.vehicle_count }}</td>
          <td class="num" :class="{neg: c.balance > 0}">{{ c.balance ? money(c.balance) : '' }}</td>
        </tr></tbody>
      </table></div>
      <Empty v-if="!rows.length" icon="👥" text="Aucun client"/>
    </div>
  </div>`,
};

export const CustomerDetail = {
  setup() {
    const isNew = route.params.id === 'new';
    const c = ref(null);
    const vehicle = ref(null);
    const load = async () => {
      c.value = isNew ? { type: 'particulier', country: 'LU', marketing_ok: 1, vehicles: [], documents: [] } : await GET('/customers/' + route.params.id);
    };
    onMounted(load);
    const save = async () => {
      const data = Object.fromEntries(CUSTOMER_FIELDS.map((k) => [k, c.value[k]]));
      if (isNew) { const r = await act(() => POST('/customers', data), 'Client créé'); go('/customer/' + r.id); }
      else { await act(() => PUT('/customers/' + c.value.id, data), 'Enregistré'); }
    };
    const remove = async () => { if (!confirm('Supprimer ce client ?')) return; await act(() => DEL('/customers/' + c.value.id), 'Supprimé'); go('/customers'); };
    const newVehicle = () => { vehicle.value = { customer_id: c.value.id, plate: '', make: '', model: '', vin: '' }; };
    const saveVehicle = async () => {
      const v = vehicle.value;
      if (v.id) await act(() => PUT('/vehicles/' + v.id, v), 'Véhicule enregistré');
      else await act(() => POST('/vehicles', v), 'Véhicule ajouté');
      vehicle.value = null; load();
    };
    const vin = async () => { try { Object.assign(vehicle.value, await decodeVin(vehicle.value.vin)); toast('VIN décodé'); } catch (e) { toast(e.message, 'error'); } };
    const balance = () => (c.value?.documents || []).filter((d) => d.type === 'invoice' && ['posted', 'partial'].includes(d.status)).reduce((s, d) => s + d.total - d.amount_paid, 0);
    const revenue = () => (c.value?.documents || []).filter((d) => d.type === 'invoice' && d.status !== 'draft').reduce((s, d) => s + d.total, 0);
    return { c, isNew, save, remove, vehicle, newVehicle, saveVehicle, vin, money, date, go, DOC_TYPES_SHORT, balance, revenue };
  },
  template: `
  <div v-if="c">
    <div class="page-head">
      <h1>{{ isNew ? 'Nouveau client' : c.name }}</h1>
      <div class="btns" v-if="!isNew">
        <a class="btn" :href="'#/new/quote?customer_id=' + c.id">+ Devis</a>
        <a class="btn primary" :href="'#/new/order?customer_id=' + c.id">+ OR</a>
        <a class="btn" :href="'#/new/invoice?customer_id=' + c.id">+ Facture</a>
        <button class="btn danger" @click="remove">🗑</button>
      </div>
    </div>
    <div class="grid g4" v-if="!isNew" style="margin-bottom:16px">
      <div class="kpi"><div class="l">CA total TTC</div><div class="v">{{ money(revenue()) }}</div></div>
      <div class="kpi" :class="{alert: balance() > 0}"><div class="l">Solde dû</div><div class="v">{{ money(balance()) }}</div></div>
      <div class="kpi"><div class="l">Véhicules</div><div class="v">{{ c.vehicles.length }}</div></div>
      <div class="kpi"><div class="l">Client depuis</div><div class="v" style="font-size:18px">{{ date(c.created_at?.slice(0,10)) }}</div></div>
    </div>
    <div class="grid g2">
      <div class="card">
        <h2>Coordonnées</h2>
        <div class="form-grid">
          <label>Type<select v-model="c.type"><option value="particulier">Particulier</option><option value="societe">Société</option></select></label>
          <label>Nom *<input v-model="c.name"></label>
          <label>Société<input v-model="c.company"></label>
          <label>N° TVA<input v-model="c.vat_number"></label>
          <label>GSM<input v-model="c.mobile"></label>
          <label>Téléphone<input v-model="c.phone"></label>
          <label class="full">E-mail<input v-model="c.email" type="email"></label>
          <label class="full">Adresse<input v-model="c.address"></label>
          <label>Code postal<input v-model="c.zip"></label>
          <label>Localité<input v-model="c.city"></label>
          <label>Pays<input v-model="c.country"></label>
          <label>Délai de paiement (jours)<input v-model.number="c.payment_terms" type="number" placeholder="par défaut"></label>
          <label class="full">Notes<textarea v-model="c.notes"></textarea></label>
          <label class="check full"><input type="checkbox" :checked="!!c.marketing_ok" @change="c.marketing_ok = $event.target.checked ? 1 : 0"> Accepte les rappels et offres (RGPD)</label>
        </div>
        <button class="btn primary" style="margin-top:12px" @click="save" :disabled="!c.name">Enregistrer</button>
      </div>
      <div v-if="!isNew">
        <div class="card">
          <div class="card-head"><h2>🚗 Véhicules</h2><button class="btn sm" @click="newVehicle">+ Ajouter</button></div>
          <div v-for="v in c.vehicles" class="list-item">
            <a :href="'#/vehicle/' + v.id"><span class="plate">{{ v.plate || '—' }}</span> {{ v.make }} {{ v.model }} <span class="muted small">{{ v.year }}</span></a>
            <span class="muted small">{{ v.mileage ? v.mileage.toLocaleString() + ' km' : '' }}</span>
          </div>
          <Empty v-if="!c.vehicles.length" icon="🚗" text="Aucun véhicule"/>
        </div>
        <div class="card">
          <h2>📄 Historique</h2>
          <div v-for="d in c.documents" class="list-item">
            <a :href="'#/document/' + d.id">{{ DOC_TYPES_SHORT[d.type] }} <b>{{ d.number || 'brouillon' }}</b> <span class="muted small">{{ date(d.date) }} {{ d.plate }}</span></a>
            <span><Badge :status="d.status"/> {{ money(d.total) }}</span>
          </div>
          <Empty v-if="!c.documents.length" text="Aucun document"/>
        </div>
      </div>
    </div>
    <Chatter v-if="!isNew" model="customer" :record-id="c.id" style="margin-top:16px"/>
    <Modal v-if="vehicle" title="Véhicule" @close="vehicle = null" wide>
      <div class="form-grid">
        <label>Plaque<input v-model="vehicle.plate"></label>
        <label class="full" style="grid-column: span 2">VIN (n° de châssis)<div style="display:flex;gap:6px"><input v-model="vehicle.vin" maxlength="17"><button class="btn" @click="vin">🔎 Décoder</button></div></label>
        <label>Marque<input v-model="vehicle.make"></label><label>Modèle<input v-model="vehicle.model"></label><label>Version<input v-model="vehicle.version"></label>
        <label>Carburant<select v-model="vehicle.fuel"><option></option><option>Essence</option><option>Diesel</option><option>Hybride</option><option>Hybride rechargeable</option><option>Électrique</option><option>GPL</option></select></label>
        <label>Année<input v-model.number="vehicle.year" type="number"></label>
        <label>1ère immatriculation<input v-model="vehicle.first_registration" type="date"></label>
        <label>Kilométrage<input v-model.number="vehicle.mileage" type="number"></label>
        <label>Moteur<input v-model="vehicle.engine_code"></label>
        <label>Pneus<input v-model="vehicle.tyre_size" placeholder="205/55 R16"></label>
        <label>Prochain contrôle technique<input v-model="vehicle.next_inspection" type="date"></label>
        <label>Prochain entretien<input v-model="vehicle.next_service_date" type="date"></label>
      </div>
      <template #foot><button class="btn" @click="vehicle = null">Annuler</button><button class="btn primary" @click="saveVehicle">Enregistrer</button></template>
    </Modal>
  </div>`,
};

export const VehicleList = {
  setup() {
    const rows = ref([]);
    const q = ref('');
    const load = async () => { rows.value = await GET('/vehicles?q=' + encodeURIComponent(q.value)); };
    onMounted(load);
    return { rows, q, load, go, date, today: new Date().toISOString().slice(0, 10) };
  },
  template: `
  <div>
    <div class="page-head"><h1>Véhicules</h1><div class="btns"><ModuleTools module="vehicules"/></div></div>
    <div class="card">
      <div class="toolbar"><input v-model="q" @input="load" placeholder="Plaque, VIN, marque, client…"><span class="muted" style="margin-left:auto">{{ rows.length }} véhicules</span></div>
      <div class="table-wrap"><table>
        <thead><tr><th>Plaque</th><th>Véhicule</th><th>Client</th><th class="num">Km</th><th>Contrôle technique</th><th>Entretien</th></tr></thead>
        <tbody><tr v-for="v in rows" class="click" @click="go('/vehicle/' + v.id)">
          <td><span class="plate">{{ v.plate || '—' }}</span></td><td>{{ v.make }} {{ v.model }} <span class="muted small">{{ v.year }} {{ v.fuel }}</span></td>
          <td>{{ v.customer_name }}</td><td class="num">{{ v.mileage?.toLocaleString() }}</td>
          <td :class="{late: v.next_inspection && v.next_inspection < today}">{{ date(v.next_inspection) }}</td><td>{{ date(v.next_service_date) }}</td>
        </tr></tbody>
      </table></div>
      <Empty v-if="!rows.length" icon="🚗" text="Aucun véhicule — ajoutez-les depuis la fiche client"/>
    </div>
  </div>`,
};

export const VehicleDetail = {
  setup() {
    const v = ref(null);
    const load = async () => { v.value = await GET('/vehicles/' + route.params.id); };
    onMounted(load);
    const save = async () => { await act(() => PUT('/vehicles/' + v.value.id, v.value), 'Enregistré'); load(); };
    const vin = async () => { try { Object.assign(v.value, await decodeVin(v.value.vin)); toast('VIN décodé'); } catch (e) { toast(e.message, 'error'); } };
    const remove = async () => { if (!confirm('Supprimer ce véhicule ?')) return; await act(() => DEL('/vehicles/' + v.value.id)); go('/vehicles'); };
    return { v, save, vin, remove, money, date, DOC_TYPES_SHORT };
  },
  template: `
  <div v-if="v">
    <div class="page-head">
      <div><h1><span class="plate" style="font-size:18px">{{ v.plate || '—' }}</span> {{ v.make }} {{ v.model }}</h1><div class="sub"><a :href="'#/customer/' + v.customer_id">{{ v.customer_name }}</a></div></div>
      <div class="btns">
        <a class="btn" :href="'#/new/quote?customer_id=' + v.customer_id + '&vehicle_id=' + v.id">+ Devis</a>
        <a class="btn primary" :href="'#/new/order?customer_id=' + v.customer_id + '&vehicle_id=' + v.id">+ OR</a>
        <button class="btn danger" @click="remove">🗑</button>
      </div>
    </div>
    <div class="grid g2">
      <div class="card">
        <h2>Fiche technique</h2>
        <div class="form-grid">
          <label>Plaque<input v-model="v.plate"></label>
          <label class="full" style="grid-column: span 2">VIN<div style="display:flex;gap:6px"><input v-model="v.vin" maxlength="17"><button class="btn" @click="vin">🔎 Décoder</button></div></label>
          <label>Marque<input v-model="v.make"></label><label>Modèle<input v-model="v.model"></label><label>Version<input v-model="v.version"></label>
          <label>Carburant<input v-model="v.fuel"></label><label>Année<input v-model.number="v.year" type="number"></label>
          <label>1ère immat.<input v-model="v.first_registration" type="date"></label><label>Kilométrage<input v-model.number="v.mileage" type="number"></label>
          <label>Moteur<input v-model="v.engine_code"></label><label>Couleur<input v-model="v.color"></label><label>Pneus<input v-model="v.tyre_size"></label>
          <label>Contrôle technique<input v-model="v.next_inspection" type="date"></label>
          <label>Prochain entretien<input v-model="v.next_service_date" type="date"></label><label>… ou à (km)<input v-model.number="v.next_service_km" type="number"></label>
          <label class="full">Notes<textarea v-model="v.notes"></textarea></label>
        </div>
        <button class="btn primary" style="margin-top:12px" @click="save">Enregistrer</button>
      </div>
      <div class="card">
        <h2>🕓 Historique d'entretien</h2>
        <div class="timeline">
          <div v-for="h in v.history" class="tl-item">
            <div><a :href="'#/document/' + h.id"><b>{{ DOC_TYPES_SHORT[h.type] }} {{ h.number || '' }}</b></a> <span class="muted small">{{ date(h.date) }} <span v-if="h.mileage">· {{ h.mileage.toLocaleString() }} km</span></span> <Badge :status="h.status"/></div>
            <div class="small">{{ h.customer_complaint }}</div>
            <div class="muted small">{{ h.summary }}</div>
          </div>
        </div>
        <Empty v-if="!v.history.length" icon="🛠️" text="Aucune intervention enregistrée"/>
      </div>
    </div>
    <Chatter model="vehicle" :record-id="v.id" style="margin-top:16px"/>
  </div>`,
};
