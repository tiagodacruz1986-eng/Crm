import { ref, reactive, computed, onMounted, onUnmounted, watch, nextTick } from 'vue';
import { GET, POST, PUT, DEL, act, toast, money, date, datetime, hours, today, store, DOC_TYPES, DOC_TYPES_SHORT, TAX_RATES, STATUS } from '../api.js';
import { route, go, leaveGuards } from '../router.js';
import { LivePanel } from '../live-panel.js';
import { DocPrint } from '../doc-print.js';
import { lineTotal, computeTotals } from '../totals.js';
import { can } from '../apps.js';

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
    const statuses = { quote: ['draft', 'sent', 'accepted', 'refused'], invoice: ['draft', 'posted', 'partial', 'paid'], credit_note: ['draft', 'posted', 'partial', 'paid'], order: ['open', 'in_progress', 'waiting_parts', 'done', 'invoiced'] }[type] || [];
    // « reste dû » : seulement les factures validées (un brouillon n'est pas encore dû)
    const totals = computed(() => ({ total: rows.value.reduce((s, r) => s + (r.type === 'credit_note' ? -r.total : r.total), 0), due: rows.value.filter((r) => r.type === 'invoice' && ['posted', 'partial'].includes(r.status)).reduce((s, r) => s + (r.total - r.amount_paid), 0) }));
    return { type, rows, q, status, load, statuses, STATUS, DOC_TYPES, DOC_TYPES_SHORT, money, date, go, totals, today };
  },
  template: `
  <div>
    <div class="page-head">
      <h1>{{ { invoice: 'Factures & avoirs', quote: 'Devis', credit_note: 'Notes de crédit (avoirs)', order: 'Ordres de réparation' }[type] || 'Documents' }}</h1>
      <div class="btns"><ModuleTools :module="type === 'order' ? 'atelier' : 'ventes'"/><a class="btn primary" :href="'#/new/' + type">+ {{ { quote: 'Nouveau devis', order: 'Nouvel OR', invoice: 'Nouvelle facture', credit_note: 'Nouvel avoir' }[type] || 'Nouveau' }}</a></div>
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
            <td><span class="brand-line"><BrandLogo :make="r.make" :size="24"/><span><span class="plate" v-if="r.plate">{{ r.plate }}</span> <span class="muted small">{{ r.make }} {{ r.model }}</span></span></span></td>
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
      // un véhicule est créé dès qu'une de ses informations est saisie (plaque, VIN, marque, modèle ou kilométrage)
      if (v.plate || v.vin || v.make || v.model || v.mileage) {
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
    // marque du véhicule choisi (pour afficher son logo)
    const curMake = computed(() => (doc.value?.vehicle_id ? vehicles.value.find((v) => v.id === doc.value.vehicle_id)?.make || doc.value.make || '' : ''));
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
        takeTimes(doc.value);
        if (doc.value.customer_id) vehicles.value = (await GET('/customers/' + doc.value.customer_id)).vehicles;
      }
      await nextTick();
      dirty.value = false;
    };
    // ---------- Temps atelier : temps prévu / temps passé par intervention ----------
    // Les temps pointés sont gardés À PART du document : les relire ne touche jamais à une saisie en cours.
    const tick = ref(Date.now());
    const NO_TIME = { spent: 0, active: 0, workers: [], worker_ids: [], auto: false };
    const times = ref({ at: Date.now(), lines: {}, spent: 0, general: 0, generalActive: 0, generalWorkers: [], generalWorkerIds: [], generalAuto: false, entries: [] });
    const takeTimes = (d) => {
      times.value = { at: Date.now(),
        lines: Object.fromEntries((d.lines || []).filter((l) => l.id).map((l) => [l.id, { spent: l.spent || 0, active: l.active || 0, workers: l.workers || [], worker_ids: l.worker_ids || [], auto: !!l.auto }])),
        spent: d.hours_spent || 0, active: d.active_workers || 0, general: d.hours_general || 0, generalActive: d.general_active || 0,
        generalWorkers: d.general_workers || [], generalWorkerIds: d.general_worker_ids || [], generalAuto: !!d.general_auto, entries: d.time_entries || [] };
      tick.value = Date.now();
    };
    // Les chronos en cours avancent à l'écran ; les temps d'un OR ouvert sont relus chaque minute (seulement les temps)
    let ticker, reading = false;
    onMounted(() => { ticker = setInterval(async () => {
      tick.value = Date.now();
      const d = doc.value;
      if (reading || !d || d.type !== 'order' || !d.id || d.status === 'invoiced' || Date.now() - times.value.at < 60000) return;
      const id = d.id;
      reading = true;
      try {
        const fresh = await GET('/documents/' + id);
        if (doc.value?.id !== id) return;
        // Modifié ailleurs (diagnostic saisi à la tablette, ligne cochée…) et rien en cours de saisie ici : on prend tout le document
        if (!dirty.value && fresh.updated_at !== doc.value.updated_at) { doc.value = fresh; takeTimes(fresh); await nextTick(); dirty.value = false; }
        else takeTimes(fresh);
      } catch { /* prochain essai dans une minute */ } finally { reading = false; }
    }, 10000); });
    onUnmounted(() => clearInterval(ticker));
    const isWork = (l) => l.kind === 'labor' || l.kind === 'fee';
    // Nombre d'heures saisi : « 1,5 » ou « 1.5 » ; vide = rien ; autre chose = invalide (NaN)
    const parseHours = (v) => {
      if (v === null || v === undefined) return null;
      const s = String(v).trim().replace(',', '.');
      if (s === '') return null;
      return /^(\d+(\.\d*)?|\.\d+)$/.test(s) ? Number(s) : NaN;
    };
    // Temps prévu : celui saisi ; sinon, pour la main-d'œuvre, les heures vendues (forfait vide ou 0 = pas de temps prévu)
    const plannedOf = (l) => {
      if (!isWork(l)) return null;
      const p = parseHours(l.planned_hours);
      if (p === null) { const q = Number(l.quantity); return l.kind === 'labor' && q > 0 ? q : null; }
      return p > 0 ? p : null;
    };
    const plannedBad = (l) => isWork(l) && Number.isNaN(parseHours(l.planned_hours));
    const tOf = (l) => times.value.lines[l.id] || NO_TIME;
    const liveHours = (spent, active) => (Number(spent) || 0) + (Number(active) || 0) * Math.max(0, tick.value - times.value.at) / 3.6e6;
    const isOver = (spent, planned) => planned > 0 && spent - planned > 1 / 120;
    const lineSpent = (l) => liveHours(tOf(l).spent, tOf(l).active);
    const lineOver = (l) => isOver(lineSpent(l), plannedOf(l));
    const work = computed(() => {
      const d = doc.value;
      if (!d || d.type !== 'order') return null;
      const lines = (d.lines || []).filter(isWork).map((l) => ({ l, t: tOf(l), planned: plannedOf(l), spent: lineSpent(l), over: lineOver(l) }));
      const planned = lines.reduce((s, x) => s + (x.planned || 0), 0);
      const spent = liveHours(times.value.spent, times.value.active);
      // le temps pointé sur une intervention sans temps prévu n'est comparé à rien : il ne met jamais l'OR en rouge
      const unplanned = lines.reduce((s, x) => s + (x.planned ? 0 : x.spent), 0);
      return { lines, planned, spent, unplanned, over: isOver(spent - unplanned, planned), overBy: spent - unplanned - planned,
        general: liveHours(times.value.general, times.value.generalActive) };
    });
    // Chrono lancé d'ici, pour le mécanicien choisi (comme à la tablette : démarrer ailleurs arrête son chrono précédent)
    const canClock = can('atelier', 'user') && can('presences', 'manager');
    // pas de chrono sur un OR facturé ou annulé (le serveur le refuserait)
    const canClockHere = computed(() => canClock && !locked.value && doc.value?.status !== 'cancelled');
    const clockUser = ref(null);
    const pickClockUser = () => {
      const ids = mechanics.value.map((m) => m.id);
      if (ids.includes(clockUser.value)) return;
      let last = null;
      try { last = Number(localStorage.getItem('garage_clock_user')) || null; } catch { /* stockage indisponible */ }
      clockUser.value = [doc.value?.mechanic_id, last, ids[0]].find((id) => ids.includes(id)) || null;
    };
    const runningOn = (ids) => !!clockUser.value && (ids || []).includes(clockUser.value);
    const clock = async (action, lineId) => {
      if (!clockUser.value) { toast('Choisissez le mécanicien pour qui lancer le chrono', 'error'); return; }
      try { localStorage.setItem('garage_clock_user', String(clockUser.value)); } catch { /* stockage indisponible */ }
      if (dirty.value) await save(true);
      const who = mechanics.value.find((m) => m.id === clockUser.value)?.name || '';
      let r;
      try { r = await act(() => POST('/documents/' + doc.value.id + '/clock', { action, user_id: clockUser.value, line_id: lineId || null })); } catch { return; } // le message d'erreur est déjà affiché
      if (r.switched && !r.switched.same_order) toast('Chrono de ' + who + ' arrêté sur ' + (r.switched.number || 'l’autre OR') + ' : il est maintenant sur cet OR');
      await load();
    };
    const pct = (spent, planned) => (planned > 0 ? Math.min(100, Math.round((100 * spent) / planned)) : spent > 0 ? 100 : 0);
    onMounted(async () => { mechanics.value = (await GET('/users')).filter((u) => u.role === 'mechanic' && u.active); await load(); pickClockUser(); });
    watch(() => doc.value && [doc.value.lines, doc.value.customer_id, doc.value.vehicle_id, doc.value.notes, doc.value.customer_complaint, doc.value.diagnosis, doc.value.mileage,
      doc.value.date, doc.value.due_date, doc.value.reference, doc.value.mechanic_id, doc.value.promised_at, doc.value.internal_notes], () => { dirty.value = true; }, { deep: true });

    const locked = computed(() => doc.value && (['invoice', 'credit_note'].includes(doc.value.type) ? doc.value.status !== 'draft' : doc.value.status === 'invoiced'));
    // Modifications non enregistrées : confirmation avant de changer de page ou de fermer l'application
    // (document validé : seules les notes internes restent modifiables, elles comptent aussi)
    const leaveOk = () => !dirty.value || confirm('Les modifications ne sont pas enregistrées. Quitter quand même ?');
    const onUnload = (e) => { if (dirty.value) { e.preventDefault(); e.returnValue = ''; } };
    onMounted(() => { leaveGuards.add(leaveOk); window.addEventListener('beforeunload', onUnload); });
    onUnmounted(() => { leaveGuards.delete(leaveOk); window.removeEventListener('beforeunload', onUnload); });
    const showDiscount = computed(() => store.settings?.options?.ventes?.line_discounts !== false || (doc.value?.lines || []).some((l) => l.discount));
    // Mêmes règles de calcul que le serveur (totals.js) : l'écran affiche le montant qui sera enregistré et comptabilisé
    const totals = computed(() => computeTotals(doc.value?.lines));

    const addLine = (kind) => {
      const base = { kind, description: '', quantity: 1, unit_price: 0, discount: 0, tax_rate: s.default_tax, product_id: null, planned_hours: null };
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
      try {
        await act(() => PUT('/documents/' + doc.value.id, payload), silent ? null : 'Enregistré');
      } catch (e) {
        // Le mécanicien (kiosque), le client (suivi) ou un collègue a modifié le document pendant qu'il était ouvert ici
        if (e.status === 409 && confirm('Ce document a été modifié entre-temps par quelqu\'un d\'autre (atelier, client ou collègue).\n\nRecharger la dernière version ? Vos modifications non enregistrées seront perdues.')) { dirty.value = false; await load(); }
        throw e;
      }
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
      const cn = doc.value.type === 'credit_note';
      if (!confirm(`Valider définitivement ${cn ? 'la note de crédit' : 'la facture'} ? Elle ne pourra plus être modifiée (obligation légale).`)) return;
      const id = await ensureSaved();
      const r = await act(() => POST(`/documents/${id}/post`), cn ? 'Note de crédit validée' : 'Facture validée');
      toast(`Numéro attribué : ${r.number}`);
      await load();
    };
    const setStatus = async (status) => { await ensureSaved(); await act(() => POST(`/documents/${doc.value.id}/status`, { status })); await load(); };
    // Paiement saisi par erreur : un administrateur de la banque peut l'annuler (la facture redevient « à payer »)
    const canCancelPay = computed(() => can('banque', 'manager'));
    const cancelPay = async (p) => {
      if (!confirm(`Annuler le paiement de ${money(p.amount)} du ${date(p.date)} ? L'écriture comptable sera supprimée et la facture redeviendra « à payer ».`)) return;
      if (dirty.value) await save(true);
      await act(() => DEL('/payments/' + p.id), 'Paiement annulé'); await load();
    };
    // (notes internes en cours de saisie : enregistrées avant, pour ne pas être perdues au rechargement)
    const pay = async (p) => { if (dirty.value) await save(true); await act(() => POST(`/documents/${doc.value.id}/payments`, p), 'Paiement enregistré'); showPay.value = false; await load(); };
    // Le suivi en direct a changé (étape, accord du client…) : l'OR affiché se met à jour tant qu'aucune saisie n'est en cours
    const onLive = async () => {
      if (dirty.value || !doc.value?.id) return;
      const id = doc.value.id;
      const fresh = await GET('/documents/' + id);
      if (dirty.value || doc.value?.id !== id) return; // une saisie a commencé pendant la relecture : on ne l'écrase pas
      doc.value = fresh; takeTimes(fresh);
      await nextTick();
      dirty.value = false;
    };
    const remove = async () => { if (!confirm('Supprimer ce document ?')) return; await act(() => DEL('/documents/' + doc.value.id), 'Supprimé'); dirty.value = false; history.back(); };
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

    return { curMake, canClock, canClockHere, clockUser, runningOn, clock, work, pct, isWork, lineSpent, lineOver, linePlanned: plannedOf, plannedBad, tOf, times, onLive, canCancelPay, cancelPay, showDiscount, doc, vehicles, mechanics, isNew, locked, totals, lineTotal, addLine, pickProduct, move, onCustomer, onQuickCustomer, save, convert, post, setStatus, pay, remove, print,
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
        <button class="btn" v-if="!locked" @click="save()"><Icon name="save" class="ti"/> Enregistrer</button>
        <template v-if="doc.type==='quote' && !isNew">
          <button class="btn" v-if="doc.status==='draft'" @click="setStatus('sent')"><Icon name="send" class="ti"/> Marquer envoyé</button>
          <button class="btn" v-if="['draft','sent'].includes(doc.status)" @click="setStatus('refused')">Refusé</button>
          <button class="btn primary" @click="convert('order')"><Icon name="wrench" class="ti"/> Créer l'OR</button>
          <button class="btn" @click="convert('invoice')"><Icon name="receipt" class="ti"/> Facturer</button>
        </template>
        <template v-if="doc.type==='order' && !isNew && !locked">
          <select style="width:auto" :value="doc.status" @change="setStatus($event.target.value)">
            <option v-for="s in ['open','in_progress','waiting_parts','done']" :value="s">{{ STATUS[s][0] }}</option>
          </select>
          <button class="btn primary" @click="convert('invoice')"><Icon name="receipt" class="ti"/> Facturer</button>
        </template>
        <button class="btn success" v-if="['invoice','credit_note'].includes(doc.type) && doc.status==='draft' && !isNew" @click="post"><Icon name="check" class="ti"/> Valider</button>
        <button class="btn primary" v-if="['invoice','credit_note'].includes(doc.type) && ['posted','partial'].includes(doc.status)" @click="showPay = true"><Icon name="banknote" class="ti"/> {{ doc.type === 'credit_note' ? 'Rembourser' : 'Paiement' }}</button>
        <button class="btn" v-if="doc.type==='invoice' && doc.status!=='draft'" @click="convert('credit_note')"><Icon name="undo-2" class="ti"/> Note de crédit</button>
        <button class="btn" v-if="!isNew" @click="print"><Icon name="printer" class="ti"/> Imprimer / PDF</button>
        <button class="btn danger" v-if="!isNew && !locked" @click="remove" title="Supprimer" aria-label="Supprimer"><Icon name="trash-2" class="ti"/></button>
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
                <a class="btn" v-if="doc.customer_id" :href="'#/customer/' + doc.customer_id" title="Ouvrir la fiche du client" aria-label="Ouvrir la fiche du client"><Icon name="user" class="ti"/></a></div>
            </label>
            <label>Véhicule
              <div class="brand-field"><BrandLogo :make="curMake" :size="38"/><select v-model="doc.vehicle_id" :disabled="locked"><option :value="null">—</option><option v-for="v in vehicles" :value="v.id">{{ v.plate }} {{ v.make }} {{ v.model }}</option></select></div>
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
          <div class="table-wrap"><table class="lines" :class="{ 'no-disc': !showDiscount, 'with-time': doc.type === 'order' }">
            <thead><tr><th class="kind">Type</th><th>Désignation</th><th class="q num">Qté</th><th class="p num">P.U. HT</th><th class="d num dcol">Rem. %</th><th class="t">TVA</th><th class="num">Total HT</th><th v-if="doc.type==='order'" class="pl num" title="Temps prévu pour l'intervention, en heures (1,5 = 1 h 30). Vide = heures vendues de la main-d'œuvre.">Temps prévu (h)</th><th v-if="doc.type==='order'">Fait</th><th></th></tr></thead>
            <tbody>
              <tr v-for="(l, i) in doc.lines" :class="{'text-line': l.kind === 'text'}">
                <td><select v-model="l.kind" :disabled="locked"><option value="labor">M.O.</option><option value="part">Pièce</option><option value="fee">Forfait</option><option value="text">Texte</option></select></td>
                <td>
                  <div v-if="!locked && l.kind === 'part' && !l.description && !l._free" style="display:flex;gap:4px"><div style="flex:1"><Picker endpoint="/products" :label="productLabel" placeholder="Réf. ou nom de la pièce / forfait…" @pick="p => pickProduct(l, p)"/></div><button class="btn sm" title="Saisie libre (pièce hors stock)" @click="l._free = true; l.description = 'Pièce'">✎</button></div>
                  <input v-else class="descr" v-model="l.description" :disabled="locked">
                  <div class="stock-warn" v-if="l.kind==='part' && l.product_id && l.qty_on_hand !== undefined && l.qty_on_hand !== null && l.qty_on_hand < l.quantity && !locked"><Icon name="triangle-alert" class="ti"/> stock : {{ l.qty_on_hand }}</div>
                </td>
                <template v-if="l.kind !== 'text'">
                  <td><input v-model.number="l.quantity" type="number" step="0.1" class="right" :disabled="locked"></td>
                  <td><input v-model.number="l.unit_price" type="number" step="0.01" class="right" :disabled="locked"></td>
                  <td class="dcol"><input v-model.number="l.discount" type="number" class="right" :disabled="locked"></td>
                  <td><select v-model.number="l.tax_rate" :disabled="locked"><option v-for="r in TAX_RATES" :value="r">{{ r }}%</option></select></td>
                  <td class="num">{{ money(lineTotal(l)) }}</td>
                </template>
                <td v-else colspan="5"></td>
                <td v-if="doc.type==='order'" class="pl">
                  <div v-if="isWork(l)" class="wt-cell">
                    <input v-model="l.planned_hours" type="text" inputmode="decimal" autocomplete="off" class="right" :placeholder="l.kind === 'labor' && l.quantity > 0 ? l.quantity : '—'" :disabled="locked"
                      :title="l.kind === 'labor' ? 'Temps prévu, en heures (1,5 = 1 h 30). Vide = heures vendues.' : 'Temps prévu, en heures (1,5 = 1 h 30). Vide = pas de temps prévu.'">
                    <div v-if="plannedBad(l)" class="wt-under neg">nombre invalide</div>
                    <div v-else-if="lineSpent(l) > 0" class="wt-under" :class="{ neg: lineOver(l) }" :title="lineOver(l) ? 'Temps prévu dépassé' : 'Temps pointé / temps prévu'"><Icon name="timer" class="ti"/> {{ hours(lineSpent(l)) }}<template v-if="linePlanned(l)"> / {{ hours(linePlanned(l)) }}</template><span v-if="tOf(l).active" class="wt-dot"></span></div>
                    <div v-else-if="linePlanned(l)" class="wt-under" title="Temps prévu">= {{ hours(linePlanned(l)) }}</div>
                  </div>
                </td>
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
          <Teleport to="body"><button v-if="dirty && !locked" class="btn primary save-fab" @click="save()">Enregistrer</button></Teleport>
        </div>
        <LivePanel v-if="doc.type==='order' && !isNew && doc.id" :doc-id="doc.id" @changed="onLive"/>
        <div class="card" v-if="doc.type==='order' && !isNew && work">
          <h2>Temps atelier</h2>
          <div class="totals">
            <span class="muted">Temps prévu</span><b>{{ work.planned ? hours(work.planned) : '—' }}</b>
            <span class="muted">Temps pointé</span><b :class="work.over ? 'neg' : work.spent ? 'pos' : ''">{{ hours(work.spent) }}</b>
            <template v-if="work.unplanned > 0.005"><span class="muted small">dont sans temps prévu</span><span class="small">{{ hours(work.unplanned) }}</span></template>
            <template v-if="work.over"><span class="neg">Dépassement</span><b class="neg">+ {{ hours(work.overBy) }}</b></template>
            <template v-if="doc.hours_sold && Math.abs(doc.hours_sold - work.planned) > 0.005"><span class="muted">Heures vendues</span><span>{{ hours(doc.hours_sold) }}</span></template>
          </div>
          <div v-if="canClockHere && mechanics.length" class="wt-clock">
            <span class="muted small">Chrono pour</span>
            <select v-model.number="clockUser"><option v-for="m in mechanics" :key="m.id" :value="m.id">{{ m.name }}</option></select>
          </div>
          <div v-if="work.lines.length" class="wt-list">
            <div v-for="x in work.lines" class="wt-row" :class="{ over: x.over, done: x.l.done }">
              <div class="wt-head">
                <span class="wt-name" :title="x.l.description">{{ x.l.done ? '✓ ' : '' }}{{ x.l.description || 'Intervention' }}</span>
                <span class="wt-num">{{ hours(x.spent) }}<span class="muted"> / {{ x.planned ? hours(x.planned) : '—' }}</span></span>
                <template v-if="canClockHere && x.l.id && clockUser">
                  <button v-if="runningOn(x.t.worker_ids)" class="wt-go on" title="Mettre en pause le chrono du mécanicien choisi" @click="clock('stop', x.l.id)"><Icon name="pause" class="ti"/></button>
                  <button v-else class="wt-go" title="Démarrer le chrono du mécanicien choisi sur cette intervention" @click="clock('start', x.l.id)"><Icon name="play" class="ti"/></button>
                </template>
              </div>
              <div class="wt-bar"><i :style="{ width: pct(x.spent, x.planned) + '%' }"></i></div>
              <div v-if="x.t.active || x.over" class="wt-sub">
                <span v-if="x.t.active" class="live">{{ x.t.workers.join(', ') || 'en cours' }}</span><span v-else></span>
                <span v-if="x.over" class="neg">dépassé de {{ hours(x.spent - x.planned) }}</span>
              </div>
              <div v-if="x.t.auto" class="wt-sub warn"><Icon name="triangle-alert" class="ti"/> Chrono oublié, arrêté automatiquement : durée à vérifier dans « Feuilles de temps ».</div>
            </div>
            <div v-if="work.general > 0 || (canClockHere && clockUser)" class="wt-row">
              <div class="wt-head"><span class="wt-name muted">Autre travail sur l'OR</span><span class="wt-num">{{ hours(work.general) }}</span>
                <template v-if="canClockHere && clockUser">
                  <button v-if="runningOn(times.generalWorkerIds)" class="wt-go on" title="Mettre en pause" @click="clock('stop', null)"><Icon name="pause" class="ti"/></button>
                  <button v-else class="wt-go" title="Démarrer le chrono sans intervention précise" @click="clock('start', null)"><Icon name="play" class="ti"/></button>
                </template>
              </div>
              <div v-if="times.generalActive" class="wt-sub"><span class="live">{{ times.generalWorkers.join(', ') }}</span></div>
              <div v-if="times.generalAuto" class="wt-sub warn"><Icon name="triangle-alert" class="ti"/> Chrono oublié, arrêté automatiquement : durée à vérifier.</div>
            </div>
          </div>
          <template v-else>
            <div v-if="canClockHere && clockUser" class="wt-list"><div class="wt-row">
              <div class="wt-head"><span class="wt-name muted">Travail sur l'OR</span><span class="wt-num">{{ hours(work.general) }}</span>
                <button v-if="runningOn(times.generalWorkerIds)" class="wt-go on" title="Mettre en pause" @click="clock('stop', null)"><Icon name="pause" class="ti"/></button>
                <button v-else class="wt-go" title="Démarrer le chrono sur cet OR" @click="clock('start', null)"><Icon name="play" class="ti"/></button>
              </div>
              <div v-if="times.generalActive" class="wt-sub"><span class="live">{{ times.generalWorkers.join(', ') }}</span></div>
            </div></div>
            <p class="muted small" style="margin:10px 0 0">Ajoutez une ligne de main-d'œuvre ou un forfait et indiquez son temps prévu : le chrono se lance dessus (ici ou à la tablette), et le temps passe en rouge s'il est dépassé.</p>
          </template>
          <details v-if="times.entries.length" class="wt-details">
            <summary>Détail des pointages ({{ times.entries.length }})</summary>
            <div v-for="t in times.entries" class="list-item small">
              <span>{{ t.user_name }}<span v-if="t.line_description" class="muted"> · {{ t.line_description }}</span><span v-if="t.auto" class="warn"> · arrêt automatique</span></span>
              <span class="muted nowrap">{{ datetime(t.start) }}</span>
              <span v-if="t.end" class="nowrap">{{ hours(t.hours) }}</span><span v-else class="live">en cours</span>
            </div>
          </details>
        </div>
        <div class="card" v-if="doc.payments && doc.payments.length">
          <h2>Paiements</h2>
          <div v-for="p in doc.payments" class="list-item small"><span>{{ date(p.date) }} · {{ METHODS[p.method] || p.method }}</span><span><b>{{ money(p.amount) }}</b> <button v-if="canCancelPay" class="icon-btn" title="Annuler ce paiement (saisi par erreur)" @click="cancelPay(p)"><Icon name="undo-2" class="ti"/></button></span></div>
        </div>
        <div class="card" v-if="doc.vehicle_id">
          <a :href="'#/vehicle/' + doc.vehicle_id"><Icon name="car" class="ti"/> Historique du véhicule →</a>
        </div>
      </div>
    </div>

    <!-- Version imprimable (mise en page choisie dans Paramètres → Mise en page) -->
    <div class="print-only"><DocPrint :doc="doc"/></div>

    <QuickCustomer v-if="showCustomer" @close="showCustomer = false" @saved="onQuickCustomer"/>
    <PaymentModal v-if="showPay" :residual="Math.round((doc.total - doc.amount_paid) * 100) / 100" :title="doc.type === 'credit_note' ? 'Remboursement au client' : 'Encaissement'" @close="showPay = false" @save="pay"/>
  </div>`,
};
