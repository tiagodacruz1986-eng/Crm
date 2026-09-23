import { createApp, reactive, computed, defineAsyncComponent, ref, onMounted, onUnmounted } from 'vue';
import { store, GET, POST, money, DOC_TYPES_SHORT } from './api.js';
import { Badge, Modal, Picker, BarChart, Empty } from './components.js';

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
  office: lazy('office', 'Office'), settings: lazy('settings', 'Settings'),
};

const NAV = [
  { section: 'Pilotage' },
  { to: '/', icon: '🏠', label: 'Tableau de bord', match: 'dashboard' },
  { to: '/office', icon: '🤖', label: 'Bureau IA', match: 'office' },
  { section: 'Atelier' },
  { to: '/workshop', icon: '🔧', label: 'Atelier (OR)', match: 'workshop' },
  { to: '/planning', icon: '📅', label: 'Planning', match: 'planning' },
  { to: '/timesheets', icon: '⏱️', label: 'Pointage', match: 'timesheets' },
  { section: 'Ventes' },
  { to: '/documents/quote', icon: '📝', label: 'Devis', match: 'documents', type: 'quote' },
  { to: '/documents/invoice', icon: '🧾', label: 'Factures', match: 'documents', type: 'invoice' },
  { to: '/customers', icon: '👥', label: 'Clients', match: 'customers' },
  { to: '/vehicles', icon: '🚗', label: 'Véhicules', match: 'vehicles' },
  { section: 'Stock & achats' },
  { to: '/stock', icon: '📦', label: 'Articles & stock', match: 'stock' },
  { to: '/purchases', icon: '🛒', label: 'Achats', match: 'purchases' },
  { to: '/suppliers', icon: '🏭', label: 'Fournisseurs', match: 'suppliers' },
  { section: 'Finance' },
  { to: '/bank', icon: '🏦', label: 'Banque', match: 'bank' },
  { to: '/accounting', icon: '📚', label: 'Comptabilité', match: 'accounting' },
  { section: '' },
  { to: '/settings', icon: '⚙️', label: 'Paramètres', match: 'settings' },
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
      <div class="login-logo">🔧</div>
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
  components: { Login, GlobalSearch },
  setup() {
    const searchOpen = ref(false);
    const menuOpen = ref(false);
    const onKey = (e) => { if ((e.ctrlKey || e.metaKey) && e.key === 'k') { e.preventDefault(); searchOpen.value = true; } };
    onMounted(() => window.addEventListener('keydown', onKey));
    onUnmounted(() => window.removeEventListener('keydown', onKey));
    const view = computed(() => VIEWS[route.name] || VIEWS.dashboard);
    const isActive = (n) => n.match === route.name && (!n.type || n.type === route.params.type);
    const logout = async () => { await POST('/auth/logout'); store.user = null; };
    return { store, route, NAV, view, isActive, searchOpen, menuOpen, logout };
  },
  template: `
  <div v-if="store.loading" class="boot">🔧</div>
  <Login v-else-if="!store.user" :setup="store.needsSetup"/>
  <div v-else class="layout" :class="{'menu-open': menuOpen}">
    <aside class="sidebar" @click="menuOpen = false">
      <div class="brand"><span class="brand-logo">🔧</span><div><b>{{ store.company }}</b><small>Garage Manager</small></div></div>
      <nav>
        <template v-for="n in NAV">
          <div v-if="n.section !== undefined" class="nav-section">{{ n.section }}</div>
          <a v-else :href="'#' + n.to" :class="{active: isActive(n)}"><span>{{ n.icon }}</span>{{ n.label }}</a>
        </template>
      </nav>
      <div class="sidebar-foot">
        <a href="/kiosk.html" target="_blank">📟 Ouvrir le kiosque atelier</a>
        <div class="me">{{ store.user.name }} <button class="link" @click="logout">Déconnexion</button></div>
      </div>
    </aside>
    <main>
      <header class="topbar">
        <button class="icon-btn burger" @click="menuOpen = !menuOpen">☰</button>
        <button class="search-trigger" @click="searchOpen = true">🔍 Rechercher une plaque, un client, une facture… <kbd>Ctrl K</kbd></button>
        <div class="quick">
          <a class="btn" href="#/new/quote">+ Devis</a>
          <a class="btn primary" href="#/new/order">+ Ordre de réparation</a>
        </div>
      </header>
      <div class="content"><component :is="view" :key="route.path"/></div>
    </main>
    <GlobalSearch v-if="searchOpen" @close="searchOpen = false"/>
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
Object.entries({ Badge, Modal, Picker, BarChart, Empty }).forEach(([n, c]) => app.component(n, c));
app.config.globalProperties.money = money;
app.mount('#app');
boot();
