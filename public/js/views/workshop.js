import { ref, reactive, computed, onMounted, onUnmounted } from 'vue';
import { GET, POST, PUT, DEL, act, money, date, time, hours, today, addDays, STATUS, store } from '../api.js';
import { go } from '../router.js';

const COLS = [
  ['open', 'À faire', '#94a3b8'], ['in_progress', 'En cours', '#3b82f6'], ['waiting_parts', 'Attente pièces', '#f59e0b'], ['done', 'Terminé — à facturer', '#16a34a'],
];

const STAGE_KEYS = ['received', 'diagnosis', 'approval', 'parts', 'repair', 'quality', 'ready'];
const STAGE_LABEL = { received: 'Véhicule reçu', diagnosis: 'Diagnostic', approval: 'Accord client', parts: 'Pièces', repair: 'Réparation', quality: 'Contrôle qualité', ready: 'Prêt' };

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
    const moveTo = async (o, status) => { dragged = o; await drop(status); };
    const isLate = (o) => o.promised_at && new Date(o.promised_at) < new Date() && o.status !== 'done';
    // Temps pointé au-delà du temps prévu : affiché en rouge sur la fiche
    // (le temps pointé sur des interventions sans temps prévu n'est pas comparé)
    const timeOver = (o) => o.hours_planned > 0 && (o.hours_spent || 0) - (o.hours_unplanned || 0) - o.hours_planned > 1 / 120;
    return { timeOver, moveTo, STAGE_KEYS, STAGE_LABEL, COLS, byCol, over, drop, go, money, date, time, hours, isLate, mech, mechanics, setDrag: (o) => { dragged = o; } };
  },
  template: `
  <div>
    <div class="page-head">
      <div><h1>Atelier</h1><div class="sub">Glissez les fiches d'une colonne à l'autre (sur tablette : menu ➜ sur chaque fiche). Les mécaniciens pointent depuis le kiosque.</div></div>
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
            <span :class="isLate(o) ? 'late' : 'muted'" v-if="o.promised_at"><Icon name="alarm-clock" class="ti"/> {{ date(o.promised_at) }} {{ time(o.promised_at) }}</span>
          </div>
          <div class="row small muted" style="margin-top:4px">
            <span v-if="o.hours_spent || o.hours_planned" :class="{ 'wt-over': timeOver(o) }" :title="timeOver(o) ? 'Temps prévu dépassé' : 'Temps pointé / temps prévu'"><Icon name="timer" class="ti"/> {{ hours(o.hours_spent) }}<template v-if="o.hours_planned"> / {{ hours(o.hours_planned) }}</template></span><span v-else></span>
            <span>{{ money(o.total) }}</span>
          </div>
          <div class="mini-gauge" :title="STAGE_LABEL[o.stage || 'received']"><div :style="{width: (100 * STAGE_KEYS.indexOf(o.stage || 'received') / 6) + '%'}"></div></div>
          <div class="small muted">{{ STAGE_LABEL[o.stage || 'received'] }}</div>
          <select class="touch-move" :value="o.status" @click.stop @change="moveTo(o, $event.target.value)"><option v-for="[k, label] in COLS" :value="k">➜ {{ label }}</option></select>
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
    const narrow = window.matchMedia('(max-width: 800px)').matches;
    if (narrow) week.value = today();
    // Lundi à samedi ; le dimanche s'ajoute quand il porte un rendez-vous (sinon celui-ci serait introuvable)
    const days = computed(() => Array.from({ length: narrow ? 1 : appts.value.some((a) => a.start.slice(0, 10) === addDays(week.value, 6)) ? 7 : 6 }, (_, i) => addDays(week.value, i)));
    // Heures affichées : 7 h – 19 h, élargies si un rendez-vous commence plus tôt ou finit plus tard
    const hourOf = (v) => { const d = new Date(v); return d.getHours() + d.getMinutes() / 60; };
    const startH = computed(() => Math.min(START_H, ...appts.value.map((a) => Math.floor(hourOf(a.start)))));
    const endH = computed(() => Math.max(END_H, ...appts.value.map((a) => (a.end.slice(0, 10) > a.start.slice(0, 10) ? 24 : Math.ceil(hourOf(a.end))))));
    const load = async () => { appts.value = await GET(`/appointments?from=${week.value}&to=${addDays(week.value, narrow ? 0 : 6)}`); };
    onMounted(async () => { mechanics.value = (await GET('/users')).filter((u) => u.role === 'mechanic' && u.active); load(); });
    const shift = (n) => { week.value = addDays(week.value, n * (narrow ? 1 : 7)); load(); };
    const mailAppt = ref(null);
    const thisWeek = () => { week.value = narrow ? today() : monday(today()); load(); };
    const pos = (a) => {
      const s = new Date(a.start), e = new Date(a.end);
      const top = ((s.getHours() + s.getMinutes() / 60) - startH.value) * SLOT;
      const h = Math.max(22, ((e - s) / 3.6e6) * SLOT - 2);
      return { top: top + 'px', height: h + 'px', background: a.mechanic_color || '#2563eb' };
    };
    const dayAppts = (d) => appts.value.filter((a) => a.start.slice(0, 10) === d);
    // Rendez-vous qui se chevauchent : affichés côte à côte (ils se recouvraient, le premier devenait invisible)
    const dayLayout = (d) => {
      const list = dayAppts(d).map((a) => { const st = +new Date(a.start); return { a, s: st, e: Math.max(+new Date(a.end), st + 25 * 60000) }; }).sort((x, y) => x.s - y.s || x.e - y.e);
      const out = [];
      let group = [], groupEnd = -Infinity;
      const flush = () => {
        const cols = Math.max(...group.map((g) => g.col)) + 1;
        for (const g of group) out.push({ a: g.a, style: { ...pos(g.a), left: `calc(${(g.col / cols) * 100}% + 2px)`, width: `calc(${100 / cols}% - 4px)`, right: 'auto' } });
        group = []; groupEnd = -Infinity;
      };
      for (const it of list) {
        if (group.length && it.s >= groupEnd) flush();
        const used = new Set(group.filter((g) => g.e > it.s).map((g) => g.col));
        it.col = 0; while (used.has(it.col)) it.col++;
        group.push(it); groupEnd = Math.max(groupEnd, it.e);
      }
      if (group.length) flush();
      return out;
    };
    const newAt = (d, h) => {
      const pad = (n) => String(n).padStart(2, '0');
      // durée par défaut des rendez-vous (Configuration → Rendez-vous), 1 heure sinon
      const min = Math.max(15, Number(store.settings?.options?.rendez_vous?.default_duration) || 60);
      const end = new Date(new Date(`${d}T${pad(h)}:00`).getTime() + min * 60000);
      edit.value = { start: `${d}T${pad(h)}:00`, end: `${d}T${pad(end.getHours())}:${pad(end.getMinutes())}`, title: '', customer_id: null, vehicle_id: null, mechanic_id: null, status: 'planned', customer_name: '', vehicles: [] };
    };
    const open = async (a) => {
      edit.value = { ...a, start: a.start.slice(0, 16), end: a.end.slice(0, 16), vehicles: a.customer_id ? (await GET('/customers/' + a.customer_id)).vehicles : [] };
    };
    const onCustomer = async (c) => { edit.value.vehicles = c ? (await GET('/customers/' + c.id)).vehicles : []; edit.value.vehicle_id = edit.value.vehicles[0]?.id || null; };
    const save = async () => {
      const { vehicles, ...a } = edit.value;
      let id = a.id;
      if (a.id) await act(() => PUT('/appointments/' + a.id, a), 'Rendez-vous modifié');
      else id = (await act(() => POST('/appointments', a), 'Rendez-vous créé')).id;
      edit.value = null; load();
      return id;
    };
    const remove = async () => { if (!confirm('Supprimer ce rendez-vous ?')) return; await act(() => DEL('/appointments/' + edit.value.id), 'Rendez-vous supprimé'); edit.value = null; load(); };
    const arrive = async () => {
      // Rendez-vous pas encore enregistré : on l'enregistre d'abord (la fenêtre se ferme), puis on crée l'OR
      // le rendez-vous est d'abord enregistré avec ce qui vient d'être saisi (la fenêtre se ferme), puis l'OR est créé
      const id = await save();
      const r = await act(() => POST(`/appointments/${id}/order`), 'OR créé');
      go('/document/' + r.id);
    };
    const hoursList = computed(() => Array.from({ length: endH.value - startH.value }, (_, i) => startH.value + i));
    return { dayLayout, narrow, mailAppt, go, thisWeek, week, days, appts, mechanics, edit, shift, pos, dayAppts, newAt, open, onCustomer, save, remove, arrive, hoursList, date, time, today };
  },
  template: `
  <div>
    <div class="page-head">
      <div><h1>Planning atelier</h1><div class="sub">{{ narrow ? new Date(week + 'T12:00').toLocaleDateString('fr-LU', {weekday: 'long', day: 'numeric', month: 'long'}) : 'Semaine du ' + date(week) }} — touchez un créneau pour ajouter un rendez-vous</div></div>
      <div class="btns"><ModuleTools module="planning"/><button class="btn" @click="shift(-1)">←</button><button class="btn" @click="thisWeek">{{ narrow ? "Aujourd'hui" : 'Cette semaine' }}</button><button class="btn" @click="shift(1)">→</button></div>
    </div>
    <div class="table-wrap">
    <div class="planning" :style="{'--days': days.length}">
      <div class="pl-head"></div>
      <div v-for="d in days" class="pl-head" :class="{today: d === today()}">{{ new Date(d + 'T12:00').toLocaleDateString('fr-LU', {weekday: 'short', day: 'numeric', month: 'short'}) }}</div>
      <div class="pl-hours"><div v-for="h in hoursList" class="pl-hour">{{ h }}:00</div></div>
      <div v-for="d in days" class="pl-day">
        <div v-for="h in hoursList" class="pl-slot" @click="newAt(d, h)"></div>
        <div v-for="{ a, style } in dayLayout(d)" :key="a.id" class="pl-event" :style="style" @click.stop="open(a)">
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
        <button v-if="edit.id && edit.customer_id" class="btn" @click="mailAppt = edit.id" title="Envoyer un e-mail" aria-label="Envoyer un e-mail"><Icon name="mail" class="ti"/></button>
        <button v-if="edit.document_id" class="btn" @click="go('/document/' + edit.document_id)">Voir l'OR</button>
        <button v-else-if="edit.customer_id" class="btn" @click="arrive"><Icon name="car" class="ti"/> Véhicule arrivé → OR</button>
        <button class="btn primary" @click="save">Enregistrer</button>
      </template>
    </Modal>
    <MailComposer v-if="mailAppt" model="appointment" :record-id="mailAppt" @close="mailAppt = null"/>
  </div>`,
};
