import { ref, reactive, computed, onMounted, watch, nextTick } from 'vue';
import { GET, POST, PUT, DEL, act, toast, money, date, datetime, hours, today, store, DOC_TYPES, DOC_TYPES_SHORT, TAX_RATES, STATUS } from '../api.js';
import { route, go } from '../router.js';
import { LivePanel } from '../live-panel.js';
import { DocPrint } from '../doc-print.js';

export const DocumentList = {
  setup() {
    const type = route.params.type;
    const rows = ref([]);
    const q = ref('');
    const status = ref(route.query.filter === 'overdue' ? 'overdue' : '');
    const types = type === 'invoice' ? 'invoice,credit_note' : type;
    const load = async () => {
      const params = new URLSearchParams({ type: types });
      if (q.value) params.set('q', q.value);
      if (status.value === 'overdue') params.set('overdue', '1');
      else if (status.value) params.set('status', status.value);
      rows.value = await GET('/documents?' + params);
    };
    onMounted(load);
    const statuses = { quote: ['draft', 'sent', 'accepted', 'refused'], invoice: ['draft', 'posted', 'partial', 'paid'], order: ['open', 'in_progress', 'waiting_parts', 'done', 'invoiced'] }[type] || [];
    const totals = computed(() => ({ total: rows.value.reduce((s, r) => s + (r.type === 'credit_note' ? -r.total : r.total), 0), due: rows.value.filter((r) => r.type === 'invoice').reduce((s, r) => s + (r.total - r.amount_paid), 0) }));
    return { type, rows, q, status, load, statuses, STATUS, DOC_TYPES, DOC_TYPES_SHORT, money, date, go, totals, today };
  },
  template: `
  <div>
    <div class="page-head">
      <h1>{{ type === 'invoice' ? 'Factures & avoirs' : type === 'quote' ? 'Devis' : 'Ordres de réparation' }}</h1>
      <div class="btns"><ModuleTools :module="type === 'order' ? 'atelier' : 'ventes'"/><a class="btn primary" :href="'#/new/' + type">+ Nouveau {{ DOC_TYPES_SHORT[type].toLowerCase() }}</a></div>
    </div>
    <div class="card">
      <div class="toolbar">
        <input v-model="q" @input="load" placeholder="N°, client, plaque…">
        <select v-model="status" @change="load"><option value="">Tous les statuts</option><option v-if="type==='invoice'" value="overdue">En retard</option><option v-for="s in statuses" :value="s">{{ STATUS[s][0] }}</option></select>
        <span class="muted" style="margin-left:auto">{{ rows.length }} documents · {{ money(totals.total) }} TTC<span v-if="type==='invoice'"> · reste dû {{ money(totals.due) }}</span></span>
      </div>
      <div class="table-wrap"><table>
        <thead><tr><th>N°</th><th>Date</th><th>Client</th><th>Véhicule</th><th v-if="type==='invoice'">Échéance</th><th>Statut</th><th class="num">Total TTC</th><th class="num" v-if="type==='invoice'">Reste dû</th></tr></thead>
        <tbody>
          <tr v-for="r in rows" class="click" @click="go('/document/' + r.id)">
            <td><b>{{ r.number || 'Brouillon' }}</b> <span v-if="r.type==='credit_note'" class="badge b-purple">Avoir</span></td>
            <td>{{ date(r.date) }}</td><td>{{ r.customer_name }}</td>
            <td><span class="plate" v-if="r.plate">{{ r.plate }}</span> <span class="muted small">{{ r.make }} {{ r.model }}</span></td>
            <td v-if="type==='invoice'" :class="{late: r.due_date < today() && ['posted','partial'].includes(r.status)}">{{ date(r.due_date) }}</td>
            <td><Badge :status="r.status"/></td>
            <td class="num">{{ money(r.type === 'credit_note' ? -r.total : r.total) }}</td>
            <td class="num" v-if="type==='invoice'">{{ r.type === 'invoice' && r.status !== 'draft' ? money(r.total - r.amount_paid) : '' }}</td>
          </tr>
        </tbody>
      </table></div>
      <Empty v-if="!rows.length" text="Aucun document"/>
    </div>
  </div>`,
};

// ---------- Création rapide client / véhicule ----------
export const QuickCustomer = {
  emits: ['close', 'saved'],
  setup(_, { emit }) {
    const c = reactive({ type: 'particulier', name: '', company: '', email: '', mobile: '', address: '', zip: '', city: '', country: 'LU', vat_number: '' });
    const v = reactive({ plate: '', make: '', model: '', vin: '', mileage: null });
    const save = async () => {
      const { id } = await act(() => POST('/customers', c));
      let vehicle = null;
      if (v.plate || v.vin) {
        const r = await act(() => POST('/vehicles', { ...v, customer_id: id }));
        vehicle = { id: r.id, ...v };
      }
      emit('saved', { customer: { id, ...c }, vehicle });
    };
    return { c, v, save };
  },
  template: `
  <Modal title="Nouveau client" @close="$emit('close')" wide>
    <div class="form-grid">
      <label>Type<select v-model="c.type"><option value="particulier">Particulier</option><option value="societe">Société</option></select></label>
      <label>Nom *<input v-model="c.name" required></label>
      <label v-if="c.type==='societe'">Société<input v-model="c.company"></label>
      <label v-if="c.type==='societe'">N° TVA<input v-model="c.vat_number" placeholder="LU…"></label>
      <label>GSM<input v-model="c.mobile"></label>
      <label>E-mail<input v-model="c.email" type="email"></label>
      <label class="full">Adresse<input v-model="c.address"></label>
      <label>Code postal<input v-model="c.zip" placeholder="L-…"></label>
      <label>Localité<input v-model="c.city"></label>
    </div>
    <h3>Véhicule</h3>
    <div class="form-grid">
      <label>Plaque<input v-model="v.plate"></label>
      <label>Marque<input v-model="v.make"></label>
      <label>Modèle<input v-model="v.model"></label>
      <label>VIN<input v-model="v.vin"></label>
      <label>Kilométrage<input v-model.number="v.mileage" type="number"></label>
    </div>
    <template #foot><button class="btn" @click="$emit('close')">Annuler</button><button class="btn primary" :disabled="!c.name" @click="save">Créer</button></template>
  </Modal>`,
};

export const PaymentModal = {
  props: ['residual', 'title'],
  emits: ['close', 'save'],
  setup(props) {
    const p = reactive({ amount: props.residual, date: today(), method: 'bank', reference: '' });
    return { p };
  },
  template: `
  <Modal :title="title || 'Enregistrer un paiement'" @close="$emit('close')">
    <div class="form-grid">
      <label>Montant<input v-model.number="p.amount" type="number" step="0.01"></label>
      <label>Date<input v-model="p.date" type="date"></label>
      <label>Moyen<select v-model="p.method"><option value="bank">Virement</option><option value="card">Carte (terminal)</option><option value="cash">Espèces</option><option value="payconiq">Payconiq</option></select></label>
      <label>Référence<input v-model="p.reference"></label>
    </div>
    <template #foot><button class="btn" @click="$emit('close')">Annuler</button><button class="btn success" @click="$emit('save', p)">Enregistrer</button></template>
  </Modal>`,
};

// ---------- Éditeur de document (devis / OR / facture / avoir) ----------
export const DocumentEditor = {
  components: { QuickCustomer, PaymentModal, LivePanel, DocPrint },
  setup() {
    const isNew = route.params.id === 'new';
    const doc = ref(null);
    const vehicles = ref([]);
    const mechanics = ref([]);
    const showCustomer = ref(false);
    const showPay = ref(false);
    const dirty = ref(false);
    const s = store.settings?.workshop || { labor_rate: 85, default_tax: 17 };

    const load = async () => {
      if (isNew) {
        doc.value = { type: route.params.type, status: 'draft', date: today(), lines: [], customer_id: Number(route.query.customer_id) || null, vehicle_id: Number(route.query.vehicle_id) || null, customer_name: '', payments: [], children: [] };
        if (doc.value.customer_id) {
          const c = await GET('/customers/' + doc.value.customer_id);
          doc.value.customer_name = c.name;
          vehicles.value = c.vehicles;
        }
      } else {
        doc.value = await GET('/documents/' + route.params.id);
        if (doc.value.customer_id) vehicles.value = (await GET('/customers/' + doc.value.customer_id)).vehicles;
      }
      await nextTick();
      dirty.value = false;
    };
    onMounted(async () => { mechanics.value = (await GET('/users')).filter((u) => u.role === 'mechanic' && u.active); await load(); });
    watch(() => doc.value && [doc.value.lines, doc.value.customer_id, doc.value.vehicle_id, doc.value.notes, doc.value.customer_complaint, doc.value.diagnosis, doc.value.mileage], () => { dirty.value = true; }, { deep: true });

    const locked = computed(() => doc.value && (['invoice', 'credit_note'].includes(doc.value.type) ? doc.value.status !== 'draft' : doc.value.status === 'invoiced'));
    const showDiscount = computed(() => store.settings?.options?.ventes?.line_discounts !== false || (doc.value?.lines || []).some((l) => l.discount));
    const lineTotal = (l) => (l.kind === 'text' ? 0 : Math.round((l.quantity || 0) * (l.unit_price || 0) * (1 - (l.discount || 0) / 100) * 100) / 100);
    const totals = computed(() => {
      const byRate = {};
      let sub = 0;
      for (const l of doc.value?.lines || []) { if (l.kind === 'text') continue; const t = lineTotal(l); sub += t; byRate[l.tax_rate] = (byRate[l.tax_rate] || 0) + t; }
      const taxes = Object.entries(byRate).map(([r, b]) => ({ rate: r, base: b, amount: Math.round(b * r) / 100 }));
      const tax = taxes.reduce((a, t) => a + t.amount, 0);
      return { sub, taxes, tax, total: sub + tax };
    });

    const addLine = (kind) => {
      const base = { kind, description: '', quantity: 1, unit_price: 0, discount: 0, tax_rate: s.default_tax, product_id: null };
      if (kind === 'labor') Object.assign(base, { description: "Main-d'œuvre", unit_price: s.labor_rate, unit: 'h' });
      doc.value.lines.push(base);
    };
    const pickProduct = (l, p) => {
      if (!p) { l.product_id = null; return; }
      Object.assign(l, { product_id: p.id, description: `${p.ref ? p.ref + ' — ' : ''}${p.name}`, unit_price: p.sale_price, tax_rate: p.tax_rate, qty_on_hand: p.qty_on_hand, is_service: p.is_service });
      if (p.is_service) {
        l.kind = 'fee';
        if (p.labor_hours) doc.value.lines.push({ kind: 'labor', description: `Main-d'œuvre — ${p.name}`, quantity: p.labor_hours, unit_price: s.labor_rate, discount: 0, tax_rate: s.default_tax, unit: 'h' });
      }
    };
    const move = (i, d) => { const L = doc.value.lines; const [x] = L.splice(i, 1); L.splice(Math.max(0, Math.min(L.length, i + d)), 0, x); };
    const onCustomer = async (c) => {
      doc.value.customer_name = c?.name || '';
      vehicles.value = c ? (await GET('/customers/' + c.id)).vehicles : [];
      doc.value.vehicle_id = vehicles.value.length === 1 ? vehicles.value[0].id : null;
    };
    const onQuickCustomer = ({ customer, vehicle }) => {
      doc.value.customer_id = customer.id;
      doc.value.customer_name = customer.name;
      vehicles.value = vehicle ? [vehicle] : [];
      doc.value.vehicle_id = vehicle?.id || null;
      showCustomer.value = false;
    };

    const save = async (silent) => {
      const payload = { ...doc.value, lines: doc.value.lines };
      if (isNew && !doc.value.id) {
        const { id } = await act(() => POST('/documents', payload), silent ? null : 'Enregistré');
        dirty.value = false;
        go('/document/' + id);
        return id;
      }
      await act(() => PUT('/documents/' + doc.value.id, payload), silent ? null : 'Enregistré');
      await load();
      return doc.value.id;
    };
    const ensureSaved = async () => (dirty.value || !doc.value.id ? save(true) : doc.value.id);
    const convert = async (type) => {
      const id = await ensureSaved();
      const r = await act(() => POST(`/documents/${id}/convert`, { type }), `${DOC_TYPES[type]} créé(e)`);
      go('/document/' + r.id);
    };
    const post = async () => {
      if (!confirm('Valider définitivement la facture ? Elle ne pourra plus être modifiée (obligation légale).')) return;
      const id = await ensureSaved();
      const r = await act(() => POST(`/documents/${id}/post`), 'Facture validée');
      toast(`Numéro attribué : ${r.number}`);
      await load();
    };
    const setStatus = async (status) => { await ensureSaved(); await act(() => POST(`/documents/${doc.value.id}/status`, { status })); await load(); };
    const pay = async (p) => { await act(() => POST(`/documents/${doc.value.id}/payments`, p), 'Paiement enregistré'); showPay.value = false; await load(); };
    const remove = async () => { if (!confirm('Supprimer ce document ?')) return; await act(() => DEL('/documents/' + doc.value.id), 'Supprimé'); history.back(); };
    const print = async () => { if (dirty.value && !locked.value) await save(true); setTimeout(() => window.print(), 100); };

    const flow = computed(() => {
      const d = doc.value;
      if (!d) return [];
      const chain = [];
      if (d.parent) chain.push(d.parent);
      chain.push({ id: d.id, type: d.type, number: d.number, cur: true });
      for (const c of d.children || []) chain.push(c);
      return chain;
    });
    const METHODS = { bank: 'Virement', card: 'Carte', cash: 'Espèces', payconiq: 'Payconiq' };
    const productLabel = (p) => `${p.ref ? p.ref + ' — ' : ''}${p.name} ${p.is_service ? '(forfait)' : `· stock ${p.qty_on_hand}`} · ${money(p.sale_price)}`;

    return { showDiscount, doc, vehicles, mechanics, isNew, locked, totals, lineTotal, addLine, pickProduct, move, onCustomer, onQuickCustomer, save, convert, post, setStatus, pay, remove, print,
      showCustomer, showPay, dirty, flow, productLabel, METHODS, money, date, datetime, hours, store, DOC_TYPES, DOC_TYPES_SHORT, TAX_RATES, STATUS };
  },
  template: `
  <div v-if="doc">
    <div class="page-head no-print">
      <div>
        <div class="stepper" v-if="flow.length > 1">
          <template v-for="(f, i) in flow"><span v-if="i">→</span><a :href="'#/document/' + f.id" :class="{cur: f.cur}">{{ DOC_TYPES_SHORT[f.type] }} {{ f.number || '' }}</a></template>
        </div>
        <h1 style="margin-top:6px">{{ DOC_TYPES[doc.type] }} {{ doc.number || (isNew ? '(nouveau)' : '(brouillon)') }} <Badge v-if="!isNew" :status="doc.status"/></h1>
      </div>
      <div class="btns">
        <button class="btn" v-if="!locked" @click="save()">💾 Enregistrer</button>
        <template v-if="doc.type==='quote' && !isNew">
          <button class="btn" v-if="doc.status==='draft'" @click="setStatus('sent')">📤 Marquer envoyé</button>
          <button class="btn" v-if="['draft','sent'].includes(doc.status)" @click="setStatus('refused')">Refusé</button>
          <button class="btn primary" @click="convert('order')">🔧 Créer l'OR</button>
          <button class="btn" @click="convert('invoice')">🧾 Facturer</button>
        </template>
        <template v-if="doc.type==='order' && !isNew && !locked">
          <select style="width:auto" :value="doc.status" @change="setStatus($event.target.value)">
            <option v-for="s in ['open','in_progress','waiting_parts','done']" :value="s">{{ STATUS[s][0] }}</option>
          </select>
          <button class="btn primary" @click="convert('invoice')">🧾 Facturer</button>
        </template>
        <button class="btn success" v-if="['invoice','credit_note'].includes(doc.type) && doc.status==='draft' && !isNew" @click="post">✔ Valider</button>
        <button class="btn primary" v-if="['invoice','credit_note'].includes(doc.type) && ['posted','partial'].includes(doc.status)" @click="showPay = true">💶 {{ doc.type === 'credit_note' ? 'Rembourser' : 'Paiement' }}</button>
        <button class="btn" v-if="doc.type==='invoice' && doc.status!=='draft'" @click="convert('credit_note')">↩ Note de crédit</button>
        <button class="btn" v-if="!isNew" @click="print">🖨️ Imprimer / PDF</button>
        <button class="btn danger" v-if="!isNew && !locked" @click="remove">🗑</button>
      </div>
    </div>

    <div class="doc-layout no-print">
      <div>
        <div class="card">
          <div class="form-grid">
            <label class="full" style="grid-column: span 2">Client
              <div style="display:flex;gap:6px"><div style="flex:1"><Picker v-if="!locked" v-model="doc.customer_id" endpoint="/customers" :initial="doc.customer_name" :label="c => c.name + (c.company ? ' — ' + c.company : '') + (c.city ? ' (' + c.city + ')' : '')" placeholder="Rechercher un client…" @pick="onCustomer"/>
                <input v-else :value="doc.customer_name" disabled></div>
                <button class="btn" v-if="!locked" @click="showCustomer = true" title="Nouveau client">+</button>
                <a class="btn" v-if="doc.customer_id" :href="'#/customer/' + doc.customer_id">👤</a></div>
            </label>
            <label>Véhicule
              <select v-model="doc.vehicle_id" :disabled="locked"><option :value="null">—</option><option v-for="v in vehicles" :value="v.id">{{ v.plate }} {{ v.make }} {{ v.model }}</option></select>
            </label>
            <label>Kilométrage<input v-model.number="doc.mileage" type="number" :disabled="locked"></label>
            <label>Date<input v-model="doc.date" type="date" :disabled="locked"></label>
            <label v-if="doc.type==='invoice'">Échéance<input v-model="doc.due_date" type="date" :disabled="locked"></label>
            <label v-if="doc.type==='order'">Mécanicien<select v-model="doc.mechanic_id" :disabled="locked"><option :value="null">—</option><option v-for="m in mechanics" :value="m.id">{{ m.name }}</option></select></label>
            <label v-if="doc.type==='order'">Promis pour<input v-model="doc.promised_at" type="datetime-local" :disabled="locked"></label>
            <label>Référence<input v-model="doc.reference" :disabled="locked" placeholder="Bon de commande, sinistre…"></label>
            <label class="full" v-if="doc.type!=='invoice' && doc.type!=='credit_note'">Demande du client<textarea v-model="doc.customer_complaint" :disabled="locked" placeholder="Bruit à l'avant gauche au freinage…"></textarea></label>
            <label class="full" v-if="doc.type==='order'">Diagnostic / constat du mécanicien<textarea v-model="doc.diagnosis" :disabled="locked"></textarea></label>
          </div>
        </div>

        <div class="card">
          <div class="card-head"><h2>Prestations & pièces</h2></div>
          <div class="table-wrap"><table class="lines" :class="{ 'no-disc': !showDiscount }">
            <thead><tr><th class="kind">Type</th><th>Désignation</th><th class="q num">Qté</th><th class="p num">P.U. HT</th><th class="d num dcol">Rem. %</th><th class="t">TVA</th><th class="num">Total HT</th><th v-if="doc.type==='order'">Fait</th><th></th></tr></thead>
            <tbody>
              <tr v-for="(l, i) in doc.lines" :class="{'text-line': l.kind === 'text'}">
                <td><select v-model="l.kind" :disabled="locked"><option value="labor">🔧 M.O.</option><option value="part">📦 Pièce</option><option value="fee">🏷️ Forfait</option><option value="text">📝 Texte</option></select></td>
                <td>
                  <div v-if="!locked && l.kind === 'part' && !l.description" style="display:flex;gap:4px"><div style="flex:1"><Picker endpoint="/products" :label="productLabel" placeholder="Réf. ou nom de la pièce / forfait…" @pick="p => pickProduct(l, p)"/></div><button class="btn sm" title="Saisie libre (pièce hors stock)" @click="l.description = 'Pièce'">✎</button></div>
                  <input v-else class="descr" v-model="l.description" :disabled="locked">
                  <div class="stock-warn" v-if="l.kind==='part' && l.product_id && l.qty_on_hand !== undefined && l.qty_on_hand !== null && l.qty_on_hand < l.quantity && doc.status !== 'posted'">⚠ stock : {{ l.qty_on_hand }}</div>
                </td>
                <template v-if="l.kind !== 'text'">
                  <td><input v-model.number="l.quantity" type="number" step="0.1" class="right" :disabled="locked"></td>
                  <td><input v-model.number="l.unit_price" type="number" step="0.01" class="right" :disabled="locked"></td>
                  <td class="dcol"><input v-model.number="l.discount" type="number" class="right" :disabled="locked"></td>
                  <td><select v-model.number="l.tax_rate" :disabled="locked"><option v-for="r in TAX_RATES" :value="r">{{ r }}%</option></select></td>
                  <td class="num">{{ money(lineTotal(l)) }}</td>
                </template>
                <td v-else colspan="5"></td>
                <td v-if="doc.type==='order'" style="text-align:center"><input type="checkbox" :checked="!!l.done" @change="l.done = $event.target.checked ? 1 : 0" :disabled="locked"></td>
                <td class="nowrap" v-if="!locked"><button class="icon-btn" @click="move(i,-1)">↑</button><button class="icon-btn" @click="move(i,1)">↓</button><button class="icon-btn" @click="doc.lines.splice(i,1)">✕</button></td>
              </tr>
            </tbody>
          </table></div>
          <div class="line-add" v-if="!locked">
            <button class="btn sm" @click="addLine('labor')">+ Main-d'œuvre</button>
            <button class="btn sm" @click="addLine('part')">+ Pièce du stock</button>
            <button class="btn sm" @click="addLine('fee')">+ Forfait libre</button>
            <button class="btn sm" @click="addLine('text')">+ Commentaire</button>
          </div>
        </div>
        <div class="card">
          <div class="form-grid">
            <label class="full">Notes (imprimées)<textarea v-model="doc.notes" :disabled="locked"></textarea></label>
            <label class="full">Notes internes<textarea v-model="doc.internal_notes"></textarea></label>
          </div>
          <button v-if="locked" class="btn sm" style="margin-top:8px" @click="save()">Enregistrer les notes internes</button>
        </div>
        <Chatter v-if="!isNew && doc.id" model="document" :record-id="doc.id"/>
      </div>

      <div>
        <div class="card">
          <div class="totals">
            <span class="muted">Total HT</span><b class="num">{{ money(totals.sub) }}</b>
            <template v-for="t in totals.taxes"><span class="muted">TVA {{ t.rate }}% sur {{ money(t.base) }}</span><span class="num">{{ money(t.amount) }}</span></template>
            <span class="grand">Total TTC</span><span class="grand num">{{ money(totals.total) }}</span>
            <template v-if="doc.amount_paid"><span class="muted">Déjà payé</span><span class="num pos">{{ money(doc.amount_paid) }}</span><b>Reste dû</b><b class="num">{{ money(doc.total - doc.amount_paid) }}</b></template>
          </div>
          <div v-if="dirty && !locked" class="muted small" style="margin-top:10px">● Modifications non enregistrées</div>
        </div>
        <LivePanel v-if="doc.type==='order' && !isNew && doc.id" :doc-id="doc.id"/>
        <div class="card" v-if="doc.type==='order' && !isNew">
          <h2>⏱️ Temps atelier</h2>
          <div class="totals"><span class="muted">Heures vendues</span><b>{{ hours(doc.hours_sold) }}</b><span class="muted">Heures pointées</span><b :class="doc.hours_spent > doc.hours_sold ? 'neg' : 'pos'">{{ hours(doc.hours_spent) }}</b></div>
          <div v-for="t in doc.time_entries" class="list-item small"><span>{{ t.user_name }}</span><span class="muted">{{ datetime(t.start) }}</span><span v-if="t.end">{{ hours((new Date(t.end) - new Date(t.start)) / 3.6e6) }}</span><span v-else class="live">en cours</span></div>
        </div>
        <div class="card" v-if="doc.payments && doc.payments.length">
          <h2>💶 Paiements</h2>
          <div v-for="p in doc.payments" class="list-item small"><span>{{ date(p.date) }} · {{ METHODS[p.method] || p.method }}</span><b>{{ money(p.amount) }}</b></div>
        </div>
        <div class="card" v-if="doc.vehicle_id">
          <a :href="'#/vehicle/' + doc.vehicle_id">🚗 Historique du véhicule →</a>
        </div>
      </div>
    </div>

    <!-- Version imprimable (mise en page choisie dans Paramètres → Mise en page) -->
    <div class="print-only"><DocPrint :doc="doc"/></div>

    <QuickCustomer v-if="showCustomer" @close="showCustomer = false" @saved="onQuickCustomer"/>
    <PaymentModal v-if="showPay" :residual="Math.round((doc.total - doc.amount_paid) * 100) / 100" :title="doc.type === 'credit_note' ? 'Remboursement au client' : 'Encaissement'" @close="showPay = false" @save="pay"/>
  </div>`,
};
