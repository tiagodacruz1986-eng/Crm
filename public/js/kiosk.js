// Kiosque de pointage atelier (tablette) : les mécaniciens se connectent avec leur PIN
// et pointent présence + temps passé sur chaque ordre de réparation.
import { createApp, ref, reactive, computed, onMounted, onUnmounted } from 'vue';

const IDLE_LOGOUT_MS = 90_000;

const App = {
  setup() {
    const info = ref({ users: [], company: '', logo: null, pin: true, badge: true });
    const who = ref(null);
    const pin = ref('');
    const err = ref('');
    const token = ref(null);
    const st = ref(null);
    const now = ref(Date.now());
    const open = ref(null);
    const q = ref('');
    const greet = ref(null);
    const drafts = reactive({});
    let idle, clock, greetT;

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
    const bump = () => { clearTimeout(idle); if (token.value || who.value) idle = setTimeout(logout, IDLE_LOGOUT_MS); };
    const logout = () => { token.value = null; who.value = null; st.value = null; pin.value = ''; open.value = null; err.value = ''; q.value = ''; loadUsers(); };
    const loadUsers = async () => { try { info.value = await call('GET', '/kiosk/users'); } catch { /* hors ligne */ } };

    // Lecteur de badge : les caractères arrivent très vite puis « Entrée »
    let buf = '', lastKey = 0;
    const onKey = async (e) => {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || token.value) return;
      const t = Date.now();
      if (t - lastKey > 80) buf = '';
      lastKey = t;
      if (e.key === 'Enter') {
        if (buf.length >= 3 && info.value.badge) {
          const code = buf; buf = '';
          try { showGreeting(await call('POST', '/kiosk/badge', { badge: code })); loadUsers(); } catch (ex) { err.value = ex.message; setTimeout(() => { err.value = ''; }, 3000); }
        }
        buf = '';
      } else if (e.key.length === 1) buf += e.key;
    };
    onMounted(() => {
      loadUsers();
      clock = setInterval(() => { now.value = Date.now(); }, 1000);
      ['pointerdown', 'keydown'].forEach((e) => window.addEventListener(e, bump));
      window.addEventListener('keydown', onKey);
      setInterval(() => { if (!who.value) loadUsers(); }, 30_000);
    });
    onUnmounted(() => { clearInterval(clock); window.removeEventListener('keydown', onKey); });

    const people = computed(() => {
      const s = q.value.trim().toLowerCase();
      return info.value.users.filter((u) => !s || u.name.toLowerCase().includes(s));
    });
    const pick = (u) => {
      who.value = u; pin.value = ''; err.value = '';
      if (!info.value.pin && u.role === 'mechanic') login();
      bump();
    };
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
    const showGreeting = (r) => {
      const first = (r.user?.name || '').split(' ')[0];
      const h = new Date().getHours();
      greet.value = r.action === 'in'
        ? { cls: 'in', title: `${h < 12 ? 'Bonjour' : h < 18 ? 'Bon après-midi' : 'Bonsoir'} ${first} !`, sub: `Arrivée enregistrée à ${r.at.slice(11, 16)}`, extra: 'Bonne journée ☀️' }
        : { cls: 'out', title: `Au revoir ${first} !`, sub: `Départ enregistré à ${r.at.slice(11, 16)}`, extra: `${hm(r.today_hours)} travaillées aujourd'hui · bonne soirée 👋` };
      clearTimeout(greetT);
      greetT = setTimeout(() => { greet.value = null; }, 4000);
    };
    // Gros bouton Arrivée / Départ
    const attend = async () => {
      try {
        const r = await call('POST', '/kiosk/attendance', {});
        showGreeting(r);
        st.value = await call('GET', '/kiosk/state');
        // Au départ, ou pour le bureau : retour à l'écran d'accueil ; un mécanicien arrivé reste pour ses OR
        if (r.action === 'out' || !st.value.show_orders) setTimeout(logout, 400);
      } catch (e) { err.value = e.message; }
    };
    const act = async (fn) => { try { const r = await fn(); st.value = { ...st.value, ...r }; err.value = ''; } catch (e) { err.value = e.message; } };
    const clockAction = (action, document_id) => act(() => call('POST', '/kiosk/clock', { action, document_id }));
    const updateOrder = (o, body) => act(() => call('POST', `/kiosk/orders/${o.id}`, body));
    const toggleLine = (o, l) => updateOrder(o, { line_id: l.id, done: !l.done });
    const saveNotes = async (o) => {
      const d = drafts[o.id] || {};
      await updateOrder(o, { diagnosis: d.diagnosis ?? o.diagnosis, note: d.note || undefined, mileage: d.mileage || undefined });
      drafts[o.id] = {};
    };
    const draft = (o) => (drafts[o.id] ||= { diagnosis: o.diagnosis || '', note: '', mileage: null });

    const fmt = (s) => { const sec = Math.max(0, Math.floor(s)); return [sec / 3600, (sec % 3600) / 60, sec % 60].map((v) => String(Math.floor(v)).padStart(2, '0')).join(':'); };
    const elapsed = computed(() => (st.value?.work ? fmt((now.value - new Date(st.value.work.start)) / 1000) : ''));
    const presentFor = computed(() => (st.value?.attendance?.present ? fmt((now.value - new Date(st.value.attendance.since)) / 1000) : ''));
    const timeStr = computed(() => new Date(now.value).toLocaleTimeString('fr-LU', { hour: '2-digit', minute: '2-digit' }));
    const dateStr = computed(() => new Date(now.value).toLocaleDateString('fr-LU', { weekday: 'long', day: 'numeric', month: 'long' }));
    const hm = (x) => { const m = Math.round((x || 0) * 60); return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}`; };
    const h = hm;
    const since = (s) => (s ? s.slice(11, 16) : '');
    const openLive = async (o) => { const w = window.open('', '_blank'); const r = await call('POST', `/kiosk/orders/${o.id}/live`); if (w) w.location = r.url; else location.href = r.url; };
    return { info, people, q, pick, greet, openLive, who, pin, err, token, st, press, logout, attend, clockAction, updateOrder, toggleLine, saveNotes, draft, open, elapsed, presentFor, timeStr, dateStr, h, since };
  },
  template: `
  <div class="k-wrap">
    <div class="k-top">
      <div class="k-brand"><img v-if="info.logo" :src="info.logo" alt=""><b v-else>{{ info.company }}</b></div>
      <div class="k-when"><div class="k-clock">{{ timeStr }}</div><div class="k-muted">{{ dateStr }}</div></div>
      <button v-if="who" class="k-btn sm" @click="logout">✕ {{ token ? 'Terminer' : 'Retour' }}</button>
    </div>

    <template v-if="!who">
      <div class="k-hero"><h1>Bienvenue !</h1><p>Touchez votre nom<span v-if="info.badge"> ou scannez votre badge</span> pour pointer.</p></div>
      <input v-if="info.users.length > 8" class="k-search" v-model="q" placeholder="Rechercher mon nom…">
      <div class="k-users">
        <button v-for="u in people" :key="u.id" class="k-user" :class="{ present: u.since }" :style="{'--c': u.color}" @click="pick(u)">
          <div class="k-avatar" :style="{background: u.color}">{{ u.name[0] }}<i></i></div>
          <b>{{ u.name }}</b>
          <small>{{ u.since ? 'Présent depuis ' + since(u.since) : (u.job_title || 'Absent') }}</small>
        </button>
      </div>
      <p v-if="!info.users.length" class="k-muted" style="text-align:center">Personne n'a encore de code PIN. Le gérant les crée dans Paramètres → Utilisateurs & accès.</p>
      <div class="k-err" style="text-align:center">{{ err }}</div>
    </template>

    <div v-else-if="!token" class="k-pin">
      <div class="k-avatar big" :style="{background: who.color}">{{ who.name[0] }}</div>
      <div class="k-title">{{ who.name }}</div>
      <div class="k-muted">Entrez votre code PIN</div>
      <div class="k-dots"><span v-for="i in 4" :class="{on: pin.length >= i}"></span><span v-for="i in 2" v-show="pin.length > 4" :class="{on: pin.length >= i + 4}"></span></div>
      <div class="k-err">{{ err }}</div>
      <div class="k-pad"><button v-for="k in ['1','2','3','4','5','6','7','8','9','⌫','0','OK']" :class="{ ok: k === 'OK' }" @click="press(k)">{{ k }}</button></div>
    </div>

    <template v-else-if="st">
      <div class="k-att">
        <div class="k-avatar big" :style="{background: who.color}">{{ who.name[0] }}</div>
        <div class="k-title">{{ who.name }}</div>
        <div class="k-muted">{{ st.attendance.present ? 'Présent(e) depuis ' + since(st.attendance.since) : 'Vous n’êtes pas encore pointé(e)' }}</div>
        <div v-if="st.attendance.present" class="k-timer">{{ presentFor }}</div>
        <button class="k-big" :class="st.attendance.present ? 'out' : 'in'" @click="attend">
          <span class="ico">{{ st.attendance.present ? '⏏' : '▶' }}</span>{{ st.attendance.present ? 'Départ' : 'Arrivée' }}
        </button>
        <div class="k-stats"><div><b>{{ h(st.attendance.today_hours) }}</b>aujourd'hui</div><div><b>{{ h(st.attendance.week_hours) }}</b>cette semaine</div><div><b>{{ h(st.todayHours) }}</b>sur des OR</div></div>
      </div>
      <div class="k-err">{{ err }}</div>

      <template v-if="st.show_orders && st.attendance.present">
        <div v-if="st.work" class="k-status working">
          <div><div class="k-muted">En cours sur</div><div style="font-size:22px;font-weight:700">{{ st.work.number }} <span class="plate">{{ st.work.plate }}</span></div><div class="k-timer">{{ elapsed }}</div></div>
          <button class="k-btn orange" @click="clockAction('stop')">⏸ Pause / arrêter</button>
        </div>
      <div class="k-title" style="font-size:20px">🔧 Ordres de réparation</div>
      <div class="k-orders">
        <div v-for="o in st.orders" class="k-order" :class="{mine: o.mechanic_id === who.id, active: st.work && st.work.document_id === o.id}">
          <h3><span>{{ o.number }} <span class="plate">{{ o.plate }}</span></span><span class="k-muted">{{ h(o.hours_spent) }}</span></h3>
          <div class="k-muted">{{ o.make }} {{ o.model }} · {{ o.customer_name }} <span v-if="o.vin">· VIN {{ o.vin }}</span></div>
          <div class="complaint">{{ o.customer_complaint || 'Pas de description' }}</div>
          <div class="k-actions">
            <button v-if="!(st.work && st.work.document_id === o.id)" class="k-btn green sm" @click="clockAction('start', o.id)">▶ Démarrer</button>
            <button v-else class="k-btn orange sm" @click="clockAction('stop')">⏸ Pause</button>
            <button class="k-btn blue sm" @click="openLive(o)">📷 Photos & messages</button>
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
    </template>

    <transition name="k-fade"><div v-if="greet" class="k-greet" :class="greet.cls" @click="greet = null">
      <div class="k-greet-ico">{{ greet.cls === 'in' ? '👋' : '🌙' }}</div><h1>{{ greet.title }}</h1><p>{{ greet.sub }}</p><p class="k-muted">{{ greet.extra }}</p>
    </div></transition>
  </div>`,
};

createApp(App).mount('#app');

if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) navigator.serviceWorker.register('/sw.js').catch(() => {});
