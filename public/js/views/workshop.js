import { ref, reactive, computed, onMounted, onUnmounted } from 'vue';
import { GET, POST, PUT, DEL, act, money, date, time, hours, today, addDays, STATUS } from '../api.js';
import { go } from '../router.js';

const COLS = [
  ['open', 'À faire', '#94a3b8'], ['in_progress', 'En cours', '#3b82f6'], ['waiting_parts', 'Attente pièces', '#f59e0b'], ['done', 'Terminé — à facturer', '#16a34a'],
];

const STAGE_KEYS = ['received', 'diagnosis', 'approval', 'parts', 'repair', 'quality', 'ready'];
const STAGE_LABEL = { received: '🚗 Véhicule reçu', diagnosis: '🔍 Diagnostic', approval: '✍️ Accord client', parts: '📦 Pièces', repair: '🔧 Réparation', quality: '✅ Contrôle qualité', ready: '🎉 Prêt' };

export const Workshop = {
  setup() {
    const orders = ref([]);
    const over = ref(null);
    const mech = ref('');
    const load = async () => { orders.value = await GET('/documents?type=order&status=open,in_progress,waiting_parts,done'); };
    let t;
    onMounted(() => { load(); t = setInterval(load, 20000); });
    onUnmounted(() => clearInterval(t));
    const byCol = computed(() => Object.fromEntries(COLS.map(([k]) => [k, orders.value.filter((o) => o.status === k && (!mech.value || String(o.mechanic_id) === mech.value))])));
    const mechanics = computed(() => [...new Map(orders.value.filter((o) => o.mechanic_id).map((o) => [o.mechanic_id, o.mechanic_name])).entries()]);
    let dragged = null;
    const drop = async (status) => {
      over.value = null;
      if (!dragged || dragged.status === status) return;
      const o = dragged;
      o.status = status;
      await act(() => POST(`/documents/${o.id}/status`, { status }));
      load();
    };
    const isLate = (o) => o.promised_at && new Date(o.promised_at) < new Date() && o.status !== 'done';
    return { STAGE_KEYS, STAGE_LABEL, COLS, byCol, over, drop, go, money, date, time, hours, isLate, mech, mechanics, setDrag: (o) => { dragged = o; } };
  },
  template: `
  <div>
    <div class="page-head">
      <div><h1>Atelier</h1><div class="sub">Glissez les fiches d'une colonne à l'autre. Les mécaniciens pointent depuis le kiosque.</div></div>
      <div class="btns">
        <ModuleTools module="atelier"/>
        <select v-model="mech" style="width:auto"><option value="">Tous les mécaniciens</option><option v-for="[id, n] in mechanics" :value="String(id)">{{ n }}</option></select>
        <a class="btn" href="#/documents/order">Liste des OR</a>
        <a class="btn primary" href="#/new/order">+ Nouvel OR</a>
      </div>
    </div>
    <div class="kanban">
      <div v-for="[k, label, color] in COLS" class="kcol" :class="{drop: over === k}" @dragover.prevent="over = k" @dragleave="over = null" @drop="drop(k)">
        <div class="kcol-head"><span>{{ label }}</span><span class="badge b-gray">{{ byCol[k].length }}</span></div>
        <div v-for="o in byCol[k]" class="kcard" :style="{'--c': o.mechanic_color || color}" draggable="true" @dragstart="setDrag(o)" @click="go('/document/' + o.id)">
          <div class="row"><b>{{ o.number }}</b><span class="plate" v-if="o.plate">{{ o.plate }}</span></div>
          <div class="small">{{ o.make }} {{ o.model }} · {{ o.customer_name }}</div>
          <div class="desc">{{ o.customer_complaint || '—' }}</div>
          <div class="row small">
            <span v-if="o.active_workers" class="live">{{ o.mechanic_name || 'en cours' }}</span>
            <span v-else class="muted">{{ o.mechanic_name || 'non assigné' }}</span>
            <span :class="isLate(o) ? 'late' : 'muted'" v-if="o.promised_at">⏰ {{ date(o.promised_at) }} {{ time(o.promised_at) }}</span>
          </div>
          <div class="row small muted" style="margin-top:4px"><span>{{ o.hours_sold ? hours(o.hours_sold) + ' vendues' : '' }}</span><span>{{ money(o.total) }}</span></div>
          <div class="mini-gauge" :title="STAGE_LABEL[o.stage || 'received']"><div :style="{width: (100 * STAGE_KEYS.indexOf(o.stage || 'received') / 6) + '%'}"></div></div>
          <div class="small muted">{{ STAGE_LABEL[o.stage || 'received'] }}</div>
        </div>
      </div>
    </div>
  </div>`,
};

// ---------- Planning hebdomadaire ----------
const START_H = 7, END_H = 19, SLOT = 48;
function monday(d) { const x = new Date(d + 'T12:00:00'); const day = (x.getDay() + 6) % 7; return addDays(d, -day); }

export const Planning = {
  setup() {
    const week = ref(monday(today()));
    const appts = ref([]);
    const mechanics = ref([]);
    const edit = ref(null);
    const days = computed(() => Array.from({ length: 6 }, (_, i) => addDays(week.value, i)));
    const load = async () => { appts.value = await GET(`/appointments?from=${week.value}&to=${addDays(week.value, 6)}`); };
    onMounted(async () => { mechanics.value = (await GET('/users')).filter((u) => u.role === 'mechanic' && u.active); load(); });
    const shift = (n) => { week.value = addDays(week.value, n * 7); load(); };
    const mailAppt = ref(null);
    const thisWeek = () => { week.value = monday(today()); load(); };
    const pos = (a) => {
      const s = new Date(a.start), e = new Date(a.end);
      const top = ((s.getHours() + s.getMinutes() / 60) - START_H) * SLOT;
      const h = Math.max(22, ((e - s) / 3.6e6) * SLOT - 2);
      return { top: top + 'px', height: h + 'px', background: a.mechanic_color || '#2563eb' };
    };
    const dayAppts = (d) => appts.value.filter((a) => a.start.slice(0, 10) === d);
    const newAt = (d, h) => {
      const pad = (n) => String(n).padStart(2, '0');
      edit.value = { start: `${d}T${pad(h)}:00`, end: `${d}T${pad(h + 1)}:00`, title: '', customer_id: null, vehicle_id: null, mechanic_id: null, status: 'planned', customer_name: '', vehicles: [] };
    };
    const open = async (a) => {
      edit.value = { ...a, start: a.start.slice(0, 16), end: a.end.slice(0, 16), vehicles: a.customer_id ? (await GET('/customers/' + a.customer_id)).vehicles : [] };
    };
    const onCustomer = async (c) => { edit.value.vehicles = c ? (await GET('/customers/' + c.id)).vehicles : []; edit.value.vehicle_id = edit.value.vehicles[0]?.id || null; };
    const save = async () => {
      const { vehicles, ...a } = edit.value;
      if (a.id) await act(() => PUT('/appointments/' + a.id, a), 'Rendez-vous modifié');
      else await act(() => POST('/appointments', a), 'Rendez-vous créé');
      edit.value = null; load();
    };
    const remove = async () => { await act(() => DEL('/appointments/' + edit.value.id)); edit.value = null; load(); };
    const arrive = async () => {
      if (!edit.value.id) await save();
      const r = await act(() => POST(`/appointments/${edit.value.id}/order`), 'OR créé');
      go('/document/' + r.id);
    };
    const hoursList = Array.from({ length: END_H - START_H }, (_, i) => START_H + i);
    return { mailAppt, go, thisWeek, week, days, appts, mechanics, edit, shift, pos, dayAppts, newAt, open, onCustomer, save, remove, arrive, hoursList, date, time, today };
  },
  template: `
  <div>
    <div class="page-head">
      <div><h1>Planning atelier</h1><div class="sub">Semaine du {{ date(week) }} — cliquez sur un créneau pour ajouter un rendez-vous</div></div>
      <div class="btns"><ModuleTools module="planning"/><button class="btn" @click="shift(-1)">←</button><button class="btn" @click="thisWeek">Cette semaine</button><button class="btn" @click="shift(1)">→</button></div>
    </div>
    <div class="table-wrap">
    <div class="planning" style="--days: 6">
      <div class="pl-head"></div>
      <div v-for="d in days" class="pl-head" :class="{today: d === today()}">{{ new Date(d + 'T12:00').toLocaleDateString('fr-LU', {weekday: 'short', day: 'numeric', month: 'short'}) }}</div>
      <div class="pl-hours"><div v-for="h in hoursList" class="pl-hour">{{ h }}:00</div></div>
      <div v-for="d in days" class="pl-day">
        <div v-for="h in hoursList" class="pl-slot" @click="newAt(d, h)"></div>
        <div v-for="a in dayAppts(d)" class="pl-event" :style="pos(a)" @click.stop="open(a)">
          <b>{{ time(a.start) }}</b> {{ a.plate }} · {{ a.customer_name }}<br>{{ a.title }}<span v-if="a.document_number"> · {{ a.document_number }}</span>
        </div>
      </div>
    </div>
    </div>
    <Modal v-if="edit" :title="edit.id ? 'Rendez-vous' : 'Nouveau rendez-vous'" @close="edit = null">
      <label>Client<Picker v-model="edit.customer_id" endpoint="/customers" :initial="edit.customer_name" :label="c => c.name + (c.phone ? ' · ' + c.phone : '')" @pick="onCustomer"/></label>
      <div class="form-grid">
        <label>Véhicule<select v-model="edit.vehicle_id"><option :value="null">—</option><option v-for="v in edit.vehicles" :value="v.id">{{ v.plate }} {{ v.make }} {{ v.model }}</option></select></label>
        <label>Mécanicien<select v-model="edit.mechanic_id"><option :value="null">—</option><option v-for="m in mechanics" :value="m.id">{{ m.name }}</option></select></label>
        <label>Début<input type="datetime-local" v-model="edit.start"></label>
        <label>Fin<input type="datetime-local" v-model="edit.end"></label>
      </div>
      <label>Motif<input v-model="edit.title" placeholder="Entretien, pneus, diagnostic…"></label>
      <label>Notes<textarea v-model="edit.notes"></textarea></label>
      <label class="check"><input type="checkbox" :checked="!!edit.courtesy_car" @change="edit.courtesy_car = $event.target.checked ? 1 : 0"> Véhicule de courtoisie</label>
      <template #foot>
        <button v-if="edit.id" class="btn danger" @click="remove" style="margin-right:auto">Supprimer</button>
        <button v-if="edit.id && edit.customer_id" class="btn" @click="mailAppt = edit.id">✉️</button>
        <button v-if="edit.document_id" class="btn" @click="go('/document/' + edit.document_id)">Voir l'OR</button>
        <button v-else-if="edit.customer_id" class="btn" @click="arrive">🚗 Véhicule arrivé → OR</button>
        <button class="btn primary" @click="save">Enregistrer</button>
      </template>
    </Modal>
    <MailComposer v-if="mailAppt" model="appointment" :record-id="mailAppt" @close="mailAppt = null"/>
  </div>`,
};
