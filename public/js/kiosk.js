// Kiosque de pointage atelier (tablette) : les mécaniciens se connectent avec leur PIN
// et pointent présence + temps passé sur chaque intervention des ordres de réparation
// (temps prévu par le gérant ; le temps passe en rouge dès qu'il est dépassé).
import { createApp, ref, reactive, computed, onMounted, onUnmounted } from 'vue';
import { Icon } from './icon.js';
import { BrandLogo } from './brands.js';

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
    const notice = ref('');
    let noticeT;
    // Heure de réception de l'état : les chronos en cours continuent d'avancer à l'écran depuis cet instant
    let fetchedAt = Date.now();
    // Les cartes des OR gardent leur place tant que le mécanicien est devant la tablette : démarrer un chrono ne les fait pas sauter
    const rank = new Map();
    const setState = (s) => {
      if (Array.isArray(s?.orders)) { s.orders.forEach((o) => { if (!rank.has(o.id)) rank.set(o.id, rank.size); }); s.orders.sort((a, b) => rank.get(a.id) - rank.get(b.id)); }
      st.value = s; fetchedAt = Date.now();
    };
    let idle, clock, greetT;

    const call = async (method, url, body) => {
      const r = await fetch('/api' + url, {
        method, headers: { 'Content-Type': 'application/json', ...(token.value ? { Authorization: 'Bearer ' + token.value } : {}) },
        body: body ? JSON.stringify(body) : undefined,
      }).catch(() => { throw new Error('Pas de connexion au serveur du garage — réessayez dans un instant'); });
      const d = await r.json().catch(() => ({}));
      if (r.status === 401 && token.value) logout();
      if (!r.ok) throw new Error(d.error || 'Erreur');
      return d;
    };
    const bump = () => { clearTimeout(idle); if (token.value || who.value) idle = setTimeout(logout, IDLE_LOGOUT_MS); };
    const logout = () => {
      // la session est aussi fermée sur le serveur (elle ne reste pas valable après « Terminer »)
      if (token.value) fetch('/api/auth/logout', { method: 'POST', headers: { Authorization: 'Bearer ' + token.value } }).catch(() => {});
      rank.clear(); token.value = null; who.value = null; st.value = null; pin.value = ''; open.value = null; notice.value = ''; err.value = ''; q.value = ''; loadUsers();
    };
    const offline = ref(false);
    const loadUsers = async () => { try { info.value = await call('GET', '/kiosk/users'); offline.value = false; } catch { offline.value = true; } };

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
      setInterval(async () => {
        if (!token.value || !st.value) return;
        const tk = token.value;
        try { const s = await call('GET', '/kiosk/state'); if (token.value === tk) setState(s); } catch { /* prochain essai */ }
      }, 20_000);
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
        setState(await call('GET', '/kiosk/state'));
        bump();
      } catch (e) { err.value = e.message; pin.value = ''; }
    };
    const showGreeting = (r) => {
      const first = (r.user?.name || '').split(' ')[0];
      const h = new Date().getHours();
      greet.value = r.action === 'in'
        ? { cls: 'in', title: `${h < 12 ? 'Bonjour' : h < 18 ? 'Bon après-midi' : 'Bonsoir'} ${first} !`, sub: `Arrivée enregistrée à ${r.at.slice(11, 16)}`, extra: h < 17 ? 'Bonne journée' : 'Bon travail' }
        : { cls: 'out', title: `Au revoir ${first} !`, sub: `Départ enregistré à ${r.at.slice(11, 16)}`, extra: `${hm(r.today_hours)} travaillées aujourd'hui · ${h >= 17 ? 'bonne soirée' : 'à bientôt'}` };
      clearTimeout(greetT);
      greetT = setTimeout(() => { greet.value = null; }, 4000);
    };
    // Gros bouton Arrivée / Départ
    const attend = async () => {
      try {
        const r = await call('POST', '/kiosk/attendance', {});
        showGreeting(r);
        setState(await call('GET', '/kiosk/state'));
        // Au départ, ou pour le bureau : retour à l'écran d'accueil ; un mécanicien arrivé reste pour ses OR
        if (r.action === 'out' || !st.value.show_orders) setTimeout(logout, 400);
      } catch (e) { err.value = e.message; }
    };
    const act = async (fn) => { try { const r = await fn(); setState({ ...st.value, ...r }); err.value = ''; } catch (e) { err.value = e.message; } };
    // Un mécanicien n'est pointé que sur un travail à la fois : démarrer ailleurs arrête le chrono précédent, et on le lui dit
    const clockAction = async (action, document_id, line_id) => {
      await act(() => call('POST', '/kiosk/clock', { action, document_id, line_id }));
      const s = st.value?.switched;
      if (action === 'start' && s && !err.value) {
        notice.value = s.same_order ? 'Chrono arrêté sur « ' + (s.line || 'autre travail') + ' »'
          : 'Chrono arrêté sur ' + (s.number || 'l’autre OR') + (s.line ? ' (' + s.line + ')' : '') + ' — vous êtes maintenant sur ' + s.to;
        clearTimeout(noticeT);
        noticeT = setTimeout(() => { notice.value = ''; }, 9000);
      }
    };
    const startLine = (o, l) => clockAction('start', o.id, l.id);
    const updateOrder = (o, body) => act(() => call('POST', `/kiosk/orders/${o.id}`, body));
    const toggleLine = (o, l) => updateOrder(o, { line_id: l.id, done: !l.done });
    const saveNotes = async (o) => {
      const d = drafts[o.id] || {};
      await updateOrder(o, { diagnosis: d.diagnosis ?? o.diagnosis, note: d.note || undefined, mileage: d.mileage || undefined });
      // enregistrement refusé (kilométrage invalide…) : la saisie reste à l'écran pour être corrigée
      if (err.value) return;
      delete drafts[o.id]; // le brouillon est recréé à partir de l'OR à jour (diagnostic enregistré affiché)
    };
    const draft = (o) => (drafts[o.id] ||= { diagnosis: o.diagnosis || '', note: '', mileage: null });

    const fmt = (s) => { const sec = Math.max(0, Math.floor(s)); return [sec / 3600, (sec % 3600) / 60, sec % 60].map((v) => String(Math.floor(v)).padStart(2, '0')).join(':'); };
    // Temps passé « en direct » : le temps reçu du serveur + ce qui s'est écoulé depuis sur les chronos en cours
    const liveHours = (spent, active) => (spent || 0) + (active || 0) * Math.max(0, now.value - fetchedAt) / 3.6e6;
    const over = (spent, planned) => planned > 0 && spent - planned > 1 / 120;
    const lSpent = (l) => liveHours(l.spent, l.active);
    const oSpent = (o) => liveHours(o.hours_spent, o.active);
    const lOver = (l) => over(lSpent(l), l.planned);
    // Total de l'OR comparé au temps prévu : sans le temps pointé sur des interventions qui n'ont pas de temps prévu
    const oJudged = (o) => oSpent(o) - o.lines.reduce((s, l) => s + (l.timed && !l.planned ? lSpent(l) : 0), 0);
    const oOver = (o) => over(oJudged(o), o.hours_planned);
    // Collègues qui travaillent en ce moment sur la même intervention (ou sur l'OR, sans intervention précise)
    const others = (names) => (names || []).filter((n) => n !== who.value?.name);
    const isMine = (o, l) => !!st.value?.work && st.value.work.document_id === o.id && st.value.work.line_id === l.id;
    // Travail en cours : temps passé / prévu de l'intervention (ou de l'OR entier si le chrono n'est pas sur une intervention)
    const cur = computed(() => {
      const w = st.value?.work;
      const o = w && (st.value.orders || []).find((x) => x.id === w.document_id);
      if (!o) return null;
      const l = w.line_id ? o.lines.find((x) => x.id === w.line_id && x.timed) : null;
      const spent = l ? lSpent(l) : oJudged(o), planned = l ? l.planned : o.hours_planned;
      return { spent, planned, over: over(spent, planned), line: !!l, with: others(l ? l.workers : o.general_workers) };
    });
    const elapsed = computed(() => (st.value?.work ? fmt((now.value - new Date(st.value.work.start)) / 1000) : ''));
    const presentFor = computed(() => (st.value?.attendance?.present ? fmt((now.value - new Date(st.value.attendance.since)) / 1000) : ''));
    const timeStr = computed(() => new Date(now.value).toLocaleTimeString('fr-LU', { hour: '2-digit', minute: '2-digit' }));
    const dateStr = computed(() => new Date(now.value).toLocaleDateString('fr-LU', { weekday: 'long', day: 'numeric', month: 'long' }));
    const hm = (x) => { const m = Math.round((x || 0) * 60); return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}`; };
    const h = hm;
    const since = (s) => (s ? s.slice(11, 16) : '');
    const openLive = async (o) => { const w = window.open('', '_blank'); const r = await call('POST', `/kiosk/orders/${o.id}/live`); if (w) w.location = r.url; else location.href = r.url; };
    return { info, offline, people, q, pick, greet, openLive, who, pin, err, token, st, press, logout, attend, clockAction, startLine, notice, lSpent, oSpent, lOver, oOver, isMine, cur, others,
      updateOrder, toggleLine, saveNotes, draft, open, elapsed, presentFor, timeStr, dateStr, h, since };
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
      <p v-if="offline" class="k-err" style="text-align:center"><Icon name="radio" class="ti"/> Pas de connexion au garage — nouvel essai automatique toutes les 30 secondes.</p>
      <p v-else-if="!info.users.length" class="k-muted" style="text-align:center">Personne n'a encore de code PIN. Le gérant les crée dans Paramètres → Utilisateurs & accès.</p>
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
          <span class="ico"><Icon :name="st.attendance.present ? 'log-out' : 'log-in'" class="ti"/></span>{{ st.attendance.present ? 'Départ' : 'Arrivée' }}
        </button>
        <div class="k-stats"><div><b>{{ h(st.attendance.today_hours) }}</b>aujourd'hui</div><div><b>{{ h(st.attendance.week_hours) }}</b>cette semaine</div><div><b>{{ h(st.todayHours) }}</b>sur des OR</div></div>
      </div>
      <div class="k-err">{{ err }}</div>
      <div v-if="notice" class="k-info" @click="notice = ''"><Icon name="info" class="ti"/> {{ notice }}</div>

      <template v-if="st.show_orders && st.attendance.present">
        <div v-if="st.work" class="k-status working" :class="{ over: cur && cur.over }">
          <div>
            <div class="k-muted">En cours sur</div>
            <div style="font-size:22px;font-weight:700">{{ st.work.number }} <span class="plate">{{ st.work.plate }}</span></div>
            <div v-if="st.work.line_description" class="k-work-line">{{ st.work.line_description }}</div>
            <div class="k-timer" :class="{ over: cur && cur.over }">{{ elapsed }}</div>
            <div v-if="cur" class="k-budget" :class="{ over: cur.over }">
              {{ cur.line ? 'Intervention' : 'OR' }} : {{ h(cur.spent) }}<template v-if="cur.planned"> / {{ h(cur.planned) }} prévu</template><template v-if="cur.with.length"> · avec {{ cur.with.join(', ') }}</template>
              <template v-if="cur.over"><br><Icon name="triangle-alert" class="ti"/> Temps prévu dépassé de {{ h(cur.spent - cur.planned) }}</template><template v-else-if="cur.planned"> · reste {{ h(cur.planned - cur.spent) }}</template>
            </div>
          </div>
          <button class="k-btn orange" @click="clockAction('stop')"><Icon name="pause" class="ti"/> Pause / arrêter</button>
        </div>
      <div class="k-title" style="font-size:20px"><Icon name="wrench" class="ti"/> Ordres de réparation</div>
      <div class="k-orders">
        <div v-for="o in st.orders" class="k-order" :class="{mine: o.mechanic_id === who.id, active: st.work && st.work.document_id === o.id}">
          <h3><span>{{ o.number }} <span class="plate">{{ o.plate }}</span></span><span class="k-time" :class="{ over: oOver(o) }"><Icon name="timer" class="ti"/> {{ h(oSpent(o)) }}<template v-if="o.hours_planned"> / {{ h(o.hours_planned) }}</template></span></h3>
          <div class="k-muted brand-line"><BrandLogo :make="o.make" :size="30"/><span>{{ o.make }} {{ o.model }} · {{ o.customer_name }} <span v-if="o.vin">· VIN {{ o.vin }}</span></span></div>
          <div class="complaint">{{ o.customer_complaint || 'Pas de description' }}</div>
          <!-- Le chrono se lance ici, sur l'OR : un bouton par intervention (main-d'œuvre, forfait) -->
          <div v-if="o.lines.some(l => l.timed)" class="k-work">
            <div v-for="l in o.lines.filter(x => x.timed)" :key="l.id" class="k-line" :class="{ done: l.done, running: isMine(o, l) }">
              <span class="box" @click="toggleLine(o, l)">{{ l.done ? '✓' : '' }}</span>
              <span class="k-line-txt" @click="toggleLine(o, l)">{{ l.description }}<span class="k-muted" v-if="others(l.workers).length"> · <Icon name="user" class="ti"/> {{ others(l.workers).join(', ') }}</span>
                <span v-if="l.planned || lSpent(l) > 0" class="k-time" :class="{ over: lOver(l) }"><Icon name="timer" class="ti"/> {{ h(lSpent(l)) }}<template v-if="l.planned"> / {{ h(l.planned) }} prévu</template><template v-if="lOver(l)"> · dépassé</template></span>
              </span>
              <button v-if="isMine(o, l)" class="k-btn orange sm k-go" title="Pause" @click="clockAction('stop')"><Icon name="pause" class="ti"/></button>
              <button v-else class="k-btn green sm k-go" title="Démarrer le chrono sur cette intervention" @click="startLine(o, l)"><Icon name="play" class="ti"/></button>
            </div>
            <div class="k-line k-general">
              <span class="k-line-txt k-muted">Autre travail sur cet OR (diagnostic, essai…)<span v-if="o.hours_general > 0" class="k-time"><Icon name="timer" class="ti"/> {{ h(o.hours_general) }}</span></span>
              <button v-if="st.work && st.work.document_id === o.id && !st.work.line_id" class="k-btn orange sm k-go" title="Pause" @click="clockAction('stop')"><Icon name="pause" class="ti"/></button>
              <button v-else class="k-btn sm k-go" title="Démarrer le chrono sans intervention précise" @click="clockAction('start', o.id)"><Icon name="play" class="ti"/></button>
            </div>
          </div>
          <div class="k-actions">
            <button v-if="st.work && st.work.document_id === o.id" class="k-btn orange sm" @click="clockAction('stop')"><Icon name="pause" class="ti"/> Pause</button>
            <button v-else-if="!o.lines.some(l => l.timed)" class="k-btn green sm" @click="clockAction('start', o.id)"><Icon name="play" class="ti"/> Démarrer le chrono</button>
            <button class="k-btn blue sm" @click="openLive(o)"><Icon name="camera" class="ti"/> Photos & messages</button>
            <button class="k-btn sm" @click="open = open === o.id ? null : o.id">{{ open === o.id ? '▲ Fermer' : '▼ Détails' }}</button>
          </div>
          <template v-if="open === o.id">
            <div v-for="l in o.lines.filter(x => !x.timed)" :key="l.id" class="k-line" :class="{ done: l.done }">
              <span class="box" @click="toggleLine(o, l)">{{ l.done ? '✓' : '' }}</span>
              <span class="k-line-txt" @click="toggleLine(o, l)">{{ l.description }}</span>
            </div>
            <div style="display:flex;flex-direction:column;gap:8px;margin-top:10px">
              <textarea v-model="draft(o).diagnosis" placeholder="Diagnostic / constat…"></textarea>
              <input v-model="draft(o).note" placeholder="Note pour le bureau (pièce manquante, travaux supplémentaires…)">
              <input v-model.number="draft(o).mileage" type="number" placeholder="Kilométrage relevé">
              <button class="k-btn blue sm" @click="saveNotes(o)"><Icon name="save" class="ti"/> Enregistrer</button>
            </div>
            <div class="k-actions">
              <button class="k-btn orange sm" @click="updateOrder(o, {status: 'waiting_parts'})"><Icon name="package" class="ti"/> Attente pièces</button>
              <button class="k-btn green sm" @click="updateOrder(o, {status: 'done'})"><Icon name="circle-check" class="ti"/> Travail terminé</button>
            </div>
          </template>
        </div>
      </div>
      <p v-if="!st.orders.length" class="k-muted">Aucun ordre de réparation ouvert.</p>
      </template>
    </template>

    <transition name="k-fade"><div v-if="greet" class="k-greet" :class="greet.cls" @click="greet = null">
      <div class="k-greet-ico"><Icon :name="greet.cls === 'in' ? 'sun' : 'moon'" class="ti"/></div><h1>{{ greet.title }}</h1><p>{{ greet.sub }}</p><p class="k-muted">{{ greet.extra }}</p>
    </div></transition>
  </div>`,
};

const app = createApp(App);
app.component('Icon', Icon);
app.component('BrandLogo', BrandLogo);
app.mount('#app');

if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) navigator.serviceWorker.register('/sw.js').catch(() => {});
