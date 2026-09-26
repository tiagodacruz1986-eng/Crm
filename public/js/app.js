import { createApp, reactive, computed, defineAsyncComponent, ref, onMounted, onUnmounted, watch } from 'vue';
import { store, GET, POST, money, DOC_TYPES_SHORT } from './api.js';
import { Badge, Modal, Picker, BarChart, Empty, Icon } from './components.js';
import { Chatter, ModuleTools, MailComposer, ActivityBell } from './mail.js';

import { route, go } from './router.js';
import { APPS, visibleApps, currentApp, can } from './apps.js';
import { theme, toggleTheme, setTheme, ThemePicker } from './theme.js';

const lazy = (file, name) => defineAsyncComponent(() => import(`./views/${file}.js`).then((m) => m[name]));
const VIEWS = {
  dashboard: lazy('dashboard', 'Dashboard'),
  workshop: lazy('workshop', 'Workshop'), planning: lazy('workshop', 'Planning'),
  documents: lazy('documents', 'DocumentList'), document: lazy('documents', 'DocumentEditor'),
  customers: lazy('customers', 'CustomerList'), customer: lazy('customers', 'CustomerDetail'),
  vehicles: lazy('customers', 'VehicleList'), vehicle: lazy('customers', 'VehicleDetail'),
  stock: lazy('stock', 'ProductList'), product: lazy('stock', 'ProductDetail'),
  purchases: lazy('stock', 'PurchaseList'), purchase: lazy('stock', 'PurchaseEditor'), suppliers: lazy('stock', 'SupplierList'),
  accounting: lazy('accounting', 'Accounting'), bank: lazy('bank', 'Bank'), timesheets: lazy('timesheets', 'Timesheets'),
  office: lazy('office', 'Office'), apps: lazy('home', 'Home'), attendance: lazy('attendance', 'Attendance'), activities: lazy('activities', 'Activities'), copilot: defineAsyncComponent(() => import('./copilot.js').then((m) => m.CopilotPage)), mail: lazy('activities', 'MailOutbox'), settings: lazy('settings', 'Settings'),
};

const NAV = [
  { section: 'Pilotage' },
  { to: '/apps', icon: 'layout-grid', label: 'Applications', match: 'apps' },
  { to: '/', icon: 'layout-dashboard', label: 'Tableau de bord', match: 'dashboard' },
  { to: '/copilot', icon: 'sparkles', label: 'Nova — copilote', match: 'copilot', perm: 'ia' },
  { to: '/office', icon: 'brain', label: 'Bureau IA', match: 'office', perm: 'ia' },
  { to: '/activities', icon: 'alarm-clock', label: 'Activités', match: 'activities' },
  { to: '/mail', icon: 'mail', label: 'E-mails', match: 'mail', perm: 'emails' },
  { section: 'Atelier' },
  { to: '/workshop', icon: 'wrench', label: 'Atelier (OR)', match: 'workshop', perm: 'atelier' },
  { to: '/planning', icon: 'calendar-days', label: 'Planning', match: 'planning', perm: 'atelier' },
  { to: '/attendance', icon: 'user-check', label: 'Présences', match: 'attendance' },
  { to: '/timesheets', icon: 'timer', label: 'Feuilles de temps', match: 'timesheets', perm: 'presences' },
  { section: 'Ventes' },
  { to: '/documents/quote', icon: 'file-text', label: 'Devis', match: 'documents', type: 'quote', perm: 'ventes' },
  { to: '/documents/invoice', icon: 'receipt', label: 'Factures', match: 'documents', type: 'invoice', perm: 'ventes' },
  { to: '/customers', icon: 'users', label: 'Clients', match: 'customers', perm: 'contacts' },
  { to: '/vehicles', icon: 'car', label: 'Véhicules', match: 'vehicles', perm: 'vehicules' },
  { section: 'Stock & achats' },
  { to: '/stock', icon: 'package', label: 'Articles & stock', match: 'stock', perm: 'inventaire' },
  { to: '/purchases', icon: 'shopping-cart', label: 'Achats', match: 'purchases', perm: 'achats' },
  { to: '/suppliers', icon: 'factory', label: 'Fournisseurs', match: 'suppliers', perm: 'contacts' },
  { section: 'Finance' },
  { to: '/bank', icon: 'landmark', label: 'Banque', match: 'bank', perm: 'banque' },
  { to: '/accounting', icon: 'book-open', label: 'Comptabilité', match: 'accounting', perm: 'comptabilite' },
  { section: '' },
  { to: '/settings', icon: 'settings', label: 'Paramètres', match: 'settings', admin: true },
];

// ---------- Connexion / première configuration ----------
const Login = {
  props: ['setup'],
  setup(props) {
    const f = reactive({ name: '', email: '', password: '', company: '' });
    const err = ref('');
    const submit = async () => {
      err.value = '';
      try {
        await POST(props.setup ? '/auth/setup' : '/auth/login', f);
        await boot();
      } catch (e) { err.value = e.message; }
    };
    return { f, err, submit, theme, toggleTheme };
  },
  template: `
  <div class="login-bg">
    <button type="button" class="btn login-theme" @click="toggleTheme" :title="theme.active === 'dark' ? 'Thème clair' : 'Thème sombre'"><Icon :name="theme.active === 'dark' ? 'sun' : 'moon'"/> {{ theme.active === 'dark' ? 'Clair' : 'Sombre' }}</button>
    <form class="login-card" @submit.prevent="submit">
      <div class="login-logo"><Icon name="wrench" size="34"/></div>
      <h1>{{ setup ? 'Bienvenue !' : 'Connexion' }}</h1>
      <p class="muted" v-if="setup">Créez le compte du gérant pour démarrer votre logiciel de garage.</p>
      <label v-if="setup">Nom du garage<input v-model="f.company" placeholder="Garage …" required></label>
      <label v-if="setup">Votre nom<input v-model="f.name" required></label>
      <label>E-mail<input v-model="f.email" type="email" required autocomplete="username"></label>
      <label>Mot de passe<input v-model="f.password" type="password" required minlength="6" autocomplete="current-password"></label>
      <div class="error" v-if="err">{{ err }}</div>
      <button class="btn primary big">{{ setup ? 'Créer mon garage' : 'Se connecter' }}</button>
      <a class="kiosk-link" href="/kiosk.html">🔧 Pointage mécaniciens (tablette atelier)</a>
    </form>
  </div>`,
};

// ---------- Invitation : choisir son mot de passe ----------
const Invite = {
  setup() {
    const info = ref(null);
    const err = ref('');
    const pw = reactive({ a: '', b: '' });
    onMounted(async () => { try { info.value = await GET('/auth/invite/' + route.params.token); } catch (e) { err.value = e.message; } });
    const submit = async () => {
      err.value = '';
      if (pw.a.length < 8) { err.value = 'Mot de passe : 8 caractères minimum'; return; }
      if (pw.a !== pw.b) { err.value = 'Les deux mots de passe sont différents'; return; }
      try { await POST('/auth/invite/' + route.params.token, { password: pw.a }); go('/apps'); await boot(); } catch (e) { err.value = e.message; }
    };
    return { info, err, pw, submit };
  },
  template: `
  <div class="login-bg">
    <form class="login-card" @submit.prevent="submit">
      <div class="login-logo"><Icon name="key-round" size="34"/></div>
      <template v-if="info">
        <h1>Bienvenue {{ info.name }} !</h1>
        <p class="muted">Vous avez été invité(e) sur le logiciel de <b>{{ info.company }}</b>. Choisissez votre mot de passe pour vous connecter avec <b>{{ info.email }}</b>.</p>
        <label>Mot de passe<input v-model="pw.a" type="password" minlength="8" required autocomplete="new-password"></label>
        <label>Confirmer<input v-model="pw.b" type="password" minlength="8" required autocomplete="new-password"></label>
        <div class="error" v-if="err">{{ err }}</div>
        <button class="btn primary big">Activer mon compte</button>
      </template>
      <template v-else>
        <h1>Invitation</h1>
        <div class="error" v-if="err">{{ err }}</div>
        <a class="btn" href="#/">Aller à la connexion</a>
      </template>
    </form>
  </div>`,
};

// ---------- Recherche globale (Ctrl+K) ----------
const GlobalSearch = {
  emits: ['close'],
  setup(_, { emit }) {
    const q = ref('');
    const r = ref(null);
    let t;
    const search = () => { clearTimeout(t); t = setTimeout(async () => { r.value = q.value.length > 1 ? await GET('/search?q=' + encodeURIComponent(q.value)) : null; }, 150); };
    const open = (path) => { go(path); emit('close'); };
    return { q, r, search, open, money, DOC_TYPES_SHORT };
  },
  template: `
  <div class="modal-bg" @mousedown.self="$emit('close')">
    <div class="search-box">
      <input v-model="q" @input="search" placeholder="Plaque, client, n° de facture, référence pièce…" autofocus @keydown.esc="$emit('close')">
      <div class="search-results" v-if="r">
        <div v-if="r.vehicles.length" class="sr-group">Véhicules</div>
        <div v-for="v in r.vehicles" class="sr" @click="open('/vehicle/' + v.id)">🚗 <b>{{ v.plate }}</b> {{ v.make }} {{ v.model }} <span class="muted">{{ v.customer_name }}</span></div>
        <div v-if="r.customers.length" class="sr-group">Clients</div>
        <div v-for="c in r.customers" class="sr" @click="open('/customer/' + c.id)">👤 <b>{{ c.name }}</b> {{ c.company }} <span class="muted">{{ c.phone }} {{ c.city }}</span></div>
        <div v-if="r.documents.length" class="sr-group">Documents</div>
        <div v-for="d in r.documents" class="sr" @click="open('/document/' + d.id)">📄 {{ DOC_TYPES_SHORT[d.type] }} <b>{{ d.number || 'brouillon' }}</b> {{ d.customer_name }} <span class="muted">{{ money(d.total) }}</span></div>
        <div v-if="r.products.length" class="sr-group">Articles</div>
        <div v-for="p in r.products" class="sr" @click="open('/product/' + p.id)">📦 <b>{{ p.ref }}</b> {{ p.name }} <span class="muted">stock {{ p.qty_on_hand }}</span></div>
        <div v-if="!r.vehicles.length && !r.customers.length && !r.documents.length && !r.products.length" class="muted pad">Aucun résultat</div>
      </div>
    </div>
  </div>`,
};

const Root = {
  components: { Login, Invite, GlobalSearch, ThemePicker, Copilot: defineAsyncComponent(() => import('./copilot.js').then((m) => m.Copilot)) },
  setup() {
    const searchOpen = ref(false);
    const menuOpen = ref(false);
    const onKey = (e) => { if ((e.ctrlKey || e.metaKey) && e.key === 'k') { e.preventDefault(); searchOpen.value = true; } };
    onMounted(() => window.addEventListener('keydown', onKey));
    onUnmounted(() => window.removeEventListener('keydown', onKey));
    const view = computed(() => VIEWS[route.name] || VIEWS.dashboard);
    const isActive = (n) => n.match === route.name && (!n.type || n.type === route.params.type);
    const logout = async () => { await POST('/auth/logout'); store.user = null; };
    const plusOpen = ref(false);
    const appearance = ref(false);
    const devices = ref(null);
    const openDevices = async () => { devices.value = await GET('/network'); };
    // Installation comme application (Chrome, Edge, Android)
    const installable = ref(false);
    let deferred = null;
    window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); deferred = e; installable.value = true; });
    const install = async () => { if (!deferred) return; deferred.prompt(); await deferred.userChoice; deferred = null; installable.value = false; };
    watch(() => route.path, () => { menuOpen.value = false; plusOpen.value = false; userOpen.value = false; attOpen.value = false; });
    // Menu façon Odoo (applications + barre du haut) ou barre latérale classique
    const navMode = ref((() => { try { return localStorage.getItem('garage_nav') || 'apps'; } catch { return 'apps'; } })());
    const setNav = (m) => { navMode.value = m; try { localStorage.setItem('garage_nav', m); } catch { /* navigation privée */ } };
    const nav = computed(() => NAV.filter((n, i) => {
      if (n.section !== undefined) return true;
      return n.admin ? store.user?.role === 'admin' : can(n.perm);
    }).filter((n, i, arr) => n.section === undefined || (arr[i + 1] && arr[i + 1].section === undefined)));
    const app = computed(() => (route.name === 'apps' ? null : currentApp(route)));
    const appMenus = computed(() => (app.value?.menus || []).filter((m) => (m.perm ? can(m.perm) : true)));
    const menuActive = (m) => { const p = route.path + (route.query.tab ? '?tab=' + route.query.tab : ''); return m.to === p || (m.to === route.path && !route.query.tab); };
    const userOpen = ref(false);
    const attOpen = ref(false);
    const att = computed(() => store.user?.attendance || {});
    const checking = ref(false);
    const quickCheck = async () => {
      checking.value = true;
      try { const r = await POST('/attendance/check', {}); store.user.attendance = r; } catch (e) { alert(e.message); } finally { checking.value = false; }
    };
    const openAtt = async () => { attOpen.value = !attOpen.value; if (attOpen.value) store.user.attendance = await GET('/attendance/me'); };
    const canQuote = computed(() => can('ventes', 'user'));
    const canOrder = computed(() => can('atelier', 'user'));
    const ROLE_LABEL = { admin: 'Administrateur', office: 'Utilisateur', mechanic: 'Mécanicien' };
    return { theme, toggleTheme, appearance, store, route, nav, view, isActive, searchOpen, menuOpen, logout, plusOpen, devices, openDevices, installable, install, encodeURIComponent,
      navMode, setNav, app, appMenus, menuActive, userOpen, attOpen, att, checking, quickCheck, openAtt, canQuote, canOrder, ROLE_LABEL };
  },
  template: `
  <div v-if="store.loading" class="boot">🔧</div>
  <Invite v-else-if="route.name === 'invite'"/>
  <Login v-else-if="!store.user" :setup="store.needsSetup"/>
  <div v-else class="layout" :class="{'menu-open': menuOpen, 'nav-apps': navMode === 'apps', 'is-home': route.name === 'apps'}">
    <aside class="sidebar" v-if="navMode === 'sidebar'" @click="menuOpen = false">
      <div class="brand"><span class="brand-logo"><Icon name="wrench"/></span><div><b>{{ store.company }}</b><small>Garage OS</small></div></div>
      <nav>
        <template v-for="n in nav">
          <div v-if="n.section !== undefined" class="nav-section">{{ n.section }}</div>
          <a v-else :href="'#' + n.to" :class="{active: isActive(n)}" :title="n.label"><Icon :name="n.icon"/><span class="nav-label">{{ n.label }}</span></a>
        </template>
      </nav>
      <div class="sidebar-foot">
        <a href="/kiosk.html" target="_blank" title="Kiosque atelier"><Icon name="tablet"/><span class="nav-label">Kiosque atelier</span></a>
        <a href="#" @click.prevent="openDevices" title="Téléphone / tablette"><Icon name="monitor-smartphone"/><span class="nav-label">Sur téléphone / tablette</span></a>
        <a href="#" v-if="installable" @click.prevent="install" title="Installer"><Icon name="download"/><span class="nav-label">Installer l'application</span></a>
        <div class="me">{{ store.user.name }} <button class="link" @click="logout">Déconnexion</button></div>
      </div>
    </aside>
    <main>
      <header class="topbar">
        <button v-if="navMode === 'sidebar'" class="icon-btn burger" @click="menuOpen = !menuOpen">☰</button>
        <template v-else>
          <a class="apps-btn" href="#/apps" title="Applications"><Icon name="layout-grid"/></a>
          <a v-if="app" class="app-title" :href="app.href || '#' + app.to"><span class="app-mini" :style="{ '--c1': app.c[0], '--c2': app.c[1] }"><Icon :name="app.icon"/></span><b>{{ app.name }}</b></a>
          <b v-else-if="route.name === 'apps'" class="app-title company">{{ store.company }}</b>
          <nav class="app-menus" v-if="appMenus.length"><template v-for="m in appMenus"><a v-if="m.href" :href="m.href" target="_blank">{{ m.label }}</a><a v-else :href="'#' + m.to" :class="{ active: menuActive(m) }">{{ m.label }}</a></template></nav>
        </template>
        <button class="search-trigger" :class="{ compact: navMode === 'apps' }" @click="searchOpen = true"><span style="display:flex;gap:8px;align-items:center"><Icon name="search"/> <span class="long">Rechercher une plaque, un client, une facture…</span><span class="short">Rechercher…</span></span> <kbd>Ctrl K</kbd></button>
        <div class="quick">
          <button class="btn theme-toggle" @click="toggleTheme" :title="theme.active === 'dark' ? 'Passer au thème clair' : 'Passer au thème sombre'"><Icon :name="theme.active === 'dark' ? 'sun' : 'moon'"/></button>
          <div class="att-sys">
            <button class="btn att-sys-btn" :class="{ on: att.present }" @click="openAtt" :title="att.present ? 'Présent — cliquer pour pointer le départ' : 'Pointer mon arrivée'"><i></i><Icon name="clock"/></button>
            <div v-if="attOpen" class="dropdown att-pop">
              <div class="muted small">{{ att.present ? 'Présent(e) depuis ' + new Date(att.since).toLocaleTimeString('fr-LU', { hour: '2-digit', minute: '2-digit' }) : 'Pas encore pointé(e)' }}</div>
              <div class="att-pop-h">{{ Math.floor(att.today_hours || 0) }}h{{ String(Math.round(((att.today_hours || 0) % 1) * 60)).padStart(2, '0') }} <small>aujourd'hui</small></div>
              <button class="att-btn sm" :class="att.present ? 'out' : 'in'" :disabled="checking" @click="quickCheck"><Icon :name="att.present ? 'log-out' : 'log-in'"/> {{ att.present ? 'Départ' : 'Arrivée' }}</button>
              <a href="#/attendance" class="small">Mes présences →</a>
            </div>
          </div>
          <ActivityBell/>
          <a v-if="canQuote && navMode === 'sidebar'" class="btn hide-phone" href="#/new/quote">+ Devis</a>
          <a v-if="canOrder" class="btn primary hide-phone" href="#/new/order">+ <span class="long">Ordre de réparation</span><span class="short">OR</span></a>
          <div class="user-menu">
            <button class="user-btn" @click="userOpen = !userOpen" :title="store.user.name"><span class="avatar" :style="{ background: store.user.color || '#6366f1' }">{{ store.user.name[0] }}</span></button>
            <div v-if="userOpen" class="dropdown user-drop" @click="userOpen = false">
              <div class="ud-head"><b>{{ store.user.name }}</b><small>{{ store.user.job_title || ROLE_LABEL[store.user.role] }} · {{ store.user.email }}</small></div>
              <a href="#/attendance"><Icon name="user-check"/> Mes présences</a>
              <a href="#" @click.prevent="appearance = true"><Icon :name="theme.active === 'dark' ? 'moon' : 'sun'"/> Apparence : {{ { dark: 'sombre', light: 'claire', auto: 'automatique' }[theme.pref] }}</a>
              <a href="#" @click.prevent="setNav(navMode === 'apps' ? 'sidebar' : 'apps')"><Icon :name="navMode === 'apps' ? 'panel-left' : 'layout-grid'"/> {{ navMode === 'apps' ? 'Menu en barre latérale' : 'Menu des applications (Odoo)' }}</a>
              <a href="/kiosk.html" target="_blank"><Icon name="tablet"/> Kiosque de pointage</a>
              <a href="#" @click.prevent="openDevices"><Icon name="monitor-smartphone"/> Sur téléphone / tablette</a>
              <a href="#" v-if="installable" @click.prevent="install"><Icon name="download"/> Installer l'application</a>
              <a v-if="store.user.role === 'admin'" href="#/settings?tab=users"><Icon name="shield-check"/> Utilisateurs & accès</a>
              <a href="#" @click.prevent="logout"><Icon name="log-out"/> Déconnexion</a>
            </div>
          </div>
        </div>
      </header>
      <div class="content"><component :is="view" :key="route.path"/></div>
    </main>
    <nav class="bottom-nav">
      <a href="#/apps" :class="{active: route.name === 'apps'}"><Icon name="layout-grid"/>Applis</a>
      <a v-if="canOrder" href="#/workshop" :class="{active: route.name === 'workshop'}"><Icon name="wrench"/>Atelier</a>
      <a v-else href="#/" :class="{active: route.name === 'dashboard'}"><Icon name="home"/>Accueil</a>
      <a href="#" class="plus" @click.prevent="plusOpen = !plusOpen"><span class="plus-btn"><Icon name="plus"/></span></a>
      <a href="#/attendance" :class="{active: route.name === 'attendance'}"><Icon name="user-check"/>Pointage</a>
      <a v-if="navMode === 'sidebar'" href="#" @click.prevent="menuOpen = true"><Icon name="menu"/>Menu</a>
      <a v-else href="#/planning" :class="{active: route.name === 'planning'}"><Icon name="calendar-days"/>Planning</a>
    </nav>
    <div v-if="plusOpen" class="plus-menu" @click="plusOpen = false">
      <div>
        <a v-if="canOrder" href="#/new/order">🔧 Ordre de réparation</a><a v-if="canQuote" href="#/new/quote">📝 Devis</a><a v-if="canQuote" href="#/new/invoice">🧾 Facture</a>
        <a href="#/customer/new">👤 Client</a><a href="#/purchases">📥 Facture fournisseur</a><a href="#/activities">⏰ Activité</a>
      </div>
    </div>
    <div v-if="menuOpen" class="menu-backdrop" @click="menuOpen = false"></div>
    <Modal v-if="devices" title="📱 Utiliser sur téléphone et tablette" @close="devices = null">
      <p>Connectez le téléphone ou la tablette <b>au même Wi-Fi que ce PC</b>, puis scannez :</p>
      <div v-for="u in devices.urls" style="text-align:center;margin-bottom:10px">
        <img :src="'/api/qr.svg?text=' + encodeURIComponent(u)" style="width:200px"><div><b>{{ u }}</b></div>
      </div>
      <p v-if="!devices.urls.length" class="error">Aucune adresse réseau trouvée : vérifiez que le PC est connecté au Wi-Fi ou au câble.</p>
      <p class="muted small">Ensuite, dans le navigateur du téléphone : <b>Partager → Sur l'écran d'accueil</b> (iPhone) ou <b>⋮ → Ajouter à l'écran d'accueil</b> (Android) pour avoir l'icône comme une vraie application. Kiosque des mécaniciens : ajoutez <b>/kiosk.html</b> à l'adresse.</p>
    </Modal>
    <Modal v-if="appearance" title="Apparence" wide @close="appearance = false">
      <p class="muted" style="margin-top:0">Choisissez le thème du logiciel. Le choix est gardé sur cet appareil.</p>
      <ThemePicker/>
    </Modal>
    <GlobalSearch v-if="searchOpen" @close="searchOpen = false"/>
    <Copilot/>
  </div>
  <div class="toasts"><div v-for="t in store.toasts" :key="t.id" class="toast" :class="t.type">{{ t.msg }}</div></div>`,
};

async function boot() {
  store.loading = true;
  const s = await GET('/auth/status');
  store.needsSetup = s.needsSetup;
  store.company = s.company;
  store.ai = s.ai;
  store.user = s.user && s.user.role !== 'mechanic' && s.user.session_kind !== 'kiosk' ? s.user : null;
  if (store.user) {
    [store.settings, store.user] = await Promise.all([GET('/settings'), GET('/me')]);
    // Page d'accueil : menu des applications (comme Odoo) sauf si un lien précis est ouvert
    if ((!location.hash || location.hash === '#/' || location.hash === '#') && store.settings.options?.general?.start_page !== 'dashboard') go('/apps');
  }
  store.loading = false;
}

const app = createApp(Root);
Object.entries({ Icon, Badge, Modal, Picker, BarChart, Empty, Chatter, ModuleTools, MailComposer, ActivityBell }).forEach(([n, c]) => app.component(n, c));
app.config.globalProperties.money = money;
app.mount('#app');

// Sur téléphone, les tableaux deviennent des fiches : chaque cellule reçoit le titre de sa colonne
function labelTables(root = document) {
  for (const t of root.querySelectorAll('.content table')) {
    const heads = [...t.querySelectorAll(':scope > thead th')].map((th) => th.textContent.trim());
    if (!heads.length || t.closest('.ip')) continue; // les documents imprimés gardent leur tableau
    t.classList.add('stackable');
    for (const tr of t.querySelectorAll(':scope > tbody > tr, :scope > tfoot > tr')) {
      [...tr.children].forEach((td, i) => { if (heads[i] && td.dataset.label !== heads[i]) td.dataset.label = heads[i]; });
    }
  }
}
let labelTimer;
new MutationObserver(() => { clearTimeout(labelTimer); labelTimer = setTimeout(labelTables, 80); }).observe(document.getElementById('app'), { childList: true, subtree: true });

// Application installable / hors-ligne (HTTPS ou localhost)
if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
}
boot();
