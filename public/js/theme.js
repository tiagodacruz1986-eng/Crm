// Thèmes du logiciel : clair (par défaut), sombre, verre, ou automatique (suit le réglage du téléphone / de l'ordinateur).
// « Verre » garde la base sombre (data-theme="dark") et ajoute l'habillage data-skin="glass" : panneaux en verre
// dépoli posés sur une photo floutée, titres à empattements.
import { reactive } from 'vue';

const KEY = 'garage_theme';
const media = window.matchMedia ? window.matchMedia('(prefers-color-scheme: light)') : null;
const read = () => { try { return localStorage.getItem(KEY) || 'light'; } catch { return 'light'; } };
const resolve = (pref) => (pref === 'auto' ? (media?.matches ? 'light' : 'dark') : pref === 'light' ? 'light' : 'dark');
const PREFS = ['light', 'dark', 'glass', 'auto'];

export const theme = reactive({ pref: read(), active: resolve(read()) });

function apply() {
  theme.active = resolve(theme.pref);
  document.documentElement.dataset.theme = theme.active;
  if (theme.pref === 'glass') document.documentElement.dataset.skin = 'glass'; else delete document.documentElement.dataset.skin;
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', theme.pref === 'glass' ? '#2b241f' : theme.active === 'light' ? '#f3f5f8' : '#0f1216');
}
export function setTheme(pref) {
  theme.pref = PREFS.includes(pref) ? pref : 'light';
  try { localStorage.setItem(KEY, theme.pref); } catch { /* navigation privée */ }
  // Transition douce entre les deux thèmes
  document.documentElement.classList.add('theme-anim');
  apply();
  setTimeout(() => document.documentElement.classList.remove('theme-anim'), 450);
}
export const toggleTheme = () => setTheme(theme.active === 'dark' ? 'light' : 'dark');
media?.addEventListener?.('change', () => { if (theme.pref === 'auto') apply(); });
apply();

export const THEMES = [
  { id: 'light', name: 'Clair', desc: 'Sobre et net, comme un logiciel de bureau', icon: 'sun' },
  { id: 'dark', name: 'Sombre', desc: 'Les mêmes écrans sur fond foncé, reposant le soir', icon: 'moon' },
  { id: 'glass', name: 'Verre', desc: 'Panneaux en verre dépoli sur une photo, comme visionOS', icon: 'sparkles' },
  { id: 'auto', name: 'Automatique', desc: 'Suit le réglage de votre téléphone ou ordinateur', icon: 'monitor-smartphone' },
];

// Choix du thème avec aperçus
export const ThemePicker = {
  setup() { return { theme, setTheme, THEMES }; },
  template: `
  <div class="theme-picker">
    <button v-for="t in THEMES" :key="t.id" class="theme-card" :class="{ on: theme.pref === t.id }" @click="setTheme(t.id)">
      <div class="theme-prev" :class="'tpv-' + t.id">
        <div class="tp-half tp-dark"><i class="tp-bar"></i><i class="tp-side"></i><i class="tp-card"></i><i class="tp-card b"></i><i class="tp-btn"></i></div>
        <div class="tp-half tp-light"><i class="tp-bar"></i><i class="tp-side"></i><i class="tp-card"></i><i class="tp-card b"></i><i class="tp-btn"></i></div>
      </div>
      <div class="theme-lbl"><Icon :name="t.icon"/><b>{{ t.name }}</b><span v-if="theme.pref === t.id" class="theme-check"><Icon name="check"/></span></div>
      <small>{{ t.desc }}</small>
    </button>
  </div>`,
};
