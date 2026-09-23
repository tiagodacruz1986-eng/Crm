// Kiosque de pointage atelier (tablette) : les mécaniciens se connectent avec leur PIN
// et pointent présence + temps passé sur chaque ordre de réparation.
import { createApp, ref, reactive, computed, onMounted, onUnmounted } from 'vue';

const IDLE_LOGOUT_MS = 90_000;

const App = {
  setup() {
    const users = ref([]);
    const who = ref(null);
    const pin = ref('');
    const err = ref('');
    const token = ref(null);
    const st = ref(null);
    const now = ref(Date.now());
    const open = ref(null);
    const drafts = reactive({});
    let idle, clock;

    const call = async (method, url, body) => {
      const r = await fetch('/api' + url, {
        method, headers: { 'Content-Type': 'application/json', ...(token.value ? { Authorization: 'Bearer ' + token.value } : {}) },
        body: body ? JSON.stringify(body) : undefined,
      });
      const d = await r.json().catch(() => ({}));
      if (r.status === 401 && token.value) logout();
      if (!r.ok) throw new Error(d.error || 'Erreur');
      return d;
    };
    const bump = () => { clearTimeout(idle); if (token.value) idle = setTimeout(logout, IDLE_LOGOUT_MS); };
    const logout = () => { token.value = null; who.value = null; st.value = null; pin.value = ''; open.value = null; loadUsers(); };
    const loadUsers = async () => { users.value = await call('GET', '/kiosk/users'); };
    onMounted(() => {
      loadUsers();
      clock = setInterval(() => { now.value = Date.now(); }, 1000);
      ['pointerdown', 'keydown'].forEach((e) => window.addEventListener(e, bump));
    });
    onUnmounted(() => clearInterval(clock));

    const press = async (k) => {
      err.value = '';
      if (k === '⌫') { pin.value = pin.value.slice(0, -1); return; }
      if (k === 'OK') return login();
      if (pin.value.length < 6) pin.value += k;
      if (pin.value.length === 6) login();
    };
    const login = async () => {
      try {
        const r = await call('POST', '/kiosk/login', { user_id: who.value.id, pin: pin.value });
        token.value = r.token;
        st.value = await call('GET', '/kiosk/state');
        bump();
      } catch (e) { err.value = e.message; pin.value = ''; }
    };
    const act = async (fn) => { try { st.value = await fn(); err.value = ''; } catch (e) { err.value = e.message; } };
    const clockAction = (action, document_id) => act(() => call('POST', '/kiosk/clock', { action, document_id }));
    const updateOrder = (o, body) => act(() => call('POST', `/kiosk/orders/${o.id}`, body));
    const toggleLine = (o, l) => updateOrder(o, { line_id: l.id, done: !l.done });
    const saveNotes = async (o) => {
      const d = drafts[o.id] || {};
      await updateOrder(o, { diagnosis: d.diagnosis ?? o.diagnosis, note: d.note || undefined, mileage: d.mileage || undefined });
      drafts[o.id] = {};
    };
    const draft = (o) => (drafts[o.id] ||= { diagnosis: o.diagnosis || '', note: '', mileage: null });

    const elapsed = computed(() => {
      if (!st.value?.work) return '';
      const s = Math.max(0, Math.floor((now.value - new Date(st.value.work.start)) / 1000));
      return `${String(Math.floor(s / 3600)).padStart(2, '0')}:${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
    });
    const timeStr = computed(() => new Date(now.value).toLocaleTimeString('fr-LU', { hour: '2-digit', minute: '2-digit' }));
    const h = (x) => { const m = Math.round((x || 0) * 60); return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}`; };
    return { users, who, pin, err, token, st, press, logout, clockAction, updateOrder, toggleLine, saveNotes, draft, open, elapsed, timeStr, h };
  },
  template: `
  <div class="k-wrap">
    <div class="k-top">
      <div><div class="k-clock">{{ timeStr }}</div><div class="k-muted">{{ new Date().toLocaleDateString('fr-LU', {weekday: 'long', day: 'numeric', month: 'long'}) }}</div></div>
      <button v-if="token" class="k-btn sm" @click="logout">🔒 Terminer ({{ who.name }})</button>
    </div>

    <template v-if="!who">
      <div class="k-title">👋 Qui êtes-vous ?</div>
      <div class="k-users">
        <div v-for="u in users" class="k-user" :style="{'--c': u.color}" @click="who = u"><div class="k-avatar" :style="{background: u.color}">{{ u.name[0] }}</div>{{ u.name }}</div>
      </div>
      <p v-if="!users.length" class="k-muted">Aucun mécanicien avec code PIN. Le gérant doit en créer dans Paramètres → Utilisateurs.</p>
    </template>

    <div v-else-if="!token" class="k-pin">
      <div class="k-avatar" :style="{background: who.color}">{{ who.name[0] }}</div>
      <div class="k-title">{{ who.name }}</div>
      <div>Entrez votre code PIN</div>
      <div class="k-dots"><span v-for="i in 4" :class="{on: pin.length >= i}"></span><span v-for="i in 2" v-show="pin.length > 4" :class="{on: pin.length >= i + 4}"></span></div>
      <div class="k-err">{{ err }}</div>
      <div class="k-pad"><button v-for="k in ['1','2','3','4','5','6','7','8','9','⌫','0','OK']" @click="press(k)">{{ k }}</button></div>
      <button class="k-btn sm" style="margin-top:20px" @click="who = null; pin = ''">← Retour</button>
    </div>

    <template v-else-if="st">
      <div class="k-status" :class="{working: st.work}">
        <div>
          <div v-if="!st.presence" style="font-size:20px">Vous n'êtes pas pointé(e).</div>
          <template v-else-if="st.work">
            <div class="k-muted">En cours sur</div>
            <div style="font-size:22px;font-weight:700">{{ st.work.number }} <span class="plate">{{ st.work.plate }}</span></div>
            <div class="k-timer">{{ elapsed }}</div>
          </template>
          <div v-else style="font-size:20px">✅ Présent(e) — choisissez un ordre de réparation ci-dessous</div>
          <div class="k-muted">Aujourd'hui : {{ h(st.todayHours) }} sur des OR</div>
        </div>
        <div class="k-actions" style="flex-direction:column">
          <button v-if="!st.presence" class="k-btn green" @click="clockAction('in')">▶ Pointer l'arrivée</button>
          <template v-else>
            <button v-if="st.work" class="k-btn orange" @click="clockAction('stop')">⏸ Pause / arrêter</button>
            <button class="k-btn red" @click="clockAction('out')">⏏ Pointer le départ</button>
          </template>
        </div>
      </div>
      <div class="k-err">{{ err }}</div>

      <div class="k-title" style="font-size:20px">🔧 Ordres de réparation</div>
      <div class="k-orders">
        <div v-for="o in st.orders" class="k-order" :class="{mine: o.mechanic_id === who.id, active: st.work && st.work.document_id === o.id}">
          <h3><span>{{ o.number }} <span class="plate">{{ o.plate }}</span></span><span class="k-muted">{{ h(o.hours_spent) }}</span></h3>
          <div class="k-muted">{{ o.make }} {{ o.model }} · {{ o.customer_name }} <span v-if="o.vin">· VIN {{ o.vin }}</span></div>
          <div class="complaint">{{ o.customer_complaint || 'Pas de description' }}</div>
          <div class="k-actions">
            <button v-if="!(st.work && st.work.document_id === o.id)" class="k-btn green sm" @click="clockAction('start', o.id)">▶ Démarrer</button>
            <button v-else class="k-btn orange sm" @click="clockAction('stop')">⏸ Pause</button>
            <button class="k-btn sm" @click="open = open === o.id ? null : o.id">{{ open === o.id ? '▲ Fermer' : '▼ Détails' }}</button>
          </div>
          <template v-if="open === o.id">
            <div v-for="l in o.lines" class="k-line" :class="{done: l.done}" @click="toggleLine(o, l)"><span class="box">{{ l.done ? '✓' : '' }}</span><span>{{ l.description }} <span class="k-muted" v-if="l.kind==='labor'">({{ l.quantity }} h)</span></span></div>
            <div style="display:flex;flex-direction:column;gap:8px;margin-top:10px">
              <textarea v-model="draft(o).diagnosis" placeholder="Diagnostic / constat…"></textarea>
              <input v-model="draft(o).note" placeholder="Note pour le bureau (pièce manquante, travaux supplémentaires…)">
              <input v-model.number="draft(o).mileage" type="number" placeholder="Kilométrage relevé">
              <button class="k-btn blue sm" @click="saveNotes(o)">💾 Enregistrer</button>
            </div>
            <div class="k-actions">
              <button class="k-btn orange sm" @click="updateOrder(o, {status: 'waiting_parts'})">📦 Attente pièces</button>
              <button class="k-btn green sm" @click="updateOrder(o, {status: 'done'})">✅ Travail terminé</button>
            </div>
          </template>
        </div>
      </div>
      <p v-if="!st.orders.length" class="k-muted">Aucun ordre de réparation ouvert.</p>
    </template>
  </div>`,
};

createApp(App).mount('#app');
