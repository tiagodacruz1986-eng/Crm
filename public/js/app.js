import { createApp, reactive, computed, defineAsyncComponent, ref, onMounted, onUnmounted, watch } from 'vue';
import { store, GET, POST, money, DOC_TYPES_SHORT } from './api.js';
import { Badge, Modal, Picker, BarChart, Empty, Icon } from './components.js';
import { Chatter, ModuleTools, MailComposer, ActivityBell } from './mail.js';

import { route, go } from './router.js';

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
  office: lazy('office', 'Office'), activities: lazy('activities', 'Activities'), copilot: defineAsyncComponent(() => import('./copilot.js').then((m) => m.CopilotPage)), mail: lazy('activities', 'MailOutbox'), settings: lazy('settings', 'Settings'),
};

const NAV = [
  { section: 'Pilotage' },
  { to: '/', icon: 'layout-dashboard', label: 'Tableau de bord', match: 'dashboard' },
  { to: '/copilot', icon: 'sparkles', label: 'Nova — copilote', match: 'copilot' },
  { to: '/office', icon: 'brain', label: 'Bureau IA', match: 'office' },
  { to: '/activities', icon: 'alarm-clock', label: 'Activités', match: 'activities' },
  { to: '/mail', icon: 'mail', label: 'E-mails', match: 'mail' },
  { section: 'Atelier' },
  { to: '/workshop', icon: 'wrench', label: 'Atelier (OR)', match: 'workshop' },
  { to: '/planning', icon: 'calendar-days', label: 'Planning', match: 'planning' },
  { to: '/timesheets', icon: 'timer', label: 'Pointage', match: 'timesheets' },
  { section: 'Ventes' },
  { to: '/documents/quote', icon: 'file-text', label: 'Devis', match: 'documents', type: 'quote' },
  { to: '/documents/invoice', icon: 'receipt', label: 'Factures', match: 'documents', type: 'invoice' },
  { to: '/customers', icon: 'users', label: 'Clients', match: 'customers' },
  { to: '/vehicles', icon: 'car', label: 'Véhicules', match: 'vehicles' },
  { section: 'Stock & achats' },
  { to: '/stock', icon: 'package', label: 'Articles & stock', match: 'stock' },
  { to: '/purchases', icon: 'shopping-cart', label: 'Achats', match: 'purchases' },
  { to: '/suppliers', icon: 'factory', label: 'Fournisseurs', match: 'suppliers' },
  { section: 'Finance' },
  { to: '/bank', icon: 'landmark', label: 'Banque', match: 'bank' },
  { to: '/accounting', icon: 'book-open', label: 'Comptabilité', match: 'accounting' },
  { section: '' },
  { to: '/settings', icon: 'settings', label: 'Paramètres', match: 'settings' },
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
    return { f, err, submit };
  },
  template: `
  <div class="login-bg">
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
  components: { Login, GlobalSearch, Copilot: defineAsyncComponent(() => import('./copilot.js').then((m) => m.Copilot)) },
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
    const theme = ref(document.documentElement.dataset.theme || 'dark');
    const toggleTheme = () => {
      theme.value = theme.value === 'dark' ? 'light' : 'dark';
      document.documentElement.dataset.theme = theme.value;
      try { localStorage.setItem('garage_theme', theme.value); } catch { /* navigation privée */ }
    };
    const devices = ref(null);
    const openDevices = async () => { devices.value = await GET('/network'); };
    // Installation comme application (Chrome, Edge, Android)
    const installable = ref(false);
    let deferred = null;
    window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); deferred = e; installable.value = true; });
    const install = async () => { if (!deferred) return; deferred.prompt(); await deferred.userChoice; deferred = null; installable.value = false; };
    watch(() => route.path, () => { menuOpen.value = false; plusOpen.value = false; });
    return { theme, toggleTheme, store, route, NAV, view, isActive, searchOpen, menuOpen, logout, plusOpen, devices, openDevices, installable, install, encodeURIComponent };
  },
  template: `
  <div v-if="store.loading" class="boot">🔧</div>
  <Login v-else-if="!store.user" :setup="store.needsSetup"/>
  <div v-else class="layout" :class="{'menu-open': menuOpen}">
    <aside class="sidebar" @click="menuOpen = false">
      <div class="brand"><span class="brand-logo"><Icon name="wrench"/></span><div><b>{{ store.company }}</b><small>Garage OS</small></div></div>
      <nav>
        <template v-for="n in NAV">
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
        <button class="icon-btn burger" @click="menuOpen = !menuOpen">☰</button>
        <button class="search-trigger" @click="searchOpen = true"><span style="display:flex;gap:8px;align-items:center"><Icon name="search"/> <span class="long">Rechercher une plaque, un client, une facture…</span><span class="short">Rechercher…</span></span> <kbd>Ctrl K</kbd></button>
        <div class="quick">
          <button class="btn theme-toggle" @click="toggleTheme" :title="theme === 'dark' ? 'Thème clair' : 'Thème sombre'"><Icon :name="theme === 'dark' ? 'sun' : 'moon'"/></button>
          <ActivityBell/>
          <a class="btn hide-phone" href="#/new/quote">+ Devis</a>
          <a class="btn primary hide-phone" href="#/new/order">+ <span class="long">Ordre de réparation</span><span class="short">OR</span></a>
        </div>
      </header>
      <div class="content"><component :is="view" :key="route.path"/></div>
    </main>
    <nav class="bottom-nav">
      <a href="#/" :class="{active: route.name === 'dashboard'}"><Icon name="home"/>Accueil</a>
      <a href="#/workshop" :class="{active: route.name === 'workshop'}"><Icon name="wrench"/>Atelier</a>
      <a href="#" class="plus" @click.prevent="plusOpen = !plusOpen"><span class="plus-btn"><Icon name="plus"/></span></a>
      <a href="#/planning" :class="{active: route.name === 'planning'}"><Icon name="calendar-days"/>Planning</a>
      <a href="#" @click.prevent="menuOpen = true"><Icon name="menu"/>Menu</a>
    </nav>
    <div v-if="plusOpen" class="plus-menu" @click="plusOpen = false">
      <div>
        <a href="#/new/order">🔧 Ordre de réparation</a><a href="#/new/quote">📝 Devis</a><a href="#/new/invoice">🧾 Facture</a>
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
  store.user = s.user && s.user.role !== 'mechanic' ? s.user : null;
  if (store.user) store.settings = await GET('/settings');
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
    if (!heads.length) continue;
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
