// CRM (inspiré d'Odoo) : pipeline en colonnes, création rapide, fiche opportunité, liste, perdues et analyse.
import { ref, reactive, computed, onMounted, watch } from 'vue';
import { GET, POST, PUT, DEL, act, toast, money, date } from '../api.js';
import { route, go } from '../router.js';
import { can } from '../apps.js';

const SOURCE_COLORS = { site: 'blue', telephone: 'green', social: 'purple', passage: 'orange', recommandation: 'teal', email: 'yellow', manuel: 'gray' };

export const Crm = {
  setup() {
    const view = ref(route.query.view || 'pipeline');
    const meta = ref(null);
    const leads = ref([]);
    const stats = ref(null);
    const q = ref('');
    const mine = ref(false);
    const edit = ref(null);
    const quick = reactive({ stage: null, name: '', contact_name: '', phone: '', expected_revenue: null });
    const lost = ref(null);
    const dragging = ref(null);
    const over = ref(null);
    const users = ref([]);
    const manager = computed(() => can('crm', 'manager'));

    const load = async () => {
      const status = view.value === 'lost' ? 'lost' : view.value === 'list' ? 'all' : 'open';
      const params = new URLSearchParams({ status });
      if (q.value.trim()) params.set('q', q.value.trim());
      [leads.value, stats.value] = await Promise.all([GET('/crm/leads?' + params), GET('/crm/stats')]);
    };
    onMounted(async () => {
      [meta.value, users.value] = await Promise.all([GET('/crm/meta'), GET('/users')]);
      await load();
      if (route.query.lead) open(Number(route.query.lead));
    });
    watch(() => route.query.view, (v) => { view.value = v || 'pipeline'; load(); });
    let t;
    watch([q, mine], () => { clearTimeout(t); t = setTimeout(load, 250); });

    const columns = computed(() => (meta.value?.stages || []).map((s) => {
      const items = leads.value.filter((l) => l.stage_id === s.id && (s.is_won ? l.status === 'won' : l.status === 'open'));
      return { ...s, items, total: items.reduce((a, l) => a + (l.expected_revenue || 0), 0) };
    }));

    // Glisser-déposer entre les étapes
    const onDrop = async (stage) => {
      const l = dragging.value;
      over.value = null; dragging.value = null;
      if (!l || l.stage_id === stage.id) return;
      l.stage_id = stage.id;
      await act(() => POST(`/crm/leads/${l.id}/move`, { stage_id: stage.id }), stage.is_won ? '🏆 Opportunité gagnée !' : null);
      load();
    };
    const moveTo = async (l, dir) => {
      const st = meta.value.stages;
      const i = st.findIndex((s) => s.id === l.stage_id);
      const next = st[i + dir];
      if (next) { dragging.value = l; await onDrop(next); }
    };

    const startQuick = (s) => Object.assign(quick, { stage: s.id, name: '', contact_name: '', phone: '', expected_revenue: null });
    const saveQuick = async () => {
      if (!quick.name.trim() && !quick.contact_name.trim()) return;
      const { id } = await act(() => POST('/crm/leads', { name: quick.name, contact_name: quick.contact_name, phone: quick.phone, expected_revenue: quick.expected_revenue || 0, source: 'telephone' }));
      if (quick.stage !== meta.value.stages[0].id) await POST(`/crm/leads/${id}/move`, { stage_id: quick.stage });
      quick.stage = null;
      load();
    };

    const open = async (id) => { edit.value = await GET('/crm/leads/' + id); };
    const create = () => { edit.value = { name: '', contact_name: '', email: '', phone: '', company: '', service: '', vehicle_plate: '', vehicle_desc: '', description: '', expected_revenue: 0, priority: 0, source: 'telephone', deadline: '' }; };
    const FIELDS = ['name', 'contact_name', 'email', 'phone', 'company', 'service', 'vehicle_plate', 'vehicle_desc', 'description', 'expected_revenue', 'probability', 'priority', 'source', 'user_id', 'deadline', 'stage_id', 'tags'];
    const save = async (close = true) => {
      const e = edit.value;
      const body = Object.fromEntries(FIELDS.filter((k) => e[k] !== undefined).map((k) => [k, e[k] === '' ? null : e[k]]));
      if (e.id) await act(() => PUT('/crm/leads/' + e.id, body), 'Opportunité enregistrée');
      else { const r = await act(() => POST('/crm/leads', body), 'Opportunité créée'); e.id = r.id; }
      if (close) edit.value = null; else edit.value = await GET('/crm/leads/' + e.id);
      load();
    };
    const won = async () => { await save(false); edit.value = await act(() => POST(`/crm/leads/${edit.value.id}/won`), '🏆 Bravo, opportunité gagnée !'); load(); };
    const askLost = () => { lost.value = { reason: meta.value.lost_reasons[0], other: '' }; };
    const confirmLost = async () => {
      const reason = lost.value.reason === 'Autre' && lost.value.other ? lost.value.other : lost.value.reason;
      edit.value = await act(() => POST(`/crm/leads/${edit.value.id}/lost`, { reason }), 'Opportunité marquée perdue');
      lost.value = null; load();
    };
    const restore = async (l) => { await act(() => POST(`/crm/leads/${l.id}/restore`), 'Opportunité restaurée'); if (edit.value) edit.value = await GET('/crm/leads/' + l.id); load(); };
    const quote = async () => {
      await save(false);
      const r = await act(() => POST(`/crm/leads/${edit.value.id}/quote`));
      go('/document/' + r.document_id);
    };
    const toCustomer = async () => {
      await save(false);
      const r = await act(() => POST(`/crm/leads/${edit.value.id}/customer`), 'Client créé');
      edit.value = await GET('/crm/leads/' + edit.value.id);
      return r;
    };
    const remove = async () => { if (!confirm('Supprimer cette opportunité ?')) return; await act(() => DEL('/crm/leads/' + edit.value.id), 'Supprimée'); edit.value = null; load(); };
    const setView = (v) => go('/crm' + (v === 'pipeline' ? '' : '?view=' + v));
    const stars = (n) => [1, 2, 3].map((i) => i <= (n || 0));
    const overdue = (d) => d && d < new Date().toISOString().slice(0, 10);
    return { view, setView, meta, leads, stats, q, mine, columns, edit, quick, lost, dragging, over, users, manager, onDrop, moveTo, startQuick, saveQuick, open, create, save, won, askLost, confirmLost, restore, quote, toCustomer, remove, stars, overdue, money, date, SOURCE_COLORS, can };
  },
  template: `
  <div v-if="meta">
    <div class="page-head">
      <div><h1>CRM</h1><div class="sub" v-if="stats">{{ stats.open }} opportunité(s) en cours · {{ money(stats.pipeline) }} en jeu · {{ money(stats.weighted) }} pondéré</div></div>
      <div class="btns">
        <div class="search-field" style="margin:0;min-width:220px"><Icon name="search"/><input v-model="q" placeholder="Rechercher nom, plaque, tél…"></div>
        <button class="btn primary" @click="create"><Icon name="plus"/> Nouvelle opportunité</button>
      </div>
    </div>
    <div class="tabs att-tabs">
      <button :class="{active: view === 'pipeline'}" @click="setView('pipeline')">Pipeline</button>
      <button :class="{active: view === 'list'}" @click="setView('list')">Liste</button>
      <button :class="{active: view === 'lost'}" @click="setView('lost')">Perdues</button>
      <button :class="{active: view === 'stats'}" @click="setView('stats')">Analyse</button>
    </div>

    <div v-if="view === 'pipeline'" class="crm-board">
      <div v-for="c in columns" :key="c.id" class="kcol crm-col" :class="{ drop: over === c.id, won: c.is_won }" @dragover.prevent="over = c.id" @dragleave="over = null" @drop="onDrop(c)">
        <div class="kcol-head"><span>{{ c.name }} <span class="muted small">{{ c.items.length }}</span></span><button class="icon-btn" title="Création rapide" @click="startQuick(c)"><Icon name="plus"/></button></div>
        <div class="crm-sum"><i :style="{ width: Math.min(100, c.probability) + '%' }"></i><span>{{ money(c.total) }}</span></div>
        <form v-if="quick.stage === c.id" class="kcard quick" @submit.prevent="saveQuick">
          <input v-model="quick.name" placeholder="Objet (ex. : pneus hiver Golf)" autofocus>
          <input v-model="quick.contact_name" placeholder="Client">
          <input v-model="quick.phone" placeholder="Téléphone">
          <input v-model.number="quick.expected_revenue" type="number" placeholder="Montant estimé €">
          <div class="btns"><button class="btn sm primary">Ajouter</button><button type="button" class="btn sm" @click="quick.stage = null">Annuler</button></div>
        </form>
        <div v-for="l in c.items" :key="l.id" class="kcard crm-card" draggable="true" :style="{ '--c': l.user_color || '#94a3b8' }" @dragstart="dragging = l" @click="open(l.id)">
          <div class="row"><b>{{ l.name }}</b><span class="prio"><Icon v-for="(on, i) in stars(l.priority)" :key="i" name="star" :class="{ on }"/></span></div>
          <div class="muted small">{{ l.contact_name || l.customer_name || l.company }}<span v-if="l.vehicle_plate"> · <span class="plate sm">{{ l.vehicle_plate }}</span></span></div>
          <div class="row" style="margin-top:8px">
            <b class="amount">{{ l.expected_revenue ? money(l.expected_revenue) : '' }}</b>
            <span class="row" style="gap:6px">
              <Badge :label="meta.sources[l.source] || l.source" :color="SOURCE_COLORS[l.source] || 'gray'"/>
              <span v-if="l.next_activity" class="act-dot" :class="{ late: overdue(l.next_activity) }" :title="'Activité le ' + date(l.next_activity)"><Icon name="clock"/></span>
              <span v-if="l.user_name" class="avatar" :style="{ background: l.user_color }" :title="l.user_name">{{ l.user_name[0] }}</span>
            </span>
          </div>
          <div class="touch-move"><button class="btn sm" @click.stop="moveTo(l, -1)">←</button> <button class="btn sm" @click.stop="moveTo(l, 1)">→</button></div>
        </div>
      </div>
    </div>

    <div v-else-if="view === 'list' || view === 'lost'" class="card">
      <table>
        <thead><tr><th>Opportunité</th><th>Client</th><th>Source</th><th>Étape</th><th class="num">Montant</th><th class="num">Proba.</th><th>Commercial</th><th v-if="view === 'lost'">Raison</th><th v-if="view === 'lost'"></th></tr></thead>
        <tbody><tr v-for="l in leads" :key="l.id" class="click" @click="open(l.id)">
          <td><b>{{ l.name }}</b><div class="muted small">{{ date(l.created_at) }}</div></td><td>{{ l.contact_name || l.customer_name }}<div class="muted small">{{ l.phone }} {{ l.email }}</div></td>
          <td><Badge :label="meta.sources[l.source]" :color="SOURCE_COLORS[l.source] || 'gray'"/></td>
          <td>{{ l.status === 'won' ? '🏆 Gagnée' : l.status === 'lost' ? 'Perdue' : (meta.stages.find(s => s.id === l.stage_id) || {}).name }}</td>
          <td class="num">{{ money(l.expected_revenue) }}</td><td class="num">{{ l.probability }} %</td><td>{{ l.user_name }}</td>
          <td v-if="view === 'lost'">{{ l.lost_reason }}</td><td v-if="view === 'lost'"><button class="btn sm" @click.stop="restore(l)"><Icon name="undo-2"/> Restaurer</button></td>
        </tr></tbody>
      </table>
      <Empty v-if="!leads.length" icon="🤝" :text="view === 'lost' ? 'Aucune opportunité perdue.' : 'Aucune opportunité.'"/>
    </div>

    <div v-else-if="view === 'stats' && stats" class="grid g3">
      <div class="kpi"><div class="l"><Icon name="kanban"/> En cours</div><div class="v">{{ stats.open }}</div><div class="muted small">{{ money(stats.pipeline) }} au total</div></div>
      <div class="kpi"><div class="l"><Icon name="chart-column"/> Chiffre pondéré</div><div class="v">{{ money(stats.weighted) }}</div><div class="muted small">montant × probabilité</div></div>
      <div class="kpi"><div class="l"><Icon name="trophy"/> Gagnées ce mois</div><div class="v">{{ stats.won_month }}</div><div class="muted small">{{ money(stats.won_revenue_month) }} · {{ stats.lost_month }} perdue(s)</div></div>
      <div class="card" style="grid-column: 1 / -1">
        <div class="card-head"><h2>Taux de réussite : {{ stats.win_rate === null ? '—' : stats.win_rate + ' %' }}</h2></div>
        <h3 class="sec-title">Par source</h3>
        <div v-for="s in stats.by_source" :key="s.source" class="src-row"><span>{{ s.label }}</span><div class="bar"><i :style="{ width: (s.n / Math.max(...stats.by_source.map(x => x.n)) * 100) + '%' }"></i></div><b>{{ s.n }}</b><span class="muted small">{{ s.won || 0 }} gagnée(s)</span></div>
        <Empty v-if="!stats.by_source.length" icon="📊" text="Pas encore de données."/>
      </div>
    </div>

    <Modal v-if="edit" :title="edit.id ? edit.name : 'Nouvelle opportunité'" wide @close="edit = null">
      <div v-if="edit.id" class="crm-stagebar">
        <button v-for="s in meta.stages" :key="s.id" :class="{ on: s.id === edit.stage_id && edit.status !== 'lost' }" @click="edit.stage_id = s.id; edit.probability = s.probability">{{ s.name }}</button>
      </div>
      <div v-if="edit.status === 'won'" class="ribbon won">🏆 GAGNÉE</div>
      <div v-if="edit.status === 'lost'" class="ribbon lost">PERDUE · {{ edit.lost_reason }}</div>
      <div class="form-grid">
        <label class="full">Opportunité<input v-model="edit.name" placeholder="Ex. : Distribution + pompe à eau Golf 7"></label>
        <label>Client / contact<input v-model="edit.contact_name"></label><label>Société<input v-model="edit.company"></label>
        <label>Téléphone<input v-model="edit.phone" inputmode="tel"></label><label>E-mail<input v-model="edit.email" type="email"></label>
        <label>Prestation<input v-model="edit.service" placeholder="Pneus, entretien, carrosserie…"></label><label>Plaque<input v-model="edit.vehicle_plate"></label>
        <label>Véhicule<input v-model="edit.vehicle_desc" placeholder="Marque, modèle"></label>
        <label>Montant estimé (€)<input type="number" v-model.number="edit.expected_revenue"></label>
        <label>Probabilité (%)<input type="number" min="0" max="100" v-model.number="edit.probability"></label>
        <label>Priorité<div class="prio big"><Icon v-for="i in 3" :key="i" name="star" :class="{ on: i <= edit.priority }" @click="edit.priority = edit.priority === i ? 0 : i"/></div></label>
        <label>Source<select v-model="edit.source"><option v-for="(l, k) in meta.sources" :value="k">{{ l }}</option></select></label>
        <label>Commercial<select v-model="edit.user_id"><option :value="null">—</option><option v-for="u in users.filter(x => x.active && x.role !== 'mechanic')" :value="u.id">{{ u.name }}</option></select></label>
        <label>Échéance<input type="date" v-model="edit.deadline"></label>
        <label class="full">Notes<textarea v-model="edit.description" rows="3"></textarea></label>
      </div>
      <p v-if="edit.customer_name || edit.quote_number" class="small">
        <span v-if="edit.customer_name">👤 Client : <a :href="'#/customer/' + edit.customer_id">{{ edit.customer_name }}</a></span>
        <span v-if="edit.quote_number"> · 📝 Devis : <a :href="'#/document/' + edit.quote_id">{{ edit.quote_number }}</a> ({{ money(edit.quote_total) }})</span>
      </p>
      <Chatter v-if="edit.id" model="lead" :record-id="edit.id" style="margin-top:12px"/>
      <template #foot>
        <template v-if="edit.id">
          <button v-if="edit.status === 'open'" class="btn won-btn" @click="won"><Icon name="trophy"/> Gagnée</button>
          <button v-if="edit.status === 'open'" class="btn" @click="askLost"><Icon name="thumbs-down"/> Perdue</button>
          <button v-if="edit.status !== 'open'" class="btn" @click="restore(edit)"><Icon name="undo-2"/> Restaurer</button>
          <button v-if="can('ventes', 'user')" class="btn" @click="quote"><Icon name="file-text"/> {{ edit.quote_id ? 'Voir le devis' : 'Nouveau devis' }}</button>
          <button v-if="!edit.customer_id && can('contacts', 'user')" class="btn" @click="toCustomer"><Icon name="user-plus"/> Créer le client</button>
          <button v-if="manager" class="btn danger" @click="remove">Supprimer</button>
        </template>
        <span style="flex:1"></span>
        <button class="btn" @click="edit = null">Fermer</button><button class="btn primary" @click="save()">Enregistrer</button>
      </template>
    </Modal>

    <Modal v-if="lost" title="Marquer comme perdue" @close="lost = null">
      <label>Raison<select v-model="lost.reason"><option v-for="r in meta.lost_reasons" :value="r">{{ r }}</option></select></label>
      <label v-if="lost.reason === 'Autre'">Précisez<input v-model="lost.other"></label>
      <template #foot><button class="btn" @click="lost = null">Annuler</button><button class="btn danger" @click="confirmLost">Marquer perdue</button></template>
    </Modal>
  </div>`,
};
