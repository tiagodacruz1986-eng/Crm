import { reactive } from 'vue';

// ---------- Routeur (hash) ----------
export const route = reactive({ path: '', params: {}, query: {} });
export const go = (p) => { location.hash = p; };
export const ROUTES = [
  ['/', 'dashboard'], ['/workshop', 'workshop'], ['/planning', 'planning'],
  ['/documents/:type', 'documents'], ['/document/:id', 'document'], ['/new/:type', 'document'],
  ['/customers', 'customers'], ['/customer/:id', 'customer'], ['/vehicles', 'vehicles'], ['/vehicle/:id', 'vehicle'],
  ['/stock', 'stock'], ['/product/:id', 'product'], ['/purchases', 'purchases'], ['/purchase/:id', 'purchase'], ['/suppliers', 'suppliers'],
  ['/accounting', 'accounting'], ['/bank', 'bank'], ['/timesheets', 'timesheets'], ['/office', 'office'], ['/activities', 'activities'], ['/copilot', 'copilot'], ['/mail', 'mail'], ['/settings', 'settings'],
  ['/apps', 'apps'], ['/crm', 'crm'], ['/website', 'website'], ['/social', 'social'], ['/attendance', 'attendance'], ['/invite/:token', 'invite'],
];
function parseRoute() {
  const [path, qs] = (location.hash.slice(1) || '/').split('?');
  route.query = Object.fromEntries(new URLSearchParams(qs || ''));
  for (const [pattern, name] of ROUTES) {
    const keys = [];
    const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '$');
    const m = re.exec(path);
    if (m) {
      route.path = path;
      route.name = name;
      route.params = Object.fromEntries(keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
      if (pattern === '/new/:type') route.params = { id: 'new', type: route.params.type };
      return;
    }
  }
  route.name = 'dashboard';
}
// Avant de quitter une page (ex. OR modifié et non enregistré) : une garde peut demander confirmation.
// Si l'utilisateur refuse, on remet l'adresse précédente sans changer de page.
export const leaveGuards = new Set();
let current = location.hash;
window.addEventListener('hashchange', () => {
  for (const ok of leaveGuards) if (!ok()) { history.replaceState(null, '', current || '#/'); return; }
  current = location.hash;
  parseRoute();
});
parseRoute();

