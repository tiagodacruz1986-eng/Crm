// Fenêtre « Sur téléphone / tablette » : QR codes vers la page d'installation, adresse sécurisée (https),
// et explications pour obtenir une vraie application installée sur le téléphone.
import { ref, computed, onMounted } from 'vue';
import { GET, PUT, act, store } from './api.js';

const GUIDE = 'https://github.com/tiagodacruz1986-eng/Crm#-installer-sur-t%C3%A9l%C3%A9phone';

export const DevicesModal = {
  emits: ['close'],
  setup() {
    const net = ref(null);
    const target = ref('app');
    const editing = ref(false);
    const draft = ref('');
    const load = async () => { net.value = await GET('/network'); };
    onMounted(load);
    // Si le logiciel est ouvert en https (Tailscale, serveur internet…), cette adresse est sécurisée
    const secure = computed(() => net.value?.secure_url || (location.protocol === 'https:' ? location.origin + '/' : null));
    const suffix = computed(() => (target.value === 'kiosk' ? 'installer.html?app=kiosk' : 'installer.html'));
    const qr = (base) => '/api/qr.svg?text=' + encodeURIComponent(base.replace(/\/?$/, '/') + suffix.value);
    const saveUrl = async () => {
      const v = draft.value.trim().replace(/\/+$/, '');
      if (v && !/^https:\/\/[^\s/]+/.test(v)) return alert("L'adresse doit commencer par https://");
      store.settings = await act(() => PUT('/settings', { public_url: v }), 'Adresse enregistrée');
      editing.value = false;
      load();
    };
    return { net, target, secure, qr, suffix, editing, draft, saveUrl, store, GUIDE };
  },
  template: `
  <Modal title="📱 Installer sur téléphone et tablette" wide @close="$emit('close')">
    <div class="seg" style="margin-bottom:14px"><button :class="{ on: target === 'app' }" @click="target = 'app'">💼 Logiciel</button><button :class="{ on: target === 'kiosk' }" @click="target = 'kiosk'">⏱️ Pointage atelier (tablette)</button></div>
    <div v-if="net" class="dev-grid">
      <section class="dev-card" :class="{ best: secure }">
        <h3>🔒 Adresse sécurisée <span class="badge b-green" v-if="secure">recommandé</span></h3>
        <template v-if="secure">
          <img :src="qr(secure)" alt="QR code" class="dev-qr">
          <div class="dev-url">{{ secure }}{{ suffix }}</div>
          <p class="small">Vraie application installée (icône, plein écran, hors-ligne), <b>au garage et en 4G</b>. Scannez avec l'appareil photo du téléphone et suivez les étapes.</p>
        </template>
        <template v-else>
          <p class="small">Pour une <b>vraie application</b> sur le téléphone, le logiciel doit être joignable en <b>https</b>. Deux solutions :</p>
          <ul class="small dev-list">
            <li><b>Tailscale</b> (privé : seulement vos appareils ; prenez l'offre professionnelle pour un garage) — installez Tailscale sur ce PC et sur le téléphone, puis double-cliquez sur <code>acces-telephone-windows.bat</code> (ou <code>-mac.command</code>).</li>
            <li><b>Serveur internet</b> avec votre nom de domaine (ex. <code>atelier.votre-garage.lu</code>) — nécessaire aussi pour le site web public et les liens de suivi des clients.</li>
          </ul>
          <a class="btn sm" :href="GUIDE" target="_blank" rel="noopener">Guide pas à pas</a>
        </template>
        <div v-if="store.user?.role === 'admin'" class="dev-edit">
          <button v-if="!editing" class="link small" @click="editing = true; draft = store.settings?.public_url || ''">{{ secure ? 'Modifier l\\'adresse sécurisée' : 'J\\'ai déjà une adresse https' }}</button>
          <div v-else class="btns"><input v-model="draft" placeholder="https://mon-pc.tailnet.ts.net"><button class="btn sm primary" @click="saveUrl">Enregistrer</button></div>
        </div>
      </section>
      <section v-if="!net.internet_server" class="dev-card">
        <h3>📶 Sur le Wi-Fi du garage</h3>
        <template v-if="net.lan.length">
          <div v-for="u in net.lan" :key="u" class="dev-lan"><img :src="qr(u)" alt="QR code" class="dev-qr"><div class="dev-url">{{ u }}{{ suffix }}</div></div>
          <p class="small">Le téléphone doit être <b>sur le même Wi-Fi</b> que ce PC. Sans https : <b>iPhone</b> → icône sur l'écran d'accueil ; <b>Android</b> → simple raccourci, pas de mode hors-ligne.</p>
        </template>
        <p v-else class="error small">Aucune adresse réseau trouvée : vérifiez que le PC est connecté au Wi-Fi ou au câble.</p>
      </section>
    </div>
    <p v-if="net && !net.internet_server" class="muted small">Astuce : laissez ce PC allumé (et en veille désactivée) pendant les heures d'ouverture, c'est lui qui fait tourner le logiciel.</p>
  </Modal>`,
};
