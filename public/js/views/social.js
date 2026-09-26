// Marketing social (inspiré d'Odoo) : composer, prévisualiser, programmer et publier ; idées et textes par l'IA.
import { ref, reactive, computed, onMounted, watch } from 'vue';
import { GET, POST, PUT, DEL, act, toast, store, datetime } from '../api.js';
import { route, go } from '../router.js';

const STATUS = { draft: ['Brouillon', 'gray'], scheduled: ['Programmée', 'blue'], published: ['Publiée', 'green'], partial: ['En partie publiée', 'orange'], manual: ['À publier à la main', 'purple'], error: ['Erreur', 'red'] };
const PICON = { facebook: 'f', instagram: '◎', google: 'G', linkedin: 'in', tiktok: '♪' };
const monthStart = (d = new Date()) => new Date(d.getFullYear(), d.getMonth(), 1);
const iso = (d) => new Date(d - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);

export const Social = {
  setup() {
    const view = ref(route.query.view || 'posts');
    const meta = ref(null);
    const posts = ref([]);
    const edit = ref(null);
    const ai = reactive({ topic: '', tone: 'chaleureux', busy: false, variants: [], ideas: [], ideasBusy: false });
    const month = ref(monthStart());
    const acc = reactive({ facebook: { page_id: '', token: '', name: '' }, instagram: { ig_user_id: '', token: '', name: '' } });

    const load = async () => { [meta.value, posts.value] = await Promise.all([GET('/social'), GET('/social/posts')]); };
    onMounted(load);
    watch(() => route.query.view, (v) => { view.value = v || 'posts'; });
    const setView = (v) => go('/social' + (v === 'posts' ? '' : '?view=' + v));

    const compose = (base = {}) => {
      edit.value = { text: '', platforms: ['facebook', 'instagram'].filter((p) => meta.value.accounts[p]?.connected).length ? ['facebook', 'instagram'].filter((p) => meta.value.accounts[p]?.connected) : ['facebook'], image: null, link: '', scheduled_at: '', ...base };
      ai.variants = [];
    };
    const openPost = (p) => { edit.value = { ...p, scheduled_at: p.scheduled_at || '' }; ai.variants = []; };
    const toggle = (k) => { const l = edit.value.platforms; const i = l.indexOf(k); if (i >= 0) l.splice(i, 1); else l.push(k); };
    const limits = computed(() => (edit.value ? edit.value.platforms.map((k) => ({ k, name: meta.value.platforms[k].name, max: meta.value.platforms[k].max, over: edit.value.text.length > meta.value.platforms[k].max })) : []));
    const upload = async (file) => {
      if (!file) return;
      if (!/^image\/(png|jpeg|webp)$/.test(file.type)) return toast('Image PNG, JPEG ou WebP', 'error');
      const res = await fetch('/api/social/images', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/octet-stream' }, body: file });
      const d = await res.json();
      if (!res.ok) return toast(d.error || 'Envoi impossible', 'error');
      edit.value.image = d.url;
    };
    const persist = async (status) => {
      const e = edit.value;
      const body = { text: e.text, platforms: e.platforms, image: e.image, link: e.link, scheduled_at: status === 'draft' ? e.scheduled_at || null : e.scheduled_at || null, status };
      return e.id ? PUT('/social/posts/' + e.id, body) : POST('/social/posts', body);
    };
    const saveDraft = async () => { await act(() => persist('draft'), 'Brouillon enregistré'); edit.value = null; load(); };
    const schedule = async () => {
      if (!edit.value.scheduled_at) return toast('Choisissez la date et l\'heure de publication', 'error');
      await act(() => persist('scheduled'), '🗓️ Publication programmée'); edit.value = null; load();
    };
    const publishNow = async () => {
      const p = await act(() => persist('draft'));
      const r = await act(() => POST(`/social/posts/${p.id}/publish`));
      edit.value = null; load();
      const fails = Object.entries(r.results || {}).filter(([, x]) => !x.ok && !x.manual);
      if (fails.length) toast(fails.map(([k, x]) => `${meta.value.platforms[k].name} : ${x.error}`).join(' · '), 'error');
      else toast(r.status === 'manual' || r.status === 'partial' ? 'Texte prêt : publiez-le à la main sur les autres réseaux (bouton Copier)' : '🚀 Publié !');
    };
    const publish = async (p) => { const r = await act(() => POST(`/social/posts/${p.id}/publish`)); load(); if (r.status === 'error') toast('Échec de la publication : voir le détail', 'error'); };
    const manualDone = async (p) => { await act(() => POST(`/social/posts/${p.id}/manual-done`), 'Marquée comme publiée'); load(); };
    const remove = async (p) => { if (!confirm('Supprimer cette publication ?')) return; await act(() => DEL('/social/posts/' + p.id)); edit.value = null; load(); };
    const copy = (t) => { navigator.clipboard?.writeText(t); toast('Texte copié'); };

    const write = async () => {
      ai.busy = true;
      try {
        const r = await POST('/social/write', { topic: ai.topic, platforms: edit.value.platforms, tone: ai.tone });
        ai.variants = r.posts;
        if (r.posts[0]) edit.value.text = r.posts[0].text;
        if (!r.ai) toast('Texte de base (ajoutez une clé IA pour des textes sur mesure)');
      } catch (e) { toast(e.message, 'error'); } finally { ai.busy = false; }
    };
    const ideas = async () => {
      ai.ideasBusy = true;
      try { ai.ideas = (await POST('/social/ideas')).ideas; } catch (e) { toast(e.message, 'error'); } finally { ai.ideasBusy = false; }
    };
    const useIdea = (i) => { compose(); ai.topic = `${i.title} : ${i.brief}`; ai.ideas = []; };

    // Calendrier du mois
    const days = computed(() => {
      const start = new Date(month.value);
      const first = new Date(start); first.setDate(1 - ((start.getDay() + 6) % 7));
      return Array.from({ length: 42 }, (_, i) => {
        const d = new Date(first); d.setDate(first.getDate() + i);
        const key = iso(d);
        return { key, day: d.getDate(), other: d.getMonth() !== start.getMonth(), today: key === iso(new Date()),
          posts: posts.value.filter((p) => (p.scheduled_at || p.published_at || p.created_at || '').slice(0, 10) === key) };
      });
    });
    const shiftMonth = (n) => { const d = new Date(month.value); d.setMonth(d.getMonth() + n); month.value = d; };
    const planOn = (key) => compose({ scheduled_at: key + 'T10:00' });

    const saveAccounts = async (k, disconnect = false) => {
      const body = { [k]: disconnect ? { disconnect: true } : acc[k] };
      meta.value.accounts = await act(() => PUT('/social/accounts', body), disconnect ? 'Compte déconnecté' : 'Compte enregistré');
      acc[k].token = '';
    };
    const counts = computed(() => ({ scheduled: posts.value.filter((p) => p.status === 'scheduled').length, published: posts.value.filter((p) => p.status === 'published').length, todo: posts.value.filter((p) => ['manual', 'partial', 'error'].includes(p.status)).length }));
    return { view, setView, meta, posts, edit, ai, month, acc, compose, openPost, toggle, limits, upload, saveDraft, schedule, publishNow, publish, manualDone, remove, copy, write, ideas, useIdea, days, shiftMonth, planOn, saveAccounts, counts, STATUS, PICON, datetime, store };
  },
  template: `
  <div v-if="meta">
    <div class="page-head">
      <div><h1>Marketing social</h1><div class="sub">{{ counts.scheduled }} programmée(s) · {{ counts.published }} publiée(s) · {{ counts.todo }} à finir</div></div>
      <div class="btns"><button class="btn" :disabled="ai.ideasBusy" @click="ideas"><Icon name="lightbulb"/> {{ ai.ideasBusy ? 'Réflexion…' : 'Idées de publications' }}</button><button class="btn primary" @click="compose()"><Icon name="plus"/> Nouvelle publication</button></div>
    </div>
    <div class="tabs att-tabs">
      <button :class="{active: view === 'posts'}" @click="setView('posts')">Publications</button>
      <button :class="{active: view === 'calendar'}" @click="setView('calendar')">Calendrier</button>
      <button :class="{active: view === 'accounts'}" @click="setView('accounts')">Comptes</button>
    </div>

    <div v-if="ai.ideas.length" class="card ideas">
      <div class="card-head"><h2>💡 Idées pour ce mois</h2><button class="icon-btn" @click="ai.ideas = []"><Icon name="x"/></button></div>
      <div class="grid g3"><button v-for="i in ai.ideas" :key="i.title" class="idea" @click="useIdea(i)"><b>{{ i.title }}</b><span>{{ i.brief }}</span><small>Meilleur jour : {{ i.best_day }}</small></button></div>
    </div>

    <div v-if="view === 'posts'" class="post-feed">
      <div v-for="p in posts" :key="p.id" class="card post" @click="['draft', 'scheduled'].includes(p.status) && openPost(p)">
        <div class="post-head">
          <span class="pchips"><span v-for="k in p.platforms" :key="k" class="pchip" :class="k">{{ PICON[k] }}</span></span>
          <Badge :label="STATUS[p.status][0]" :color="STATUS[p.status][1]"/>
          <span class="muted small">{{ p.status === 'scheduled' ? 'le ' + datetime(p.scheduled_at) : p.published_at ? 'le ' + datetime(p.published_at) : datetime(p.created_at.replace(' ', 'T') + 'Z') }}</span>
        </div>
        <div class="post-body"><img v-if="p.image" :src="p.image" alt=""><p>{{ p.text }}</p></div>
        <div v-if="p.results" class="post-results small"><span v-for="(r, k) in p.results" :key="k" :class="r.ok ? 'pos' : r.manual ? 'muted' : 'neg'">{{ meta.platforms[k]?.name || k }} : {{ r.ok ? '✓' : r.error }}</span></div>
        <div class="btns" @click.stop>
          <button class="btn sm" @click="copy(p.text)"><Icon name="copy"/> Copier</button>
          <button v-if="['draft', 'scheduled', 'error'].includes(p.status)" class="btn sm primary" @click="publish(p)"><Icon name="send"/> Publier maintenant</button>
          <template v-if="['manual', 'partial'].includes(p.status)"><a v-for="k in p.platforms.filter(x => !meta.platforms[x].auto)" :key="k" class="btn sm" :href="meta.platforms[k].url" target="_blank" rel="noopener">Ouvrir {{ meta.platforms[k].name }}</a><button class="btn sm" @click="manualDone(p)"><Icon name="check"/> C'est publié</button></template>
          <button class="btn sm danger" @click="remove(p)">Supprimer</button>
        </div>
      </div>
      <Empty v-if="!posts.length" icon="📣" text="Aucune publication. Cliquez sur « Nouvelle publication » ou demandez des idées à l'IA."/>
    </div>

    <div v-if="view === 'calendar'" class="card">
      <div class="card-head"><div class="btns"><button class="btn sm" @click="shiftMonth(-1)">←</button><h2 style="margin:0;text-transform:capitalize">{{ month.toLocaleDateString('fr-LU', { month: 'long', year: 'numeric' }) }}</h2><button class="btn sm" @click="shiftMonth(1)">→</button></div><span class="muted small">Cliquez sur un jour pour programmer</span></div>
      <div class="cal"><div v-for="d in ['Lun','Mar','Mer','Jeu','Ven','Sam','Dim']" :key="d" class="cal-h">{{ d }}</div>
        <div v-for="d in days" :key="d.key" class="cal-d" :class="{ other: d.other, today: d.today }" @click="planOn(d.key)">
          <span class="n">{{ d.day }}</span>
          <div v-for="p in d.posts" :key="p.id" class="cal-post" :class="p.status" @click.stop="openPost(p)"><span class="pchip sm" :class="p.platforms[0]">{{ PICON[p.platforms[0]] }}</span>{{ p.text.slice(0, 40) }}</div>
        </div>
      </div>
    </div>

    <div v-if="view === 'accounts'" class="config">
      <section class="card cfg">
        <h2><span class="pchip facebook">f</span> Page Facebook <Badge v-if="meta.accounts.facebook.connected" label="Connectée" color="green"/></h2>
        <p class="muted small">Publication automatique sur votre page. Il faut l'identifiant de la page et un jeton d'accès de page (Meta Business Suite → Paramètres → Accès avancé / Graph API Explorer) avec les droits <code>pages_manage_posts</code>.</p>
        <div class="form-grid"><label>Nom de la page<input v-model="acc.facebook.name" :placeholder="meta.accounts.facebook.name"></label><label>ID de la page<input v-model="acc.facebook.page_id" inputmode="numeric"></label>
          <label class="full">Jeton d'accès {{ meta.accounts.facebook.connected ? '(enregistré — vide = inchangé)' : '' }}<input v-model="acc.facebook.token" type="password" autocomplete="off"></label></div>
        <div class="btns"><button class="btn primary" @click="saveAccounts('facebook')">Enregistrer</button><button v-if="meta.accounts.facebook.connected" class="btn danger" @click="saveAccounts('facebook', true)">Déconnecter</button></div>
      </section>
      <section class="card cfg">
        <h2><span class="pchip instagram">◎</span> Instagram professionnel <Badge v-if="meta.accounts.instagram.connected" label="Connecté" color="green"/></h2>
        <p class="muted small">Compte Instagram professionnel relié à la page Facebook. Chaque publication doit avoir une image, et le logiciel doit être accessible sur internet en https (Paramètres → Atelier & factures → adresse publique) pour qu'Instagram puisse la télécharger.</p>
        <div class="form-grid"><label>Nom du compte<input v-model="acc.instagram.name" :placeholder="meta.accounts.instagram.name"></label><label>ID du compte Instagram<input v-model="acc.instagram.ig_user_id" inputmode="numeric"></label>
          <label class="full">Jeton d'accès {{ meta.accounts.instagram.connected ? '(enregistré — vide = inchangé)' : '' }}<input v-model="acc.instagram.token" type="password" autocomplete="off"></label></div>
        <div class="btns"><button class="btn primary" @click="saveAccounts('instagram')">Enregistrer</button><button v-if="meta.accounts.instagram.connected" class="btn danger" @click="saveAccounts('instagram', true)">Déconnecter</button></div>
        <p v-if="!meta.public_url" class="error small">Adresse publique non renseignée : Instagram ne pourra pas récupérer les images.</p>
      </section>
      <section class="card cfg wide">
        <h2>Google Business, LinkedIn, TikTok</h2>
        <p class="muted">Ces réseaux n'autorisent pas la publication automatique pour un petit compte sans validation longue. Le logiciel prépare le texte (et l'IA l'adapte à chaque réseau) : un clic sur « Copier » puis « Ouvrir » pour le coller. Vous marquez ensuite la publication comme faite pour garder l'historique.</p>
      </section>
    </div>

    <Modal v-if="edit" :title="edit.id ? 'Modifier la publication' : 'Nouvelle publication'" wide @close="edit = null">
      <div class="composer">
        <div>
          <div class="pnets"><button v-for="(p, k) in meta.platforms" :key="k" class="pnet" :class="[k, { on: edit.platforms.includes(k) }]" @click="toggle(k)"><span class="pchip" :class="k">{{ PICON[k] }}</span>{{ p.name }}<small v-if="p.auto && !meta.accounts[k]?.connected">non connecté</small><small v-else-if="!p.auto">à la main</small></button></div>
          <div class="ai-box">
            <input v-model="ai.topic" placeholder="✨ Sujet pour l'IA (ex. : -20 % sur la climatisation jusqu'au 30 juin)">
            <select v-model="ai.tone"><option>chaleureux</option><option>professionnel</option><option>humoristique</option><option>urgent (offre limitée)</option></select>
            <button class="btn sm primary" :disabled="ai.busy || !ai.topic.trim()" @click="write"><Icon name="wand-sparkles"/> {{ ai.busy ? '…' : 'Rédiger' }}</button>
          </div>
          <div v-if="ai.variants.length > 1" class="variants"><span class="muted small">Versions par réseau :</span><button v-for="v in ai.variants" :key="v.platform" class="btn sm" @click="edit.text = v.text">{{ meta.platforms[v.platform].name }}</button></div>
          <label>Texte<textarea v-model="edit.text" rows="8" placeholder="Écrivez votre publication…"></textarea></label>
          <div class="limits small"><span v-for="l in limits" :key="l.k" :class="l.over ? 'neg' : 'muted'">{{ l.name }} {{ edit.text.length }}/{{ l.max }}</span></div>
          <div class="form-grid">
            <label>Lien (optionnel)<input v-model="edit.link" placeholder="https://…"></label>
            <label>Programmer le<input type="datetime-local" v-model="edit.scheduled_at"></label>
          </div>
          <div class="img-field"><div class="img-prev" :style="edit.image ? { backgroundImage: 'url(' + edit.image + ')' } : {}"></div>
            <label class="btn sm"><Icon name="image"/> {{ edit.image ? 'Changer l\\'image' : 'Ajouter une image' }}<input type="file" accept="image/png,image/jpeg,image/webp" hidden @change="upload($event.target.files[0]); $event.target.value = ''"></label>
            <button v-if="edit.image" class="btn sm" @click="edit.image = null">Retirer</button></div>
        </div>
        <div class="phone-prev">
          <div class="pp-head"><span class="avatar" :style="{ background: store.settings?.layout?.primary || '#2563eb' }">{{ (store.company || 'G')[0] }}</span><div><b>{{ store.company }}</b><small>{{ edit.scheduled_at ? datetime(edit.scheduled_at) : 'Maintenant' }} · 🌍</small></div></div>
          <p>{{ edit.text || 'Votre texte apparaîtra ici…' }}</p>
          <img v-if="edit.image" :src="edit.image" alt="">
          <div class="pp-foot">👍 J'aime · 💬 Commenter · ↗ Partager</div>
        </div>
      </div>
      <template #foot>
        <button v-if="edit.id" class="btn danger" @click="remove(edit)">Supprimer</button><span style="flex:1"></span>
        <button class="btn" @click="saveDraft">Brouillon</button>
        <button class="btn" :disabled="!edit.scheduled_at" @click="schedule"><Icon name="calendar-clock"/> Programmer</button>
        <button class="btn primary" @click="publishNow"><Icon name="send"/> Publier maintenant</button>
      </template>
    </Modal>
  </div>`,
};
