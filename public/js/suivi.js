// Page de suivi d'un OR ouverte depuis un lien : client (jauge + échanges) ou mécanicien (photos, vidéos, étapes).
import { createApp, ref, reactive, computed, onMounted, nextTick } from 'vue';

const token = new URLSearchParams(location.search).get('t');
const API = `/live-api/${encodeURIComponent(token || '')}`;

// Réduit les photos avant envoi (plus rapide en 4G)
async function shrinkImage(file) {
  if (!file.type.startsWith('image/') || file.type === 'image/gif' || file.size < 1_500_000) return file;
  try {
    const bmp = await createImageBitmap(file);
    const scale = Math.min(1, 1920 / Math.max(bmp.width, bmp.height));
    const c = document.createElement('canvas');
    c.width = Math.round(bmp.width * scale); c.height = Math.round(bmp.height * scale);
    c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
    const blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.85));
    return blob ? new File([blob], file.name.replace(/\.\w+$/, '.jpg'), { type: 'image/jpeg' }) : file;
  } catch { return file; }
}

const App = {
  setup() {
    const d = ref(null);
    const err = ref('');
    const text = ref('');
    const isPublic = ref(true);
    const approval = reactive({ open: false, amount: null });
    const upload = reactive({ busy: false, pct: 0 });
    const name = ref(localStorage.getItem('garage_mech_name') || '');
    const feedEl = ref(null);
    const live = ref(false);

    const isMech = computed(() => d.value?.role === 'mechanic');
    const pct = computed(() => d.value ? Math.round((d.value.stage_index / (d.value.stages.length - 1)) * 100) : 0);
    const cur = computed(() => d.value?.stages[d.value.stage_index]);

    const load = async () => {
      const r = await fetch(API);
      const j = await r.json();
      if (!r.ok) { err.value = j.error || 'Lien invalide'; return; }
      const grew = !d.value || j.posts.length !== d.value.posts.length;
      d.value = j;
      document.title = `${j.order.number} — ${j.garage.name}`;
      if (grew) nextTick(() => window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' }));
    };
    onMounted(async () => {
      if (!token) { err.value = 'Lien incomplet'; return; }
      await load();
      const es = new EventSource(`${API}/events`);
      es.onopen = () => { live.value = true; };
      es.onerror = () => { live.value = false; };
      es.onmessage = () => load();
      setInterval(load, 60000); // filet de sécurité si le temps réel est coupé
    });

    const post = async (body) => {
      const r = await fetch(`${API}/posts`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error);
    };
    const send = async () => {
      if (!text.value.trim()) return;
      try {
        if (approval.open) await post({ body: text.value, kind: 'approval', amount: approval.amount, name: name.value });
        else await post({ body: text.value, public: isPublic.value, name: name.value });
        text.value = ''; approval.open = false; approval.amount = null;
        await load();
      } catch (e) { alert(e.message); }
    };
    const sendFile = async (e) => {
      const files = [...e.target.files];
      e.target.value = '';
      for (let f of files) {
        f = await shrinkImage(f);
        upload.busy = true; upload.pct = 0;
        await new Promise((resolve) => {
          const x = new XMLHttpRequest();
          x.open('POST', `${API}/upload`);
          x.setRequestHeader('Content-Type', f.type || 'application/octet-stream');
          x.setRequestHeader('X-Filename', encodeURIComponent(f.name));
          x.setRequestHeader('X-Caption', encodeURIComponent(text.value));
          x.setRequestHeader('X-Author', encodeURIComponent(name.value || 'Mécanicien'));
          x.setRequestHeader('X-Public', isPublic.value ? '1' : '0');
          x.upload.onprogress = (ev) => { if (ev.lengthComputable) upload.pct = Math.round((ev.loaded / ev.total) * 100); };
          x.onload = () => { if (x.status >= 400) alert(JSON.parse(x.responseText || '{}').error || 'Envoi impossible'); else text.value = ''; resolve(); };
          x.onerror = () => { alert('Connexion perdue pendant l\'envoi'); resolve(); };
          x.send(f);
        });
      }
      upload.busy = false;
      load();
    };
    const setStage = async (s) => {
      if (!isMech.value) return;
      await fetch(`${API}/stage`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ stage: s.key, name: name.value || 'Mécanicien' }) });
      load();
    };
    const toggleLine = async (l) => {
      await fetch(`${API}/lines/${l.id}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ done: !l.done }) });
      load();
    };
    const answer = async (p, a) => {
      if (!confirm(a === 'accepted' ? `Confirmer : j'accepte ces travaux pour ${p.amount.toFixed(2)} € TTC ?` : 'Confirmer le refus de ces travaux ?')) return;
      const r = await fetch(`${API}/posts/${p.id}/answer`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ answer: a }) });
      if (!r.ok) alert((await r.json()).error);
      load();
    };
    const saveName = () => localStorage.setItem('garage_mech_name', name.value);
    const mine = (p) => (isMech.value ? ['mechanic'].includes(p.author_role) : p.author_role === 'customer');
    const side = (p) => (p.author_role === 'customer' ? 'customer' : 'garage');
    const when = (s) => new Date(s.replace(' ', 'T') + 'Z').toLocaleString('fr-LU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
    const promised = computed(() => d.value?.order.promised_at ? new Date(d.value.order.promised_at).toLocaleString('fr-LU', { weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' }) : null);
    return { d, err, text, isPublic, approval, upload, name, feedEl, live, isMech, pct, cur, send, sendFile, setStage, toggleLine, answer, saveName, mine, side, when, promised, API };
  },
  template: `
  <div class="wrap">
    <div v-if="err" class="center"><div style="font-size:48px">🔒</div><h2>{{ err }}</h2></div>
    <div v-else-if="!d" class="center muted">Chargement…</div>
    <template v-else>
      <div class="head">
        <div class="garage"><img v-if="d.garage.logo" :src="d.garage.logo" :alt="d.garage.name" class="garage-logo"><template v-else>{{ d.garage.name }}</template> <span class="live" v-if="live" style="float:right">en direct</span></div>
        <h1>{{ isMech ? '🔧 ' : '' }}{{ d.order.make }} {{ d.order.model }}</h1>
        <div><span class="plate" v-if="d.order.plate">{{ d.order.plate }}</span> <span style="opacity:.85">· {{ d.order.number }}</span></div>
        <div v-if="promised" style="margin-top:8px;font-size:14px">⏰ Prévu : {{ promised }}</div>
      </div>

      <div class="card">
        <div class="gauge-top">
          <div><div class="muted small">{{ isMech ? 'Étape actuelle (touchez pour changer)' : 'Avancement des travaux' }}</div><div class="cur">{{ cur.icon }} {{ cur.label }}</div></div>
          <div class="pct">{{ pct }}%</div>
        </div>
        <div class="bar"><div :style="{width: pct + '%'}"></div></div>
        <div class="steps">
          <div v-for="(s, i) in d.stages" class="step" :class="{done: i < d.stage_index, cur: i === d.stage_index, clickable: isMech}" @click="setStage(s)">
            <div class="dot">{{ i < d.stage_index ? '✓' : s.icon }}</div>{{ s.label }}
          </div>
        </div>
      </div>

      <div class="card" v-if="d.order.customer_complaint">
        <div class="muted small">Demande</div><div>{{ d.order.customer_complaint }}</div>
        <template v-if="isMech && d.order.diagnosis"><div class="muted small" style="margin-top:8px">Diagnostic</div><div>{{ d.order.diagnosis }}</div></template>
      </div>

      <div class="card checklist" v-if="isMech && d.lines && d.lines.length">
        <div class="muted small" style="border:0;cursor:default">Travaux à réaliser</div>
        <div v-for="l in d.lines" :class="{done: l.done}" @click="toggleLine(l)"><span class="box">{{ l.done ? '✓' : '' }}</span><span>{{ l.description }}</span></div>
      </div>

      <div ref="feedEl">
        <template v-for="p in d.posts" :key="p.id">
          <div v-if="p.kind === 'stage'" class="sys"><span>{{ p.body }} · {{ when(p.created_at) }}</span></div>
          <div v-else class="post" :class="[side(p), {mine: mine(p)}]">
            <div class="av">{{ p.author_role === 'customer' ? '👤' : (p.author_name || 'G')[0] }}</div>
            <div class="bubble" :class="{private: !p.public, approval: p.kind === 'approval'}">
              <div class="meta">{{ p.author_role === 'customer' ? 'Client' : p.author_name }} · {{ when(p.created_at) }}<span v-if="!p.public"> · 🔒 interne</span></div>
              <template v-if="p.kind === 'approval'">
                <div><b>Travaux supplémentaires proposés</b></div>
                <div>{{ p.body }}</div>
                <div class="amt">{{ p.amount.toFixed(2) }} € TTC</div>
                <div v-if="p.answer" :style="{color: p.answer === 'accepted' ? 'var(--ok)' : 'var(--bad)', fontWeight: 700}">{{ p.answer === 'accepted' ? '✅ Accepté' : '❌ Refusé' }}</div>
                <div v-else-if="d.role === 'customer'" class="btns"><button class="btn ok" @click="answer(p, 'accepted')">✅ J'accepte</button><button class="btn no" @click="answer(p, 'refused')">Refuser</button></div>
                <div v-else class="muted small">En attente de la réponse du client…</div>
              </template>
              <div v-else-if="p.body" style="white-space:pre-wrap">{{ p.body }}</div>
              <img v-if="p.media_type === 'image'" :src="API + '/media/' + p.id" loading="lazy" @click="window.open(API + '/media/' + p.id)">
              <video v-if="p.media_type === 'video'" :src="API + '/media/' + p.id" controls playsinline preload="metadata"></video>
            </div>
          </div>
        </template>
        <div v-if="!d.posts.length" class="muted small" style="text-align:center;padding:20px">{{ isMech ? 'Envoyez des photos ou vidéos au client : pièces usées, diagnostic, travaux terminés…' : 'Le garage vous enverra ici photos, vidéos et informations sur votre véhicule.' }}</div>
      </div>

      <div class="composer">
        <div class="inner">
          <div v-if="upload.busy" class="progress"><div :style="{width: upload.pct + '%'}"></div></div>
          <div class="opts" v-if="isMech">
            <input v-model="name" @change="saveName" placeholder="Votre prénom" style="width:140px;padding:6px 10px">
            <label><input type="checkbox" v-model="isPublic" :disabled="approval.open"> Visible par le client</label>
            <label><input type="checkbox" v-model="approval.open"> Demander l'accord du client</label>
            <input v-if="approval.open" v-model.number="approval.amount" type="number" step="0.01" placeholder="Montant TTC €" style="width:130px;padding:6px 10px">
          </div>
          <div class="row">
            <label class="icon-btn" title="Photo ou vidéo">📷<input type="file" accept="image/*,video/*" multiple hidden @change="sendFile"></label>
            <textarea v-model="text" rows="1" :placeholder="approval.open ? 'Ex. : Plaquettes arrière à remplacer' : isMech ? 'Message ou légende de la photo…' : 'Écrire au garage…'"></textarea>
            <button class="icon-btn send" :disabled="!text.trim() || upload.busy || (approval.open && !approval.amount)" @click="send">➤</button>
          </div>
        </div>
      </div>
    </template>
  </div>`,
};

const app = createApp(App);
app.config.globalProperties.window = window;
app.mount('#app');
