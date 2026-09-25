// Panneau "Suivi en direct" d'un OR (bureau) : jauge, liens client / mécanicien, photos, vidéos et messages.
import { ref, reactive, computed, onMounted, onUnmounted } from 'vue';
import { GET, POST, DEL, act, toast } from './api.js';
import { MailComposer } from './mail.js';

export const LivePanel = {
  props: { docId: [Number, String] },
  components: { MailComposer },
  setup(props) {
    const d = ref(null);
    const text = ref('');
    const isPublic = ref(true);
    const approval = reactive({ open: false, amount: null });
    const upload = reactive({ busy: false, pct: 0 });
    const qr = ref(null);
    const mail = ref(false);
    let es;
    const load = async () => { d.value = await GET(`/live/${props.docId}`); };
    onMounted(() => {
      load();
      es = new EventSource(`/api/live/${props.docId}/events`);
      es.onmessage = load;
    });
    onUnmounted(() => es?.close());
    const link = (role) => d.value?.links.find((l) => l.role === role);
    const create = async (role) => { await act(() => POST(`/live/${props.docId}/links`, { role })); await load(); };
    const revoke = async (role) => { if (!confirm('Désactiver ce lien ? La personne ne pourra plus l\'ouvrir.')) return; await act(() => DEL(`/live/${props.docId}/links/${role}`)); await load(); };
    const copy = (u) => { navigator.clipboard?.writeText(u); toast('Lien copié'); };
    const localOnly = computed(() => { const u = link('customer')?.url || link('mechanic')?.url || ''; return /\/\/(localhost|127\.|192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/.test(u); });
    const message = computed(() => `Bonjour, suivez en direct la réparation de votre véhicule ${d.value?.order.plate || ''} chez ${d.value?.garage.name} : ${link('customer')?.url}`);
    const pct = computed(() => d.value ? Math.round((d.value.stage_index / (d.value.stages.length - 1)) * 100) : 0);
    const setStage = async (s) => { await act(() => POST(`/live/${props.docId}/stage`, { stage: s.key })); load(); };
    const send = async () => {
      await act(() => POST(`/live/${props.docId}/posts`, approval.open ? { body: text.value, kind: 'approval', amount: approval.amount } : { body: text.value, public: isPublic.value }));
      text.value = ''; approval.open = false; approval.amount = null; load();
    };
    const sendFile = async (e) => {
      for (const f of [...e.target.files]) {
        upload.busy = true; upload.pct = 0;
        await new Promise((resolve) => {
          const x = new XMLHttpRequest();
          x.open('POST', `/api/live/${props.docId}/upload`);
          x.setRequestHeader('Content-Type', f.type || 'application/octet-stream');
          x.setRequestHeader('X-Filename', encodeURIComponent(f.name));
          x.setRequestHeader('X-Caption', encodeURIComponent(text.value));
          x.setRequestHeader('X-Public', isPublic.value ? '1' : '0');
          x.upload.onprogress = (ev) => { if (ev.lengthComputable) upload.pct = Math.round((ev.loaded / ev.total) * 100); };
          x.onload = () => { if (x.status >= 400) toast(JSON.parse(x.responseText || '{}').error || 'Envoi impossible', 'error'); else text.value = ''; resolve(); };
          x.onerror = () => { toast('Envoi impossible', 'error'); resolve(); };
          x.send(f);
        });
      }
      e.target.value = '';
      upload.busy = false;
      load();
    };
    const when = (s) => new Date(s.replace(' ', 'T') + 'Z').toLocaleString('fr-LU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
    const openMail = async () => { if (!link('customer')) await create('customer'); mail.value = true; };
    return { d, text, isPublic, approval, upload, qr, mail, link, create, revoke, copy, localOnly, message, pct, setStage, send, sendFile, when, openMail, encodeURIComponent };
  },
  template: `
  <div class="card live-panel no-print" v-if="d">
    <div class="card-head"><h2 style="margin:0">📡 Suivi en direct</h2><span class="small"><b>{{ d.stages[d.stage_index].label }}</b> · {{ pct }}%</span></div>
    <div class="live-steps">
      <button v-for="(s, i) in d.stages" :class="{done: i < d.stage_index, cur: i === d.stage_index}" @click="setStage(s)" :title="s.label">
        <span>{{ i < d.stage_index ? '✓' : s.icon }}</span><small>{{ s.label }}</small>
      </button>
    </div>
    <div class="live-bar"><div :style="{width: pct + '%'}"></div></div>

    <div class="live-links">
      <div v-for="[role, label, icon] in [['customer', 'Lien client', '👤'], ['mechanic', 'Lien mécanicien', '🔧']]" class="live-link">
        <b>{{ icon }} {{ label }}</b>
        <template v-if="link(role)">
          <input :value="link(role).url" readonly style="margin-top:6px" @focus="$event.target.select()">
          <div class="btns" style="margin-top:6px">
            <button class="btn sm" @click="copy(link(role).url)">Copier</button>
            <a class="btn sm" :href="link(role).url" target="_blank">Ouvrir</a>
            <button class="btn sm" @click="qr = link(role).url">QR</button>
            <button class="btn sm danger" @click="revoke(role)" title="Désactiver">✕</button>
          </div>
          <div v-if="role === 'customer'" class="btns" style="margin-top:6px">
            <button class="btn sm" @click="openMail">✉️ E-mail</button>
            <a class="btn sm" :href="'https://wa.me/?text=' + encodeURIComponent(message)" target="_blank">WhatsApp</a>
            <a class="btn sm" :href="'sms:?&body=' + encodeURIComponent(message)">SMS</a>
          </div>
          <div class="muted small" v-if="link(role).last_seen">Ouvert pour la dernière fois : {{ new Date(link(role).last_seen).toLocaleString('fr-LU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) }}</div>
        </template>
        <button v-else class="btn sm" style="margin-top:6px" @click="create(role)">Créer le lien</button>
      </div>
    </div>
    <div v-if="localOnly" class="stock-warn" style="margin:8px 0">⚠ Ces liens ne fonctionnent que sur le réseau du garage. Pour que le client les ouvre depuis chez lui, renseignez l'adresse publique du logiciel (Paramètres → Atelier & factures).</div>

    <div class="live-feed">
      <template v-for="p in d.posts" :key="p.id">
        <div v-if="p.kind === 'stage'" class="muted small" style="text-align:center;margin:6px 0">{{ p.body }} · {{ when(p.created_at) }}</div>
        <div v-else class="live-post" :class="[p.author_role, {private: !p.public, approval: p.kind === 'approval'}]">
          <div class="small muted">{{ p.author_role === 'customer' ? '👤 Client' : p.author_name }} · {{ when(p.created_at) }}<span v-if="!p.public"> · 🔒 interne</span></div>
          <div v-if="p.kind === 'approval'"><b>Accord demandé :</b> {{ p.body }} — <b>{{ p.amount.toFixed(2) }} € TTC</b>
            <span v-if="p.answer" :class="p.answer === 'accepted' ? 'pos' : 'neg'"> · {{ p.answer === 'accepted' ? '✅ accepté' : '❌ refusé' }}</span><span v-else class="muted"> · en attente</span></div>
          <div v-else-if="p.body" style="white-space:pre-wrap">{{ p.body }}</div>
          <a v-if="p.media_type === 'image'" :href="'/api/live/' + docId + '/media/' + p.id" target="_blank"><img :src="'/api/live/' + docId + '/media/' + p.id" loading="lazy"></a>
          <video v-if="p.media_type === 'video'" :src="'/api/live/' + docId + '/media/' + p.id" controls preload="metadata"></video>
        </div>
      </template>
      <div v-if="!d.posts.length" class="muted small">Aucun échange. Envoyez le lien au mécanicien et au client.</div>
    </div>
    <div v-if="upload.busy" class="live-bar" style="height:6px"><div :style="{width: upload.pct + '%'}"></div></div>
    <div class="btns small" style="margin-top:8px">
      <label class="check"><input type="checkbox" v-model="isPublic" :disabled="approval.open"> Visible par le client</label>
      <label class="check"><input type="checkbox" v-model="approval.open"> Demander l'accord du client</label>
      <input v-if="approval.open" v-model.number="approval.amount" type="number" step="0.01" placeholder="Montant TTC" style="width:120px">
    </div>
    <div class="btns" style="margin-top:6px">
      <label class="btn" title="Photo / vidéo">📷<input type="file" accept="image/*,video/*" multiple hidden @change="sendFile"></label>
      <input v-model="text" style="flex:1" :placeholder="approval.open ? 'Travaux proposés…' : 'Message au client / à l\\'atelier…'" @keydown.enter="text.trim() && send()">
      <button class="btn primary" :disabled="!text.trim() || (approval.open && !approval.amount)" @click="send">➤</button>
    </div>
    <Modal v-if="qr" title="QR code du lien" @close="qr = null"><img :src="'/api/qr.svg?text=' + encodeURIComponent(qr)" style="width:260px;margin:0 auto;display:block"><p class="muted small" style="text-align:center">À scanner avec le téléphone</p></Modal>
    <MailComposer v-if="mail" model="document" :record-id="docId" template="live_tracking" @close="mail = false"/>
  </div>`,
};
