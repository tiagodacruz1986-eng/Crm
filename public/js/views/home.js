// Menu d'accueil des applications (comme Odoo) : grille d'icônes sur un fond personnalisable.
import { ref, computed, onMounted, onUnmounted } from 'vue';
import { store, GET } from '../api.js';
import { go } from '../router.js';
import { visibleApps } from '../apps.js';

export const Home = {
  setup() {
    const q = ref('');
    const now = ref(new Date());
    const counts = ref({});
    const input = ref(null);
    let t;
    const apps = computed(() => {
      const s = q.value.trim().toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
      return visibleApps().filter((a) => !s || a.name.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').includes(s));
    });
    const open = (a) => { if (a.href) window.open(a.href, '_blank'); else go(a.to); };
    // Taper une lettre filtre les applications ; Entrée ouvre la première
    const onKey = (e) => {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.key.length === 1) { input.value?.focus(); }
    };
    onMounted(async () => {
      t = setInterval(() => { now.value = new Date(); }, 30_000);
      window.addEventListener('keydown', onKey);
      try { counts.value = await GET('/activities/counts'); } catch { /* pas bloquant */ }
    });
    onUnmounted(() => { clearInterval(t); window.removeEventListener('keydown', onKey); });
    const hello = computed(() => { const h = now.value.getHours(); return h < 12 ? 'Bonjour' : h < 18 ? 'Bon après-midi' : 'Bonsoir'; });
    const first = computed(() => (store.user?.name || '').split(' ')[0]);
    const bg = computed(() => {
      const v = store.settings?.home?.background_version;
      return v ? { backgroundImage: `linear-gradient(180deg, rgba(4,8,18,.45), rgba(4,8,18,.72)), url(/home-bg?v=${v})` } : {};
    });
    const logo = computed(() => (store.settings?.layout?.logo_version && !store.settings?.home?.background_version ? `/logo?v=${store.settings.layout.logo_version}` : null));
    const badge = (a) => (a.key === 'activities' ? (counts.value.late || 0) + (counts.value.today || 0) : 0);
    const enter = () => { if (apps.value[0]) open(apps.value[0]); };
    return { q, apps, open, hello, first, now, bg, logo, badge, input, enter, store };
  },
  template: `
  <div class="home" :class="{ custom: store.settings?.home?.background_version }" :style="bg">
    <img v-if="logo" :src="logo" class="home-watermark" alt="">
    <div class="home-head">
      <div>
        <h1>{{ hello }}, {{ first }}</h1>
        <div class="home-date">{{ now.toLocaleDateString('fr-LU', { weekday: 'long', day: 'numeric', month: 'long' }) }} · {{ now.toLocaleTimeString('fr-LU', { hour: '2-digit', minute: '2-digit' }) }}</div>
      </div>
      <div class="home-search"><Icon name="search"/><input ref="input" v-model="q" placeholder="Rechercher une application…" @keydown.enter="enter" @keydown.esc="q = ''"></div>
    </div>
    <div class="apps-grid">
      <a v-for="a in apps" :key="a.key" class="app-tile" :href="a.href || '#' + a.to" :target="a.href ? '_blank' : null">
        <span class="app-icon" :style="{ '--c1': a.c[0], '--c2': a.c[1] }"><i></i><Icon :name="a.icon"/><b v-if="badge(a)" class="app-badge">{{ badge(a) }}</b></span>
        <span class="app-name">{{ a.name }}</span>
      </a>
    </div>
    <p v-if="!apps.length" class="home-empty">Aucune application ne correspond à « {{ q }} ».</p>
  </div>`,
};
