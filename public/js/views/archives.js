// Application « Documents » : dossiers, dépôt de fichiers, fiche d'un document (aperçu, lecture de l'IA, contrat),
// questions à l'IA, échéances des contrats, réglage de la boîte e-mail.
import { ref, reactive, computed, watch, onMounted, onUnmounted, nextTick } from 'vue';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import { GET, POST, PUT, DEL, act, toast, store, money, date as fdate, datetime, today } from '../api.js';
import { route, go, leaveGuards } from '../router.js';
import { can } from '../apps.js';

// Réponse de l'IA : mise en forme simple et liens vers les documents seulement. Ni image, ni style, ni lien extérieur :
// un document piégé ne peut pas faire partir des informations vers un autre site par ce biais.
const md = (s) => DOMPurify.sanitize(marked.parse(s || ''), {
  ALLOWED_TAGS: ['p', 'br', 'strong', 'em', 'b', 'i', 'ul', 'ol', 'li', 'a', 'code', 'pre', 'blockquote', 'h1', 'h2', 'h3', 'h4', 'hr', 'table', 'thead', 'tbody', 'tr', 'th', 'td'],
  ALLOWED_ATTR: ['href'], ALLOWED_URI_REGEXP: /^#\/archives\?doc=\d+$/,
});
async function uploadFile(url, file) {
  const r = await fetch('/api' + url, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': file.type || 'application/octet-stream', 'X-Filename': encodeURIComponent(file.name) }, body: file });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error || 'Envoi impossible');
  return d;
}
const STATUS = { queued: ['Lecture en attente', 'b-blue'], analyzing: ['L’IA lit…', 'b-blue'], manual: ['À classer à la main', 'b-orange'], error: ['Lecture en échec', 'b-red'] };
const size = (n) => (n > 1048576 ? (n / 1048576).toFixed(1).replace('.', ',') + ' Mo' : Math.max(1, Math.round((n || 0) / 1024)) + ' ko');
const daysTo = (d) => (d ? Math.round((new Date(d + 'T12:00:00') - new Date(today() + 'T12:00:00')) / 864e5) : null);
/** Texte et couleur d'une échéance : « dans 12 jours », « aujourd'hui », « dépassée ». */
const due = (d) => {
  const n = daysTo(d);
  if (n === null) return null;
  return n < 0 ? ['dépassée', 'b-gray'] : n === 0 ? ['aujourd’hui', 'b-red'] : n <= 30 ? [`dans ${n} jour${n > 1 ? 's' : ''}`, 'b-red'] : n <= 90 ? [`dans ${n} jours`, 'b-orange'] : [`dans ${Math.round(n / 30)} mois`, 'b-green'];
};

// ---------- Fiche d'un document ----------
const DocModal = {
  props: { id: Number, folders: Array, kinds: Object, ai: Boolean },
  emits: ['close', 'changed'],
  setup(props, { emit }) {
    const d = ref(null);
    const f = ref(null); // champs en cours de modification
    const busy = ref(false);
    const canEdit = can('archives', 'user');
    const canDelete = can('archives', 'manager');
    const canBill = can('achats', 'user') && canEdit;
    const FIELDS = ['title', 'folder_id', 'kind', 'doc_date', 'correspondent', 'reference', 'amount', 'notes', 'contract_start', 'contract_end', 'notice_days', 'cancel_by', 'renewal', 'reminder_days'];
    let timer = null, closing = false, last = null;
    const base = ref(null); // valeurs chargées : ce qui en diffère est une modification de l'utilisateur
    const pick = (x) => Object.fromEntries(FIELDS.map((k) => [k, x[k] ?? (k === 'renewal' ? '' : null)]));
    const blank = (v) => (v === '' || v === undefined ? null : v);
    const same = (a, b) => blank(a) === blank(b);
    const iso = (x) => `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`;
    // date limite de résiliation = fin du contrat − préavis
    const derive = (end, n) => { if (!end || blank(n) === null || !Number.isInteger(Number(n)) || Number(n) < 0) return null; const x = new Date(end + 'T12:00:00'); x.setDate(x.getDate() - Number(n)); return iso(x); };
    const take = (x) => { d.value = x; base.value = pick(x); f.value = pick(x); last = derive(x.contract_end, x.notice_days); };
    const changed = computed(() => (f.value && base.value ? FIELDS.filter((k) => !same(f.value[k], base.value[k])) : []));
    const dirty = computed(() => changed.value.length > 0);
    const load = async () => {
      const x = await GET('/archives/docs/' + props.id);
      if (!d.value || !dirty.value) take(x);
      else {
        // L'IA a fini de lire pendant que l'utilisateur tapait : les champs qu'il n'a pas touchés prennent les nouvelles
        // valeurs, les siens restent — et seuls les siens seront enregistrés
        const fresh = pick(x);
        for (const k of FIELDS) { if (same(f.value[k], base.value[k])) f.value[k] = fresh[k]; base.value[k] = fresh[k]; }
        d.value = x;
      }
      clearTimeout(timer);
      if (['queued', 'analyzing'].includes(x.status)) timer = setTimeout(() => load().catch(() => {}), 2000);
    };
    // document introuvable (supprimé, lien ancien) : on ferme sans ajouter de page à l'historique du navigateur
    onMounted(() => load().catch((e) => { toast(e.message, 'error'); emit('close', true); }));
    // Bouton Retour du navigateur ou lien vers une autre page : même question qu'à la fermeture
    const leaveOk = () => closing || !dirty.value || confirm('Les modifications ne sont pas enregistrées. Fermer quand même ?');
    onMounted(() => leaveGuards.add(leaveOk));
    onUnmounted(() => { clearTimeout(timer); leaveGuards.delete(leaveOk); });
    const reading = computed(() => ['queued', 'analyzing'].includes(d.value?.status));
    const isImage = computed(() => String(d.value?.mime || '').startsWith('image/'));
    const isContract = computed(() => ['contract', 'insurance'].includes(f.value?.kind) || !!(f.value?.contract_end || f.value?.cancel_by || f.value?.contract_start || d.value?.contract_end));
    const showContract = ref(false);
    // Date limite de résiliation proposée quand la fin ou le préavis changent — seulement si le champ est vide ou contient
    // encore la proposition précédente : une date tapée à la main (celle du contrat) n'est jamais remplacée
    const suggest = () => {
      const next = derive(f.value.contract_end, f.value.notice_days);
      if (!next) return;
      if (!f.value.cancel_by || f.value.cancel_by === last) f.value.cancel_by = next;
      last = next;
    };
    const save = async () => {
      if (busy.value) return;
      busy.value = true;
      try {
        const body = Object.fromEntries(changed.value.map((k) => [k, blank(f.value[k])]));
        await act(() => PUT('/archives/docs/' + props.id, body), 'Document enregistré');
        take(await GET('/archives/docs/' + props.id));
        emit('changed');
      } catch { /* message déjà affiché */ } finally { busy.value = false; }
    };
    const reread = async () => {
      if (dirty.value && !confirm('Vos modifications non enregistrées seront perdues. Relire le document avec l’IA ?')) return;
      try { await act(() => POST(`/archives/docs/${props.id}/analyze`)); d.value = null; await load(); emit('changed'); } catch { /* message déjà affiché */ }
    };
    const bill = async () => {
      if (busy.value) return;
      busy.value = true;
      try {
        const r = await act(() => POST(`/archives/docs/${props.id}/bill`), 'Facture fournisseur créée dans les Achats (brouillon à vérifier)');
        if (r.warnings?.length) toast(r.warnings[0], 'error');
        await load(); emit('changed');
      } catch { /* message déjà affiché */ } finally { busy.value = false; }
    };
    const remove = async () => {
      if (!confirm(`Supprimer définitivement « ${d.value.title} » et son fichier ?`)) return;
      try { await act(() => DEL('/archives/docs/' + props.id), 'Document supprimé'); closing = true; emit('changed'); emit('close', true); } catch { /* message déjà affiché */ }
    };
    const close = () => { if (dirty.value && !confirm('Les modifications ne sont pas enregistrées. Fermer quand même ?')) return; closing = true; emit('close'); };
    return { d, f, busy, dirty, reading, isImage, isContract, showContract, canEdit, canDelete, canBill, suggest, save, reread, bill, remove, close, STATUS, size, due, fdate, money };
  },
  template: `
  <Modal :title="d ? d.title : 'Document'" wide @close="close">
    <div v-if="!d" class="muted">Chargement…</div>
    <div v-else class="arch-doc">
      <div class="arch-view">
        <iframe v-if="d.mime === 'application/pdf'" :src="'/api/attachment/' + d.attachment_id" title="Aperçu du document"></iframe>
        <img v-else-if="isImage" :src="'/api/attachment/' + d.attachment_id" :alt="d.title">
        <div v-else class="arch-nopreview"><Icon name="file-text"/><div>Pas d'aperçu pour ce format</div></div>
        <div class="arch-file"><span class="muted small">{{ d.filename }} · {{ size(d.size) }}<template v-if="d.source === 'email'"> · reçu par e-mail{{ d.email_from ? ' de ' + d.email_from : '' }}</template></span>
          <span class="btns"><a class="btn sm" :href="'/api/attachment/' + d.attachment_id" target="_blank" rel="noopener"><Icon name="external-link" class="ti"/> Ouvrir</a>
          <a class="btn sm" :href="'/api/attachment/' + d.attachment_id + '?download=1'"><Icon name="download" class="ti"/> Télécharger</a></span></div>
      </div>
      <div class="arch-card">
        <p v-if="reading" class="vr-note"><span class="typing"><span></span><span></span><span></span></span> <span>L'IA lit ce document : sa fiche se remplit dans un instant.</span></p>
        <p v-else-if="d.status === 'error'" class="vr-note bad" role="alert"><Icon name="triangle-alert" class="ti"/> <span>{{ d.ai_error || 'La lecture par l’IA a échoué.' }}</span></p>
        <p v-else-if="d.ai_error" class="vr-note"><Icon name="info" class="ti"/> <span>{{ d.ai_error }}</span></p>
        <p v-else-if="d.status === 'manual' && !ai" class="vr-note"><Icon name="info" class="ti"/> <span>Sans clé IA, le document n'est pas lu : complétez sa fiche à la main. (Paramètres → Agents IA pour activer la lecture.)</span></p>
        <div v-if="d.summary" class="arch-ai">
          <b><Icon name="sparkles" class="ti"/> Ce qu'en retient l'IA</b>
          <p>{{ d.summary }}</p>
          <ul v-if="d.facts.length"><li v-for="x in d.facts">{{ x }}</li></ul>
        </div>
        <div class="form-grid">
          <label class="full">Titre<input v-model="f.title" :disabled="!canEdit" maxlength="200"></label>
          <label>Type<select v-model="f.kind" :disabled="!canEdit"><option v-for="(l, k) in kinds" :value="k">{{ l }}</option></select></label>
          <label>Dossier<select v-model="f.folder_id" :disabled="!canEdit"><option v-for="x in folders" :value="x.id">{{ x.path }}</option></select></label>
          <label>Date du document<input v-model="f.doc_date" type="date" :disabled="!canEdit"></label>
          <label>Montant<input v-model="f.amount" inputmode="decimal" :disabled="!canEdit"></label>
          <label>Correspondant<input v-model="f.correspondent" :disabled="!canEdit" maxlength="200" placeholder="Société, organisme…"></label>
          <label>Référence<input v-model="f.reference" :disabled="!canEdit" maxlength="200" placeholder="N° de contrat, de police…"></label>
        </div>
        <div v-if="isContract || showContract" class="arch-contract">
          <b><Icon name="calendar-clock" class="ti"/> Contrat : durée et résiliation</b>
          <div class="form-grid">
            <label>Début<input v-model="f.contract_start" type="date" :disabled="!canEdit"></label>
            <label>Fin du contrat<input v-model="f.contract_end" type="date" :disabled="!canEdit" @change="suggest"></label>
            <label>Préavis (jours)<input v-model.number="f.notice_days" type="number" min="0" max="3660" :disabled="!canEdit" placeholder="90 = 3 mois" @change="suggest"></label>
            <label>À résilier avant le<input v-model="f.cancel_by" type="date" :disabled="!canEdit"></label>
            <label>Reconduction<select v-model="f.renewal" :disabled="!canEdit"><option value="">Non précisée</option><option value="tacit">Tacite</option><option value="none">Aucune</option></select></label>
            <label>Me prévenir (jours avant)<input v-model.number="f.reminder_days" type="number" min="0" max="365" :disabled="!canEdit" placeholder="30"></label>
          </div>
          <p v-if="d.reminder" class="muted small" style="margin:8px 0 0"><Icon name="alarm-clock" class="ti"/> Rappel {{ d.reminder.status === 'planned' ? 'prévu' : 'déjà traité' }} le {{ fdate(d.reminder.due_date) }} dans vos activités (To-do).</p>
          <p v-else-if="d.contract_end || d.cancel_by" class="muted small" style="margin:8px 0 0">Échéance passée : aucun rappel n'est prévu.</p>
        </div>
        <button v-else-if="canEdit" class="btn sm" @click="showContract = true"><Icon name="calendar-clock" class="ti"/> Ajouter une échéance de contrat</button>
        <label>Notes<textarea v-model="f.notes" :disabled="!canEdit" rows="2" maxlength="4000" placeholder="Vos remarques sur ce document"></textarea></label>
        <div class="arch-bill">
          <template v-if="d.purchase"><Icon name="shopping-cart" class="ti"/> Encodé dans les Achats : <a :href="'#/purchase/' + d.purchase.id"><b>{{ d.purchase.number }}</b></a> ({{ money(d.purchase.total) }})</template>
          <button v-else-if="canBill && !reading" class="btn sm" :disabled="busy" @click="bill"><Icon name="shopping-cart" class="ti"/> Encoder comme facture fournisseur</button>
        </div>
      </div>
    </div>
    <template #foot v-if="d">
      <button v-if="canDelete" class="btn danger" @click="remove" title="Supprimer ce document" aria-label="Supprimer ce document"><Icon name="trash-2" class="ti"/></button>
      <button v-if="canEdit && ai && !reading" class="btn" @click="reread"><Icon name="refresh-cw" class="ti"/> Relire avec l'IA</button>
      <span style="flex:1"></span>
      <button class="btn" @click="close">Fermer</button>
      <button v-if="canEdit" class="btn primary" :disabled="busy || !dirty" @click="save"><Icon name="save" class="ti"/> Enregistrer</button>
    </template>
  </Modal>`,
};

// ---------- Questions à l'IA ----------
const AskModal = {
  props: { ai: Boolean },
  emits: ['close', 'open'],
  setup(props, { emit }) {
    const q = ref('');
    const busy = ref(false);
    const talk = ref([]); // { q, html, documents, error }
    const box = ref(null);
    const IDEAS = ['Quels contrats se terminent dans les 6 prochains mois ?', 'Quel est le préavis pour résilier mon assurance ?', 'Retrouve ma dernière facture de pneus'];
    const ask = async (text) => {
      const question = String(text ?? q.value).trim();
      if (!question || busy.value) return;
      busy.value = true;
      q.value = '';
      const item = reactive({ q: question, html: '', documents: [], error: '' });
      talk.value.push(item);
      nextTick(() => { if (box.value) box.value.scrollTop = box.value.scrollHeight; });
      try {
        const r = await POST('/archives/ask', { question });
        const titles = Object.fromEntries(r.documents.map((x) => [x.id, x.title]));
        // [doc:12] → lien vers le document (un numéro inconnu est simplement retiré)
        item.html = md(r.answer.replace(/\[doc:(\d+)\]/g, (m, id) => (titles[id] ? `[${titles[id].replace(/[\[\]]/g, '')}](#/archives?doc=${id})` : '')));
        item.documents = r.documents;
      } catch (e) { item.error = e.message; } finally { busy.value = false; nextTick(() => { if (box.value) box.value.scrollTop = box.value.scrollHeight; }); }
    };
    // un lien vers un document, dans la réponse, ferme la fenêtre pour montrer ce document
    const follow = (e) => { if ((e.target.closest('a')?.getAttribute('href') || '').startsWith('#/archives')) emit('close'); };
    return { q, busy, talk, box, IDEAS, ask, follow };
  },
  template: `
  <Modal title="Demander à l'IA" wide @close="$emit('close')">
    <p v-if="!ai" class="vr-note"><Icon name="info" class="ti"/> <span>Les questions demandent une clé Claude (Paramètres → Agents IA). La recherche par mots, elle, fonctionne sans.</span></p>
    <div class="arch-talk" ref="box">
      <div v-if="!talk.length" class="muted">Posez une question sur vos documents : l'IA cherche, lit, et vous montre les papiers sur lesquels elle s'appuie.
        <div class="arch-ideas"><button v-for="i in IDEAS" class="btn sm" :disabled="!ai || busy" @click="ask(i)">{{ i }}</button></div>
      </div>
      <div v-for="t in talk" class="arch-qa">
        <div class="arch-q">{{ t.q }}</div>
        <p v-if="t.error" class="vr-note bad" role="alert"><Icon name="triangle-alert" class="ti"/> <span>{{ t.error }}</span></p>
        <div v-else-if="t.html" class="arch-a md" v-html="t.html" @click="follow"></div>
        <div v-else class="arch-a muted"><span class="typing"><span></span><span></span><span></span></span> L'IA cherche dans vos documents…</div>
        <div v-if="t.documents.length" class="arch-cited"><a v-for="x in t.documents" class="btn sm" :href="'#/archives?doc=' + x.id" @click="$emit('close')"><Icon name="file-text" class="ti"/> {{ x.title }}</a></div>
      </div>
    </div>
    <template #foot>
      <input v-model="q" class="arch-ask-in" :disabled="!ai || busy" maxlength="1000" placeholder="Votre question…" @keydown.enter="ask()" aria-label="Votre question">
      <button class="btn primary" :disabled="!ai || busy || !q.trim()" @click="ask()"><Icon name="send" class="ti"/> Demander</button>
    </template>
  </Modal>`,
};

// ---------- Réglages (administrateur) : rappels, factures, boîte e-mail ----------
const SettingsModal = {
  props: { config: Object },
  emits: ['close', 'changed'],
  setup(props, { emit }) {
    const cfg = reactive({ auto_bills: props.config.auto_bills, reminder_days: props.config.reminder_days });
    const box = ref(null);
    const busy = ref(false);
    const load = async () => { box.value = { ...(await GET('/archives/inbox')), pass: '' }; };
    onMounted(() => load().catch((e) => toast(e.message, 'error')));
    const preset = (k) => Object.assign(box.value, { gmail: { host: 'imap.gmail.com', port: 993, secure: true }, outlook: { host: 'outlook.office365.com', port: 993, secure: true }, ovh: { host: 'ssl0.ovh.net', port: 993, secure: true } }[k]);
    const save = async (silent) => {
      await act(() => PUT('/archives/config', cfg));
      await act(() => PUT('/archives/inbox', box.value), silent ? null : 'Réglages enregistrés');
      await load();
      emit('changed');
    };
    const run = async (fn) => { if (busy.value) return; busy.value = true; try { await fn(); } catch { /* message déjà affiché */ } finally { busy.value = false; } };
    const test = () => run(async () => { await save(true); const r = await act(() => POST('/archives/inbox/test')); toast(`Connecté : ${r.messages} e-mail(s), dont ${r.unseen} non lu(s)`); });
    const check = () => run(async () => { await save(true); const r = await act(() => POST('/archives/inbox/check')); toast(`${r.emails} e-mail(s) lu(s), ${r.documents} document(s) reçu(s)`); await load(); emit('changed'); });
    return { cfg, box, busy, preset, save: () => run(() => save(false)), test, check, datetime };
  },
  template: `
  <Modal title="Réglages des documents" wide @close="$emit('close')">
    <div class="form-grid">
      <label>Rappel de fin de contrat (jours avant la date limite)<input v-model.number="cfg.reminder_days" type="number" min="0" max="365"></label>
      <label class="check" style="align-self:end"><input type="checkbox" v-model="cfg.auto_bills"> Encoder les factures fournisseurs dans les Achats dès leur lecture</label>
    </div>
    <h3 style="margin:18px 0 4px">Réception par e-mail</h3>
    <p class="muted small" style="margin:0 0 10px">Créez une adresse réservée aux documents (par exemple documents@votre-garage.lu) et indiquez ici sa boîte. Tout ce que vous y transférez (PDF, photos) arrive dans Documents, est lu par l'IA et rangé. N'utilisez pas votre boîte personnelle : chaque pièce jointe non lue serait importée.</p>
    <div v-if="box" class="form-grid">
      <label class="check full"><input type="checkbox" v-model="box.enabled"> Relever cette boîte automatiquement</label>
      <div class="full btns"><span class="muted small">Réglages courants :</span><button class="btn sm" @click="preset('gmail')">Gmail</button><button class="btn sm" @click="preset('outlook')">Outlook / Microsoft 365</button><button class="btn sm" @click="preset('ovh')">OVH</button></div>
      <label>Serveur IMAP<input v-model="box.host" placeholder="imap.exemple.lu" autocomplete="off"></label>
      <label>Port<input v-model.number="box.port" type="number"></label>
      <label>Adresse (identifiant)<input v-model="box.user" placeholder="documents@votre-garage.lu" autocomplete="off"></label>
      <label>Mot de passe<input v-model="box.pass" type="password" autocomplete="new-password" :placeholder="box.has_pass ? '•••••••• (inchangé)' : ''"></label>
      <label>Dossier à relever<input v-model="box.folder" placeholder="INBOX"></label>
      <label>Ranger les e-mails traités dans<input v-model="box.processed_folder" placeholder="(facultatif) Traités"></label>
      <label>Relever toutes les (minutes)<input v-model.number="box.interval" type="number" min="1" max="1440"></label>
      <label class="full">Expéditeurs acceptés (vide = tout le monde)<input v-model="box.allowed_senders" placeholder="vous@votre-garage.lu, @votre-fiduciaire.lu">
        <span class="muted small">Recommandé : sans cette liste, tout message reçu à cette adresse est importé. La liste compare l'adresse affichée par le message (un message que votre hébergeur signale comme falsifié est refusé) : c'est un filtre, pas une preuve de qui écrit.</span></label>
      <p v-if="box.status" class="full muted small" style="margin:0">Dernier relevé : {{ datetime(box.status.at) }} — {{ box.status.error ? 'erreur : ' + box.status.error : box.status.emails + ' e-mail(s), ' + box.status.documents + ' document(s)' }}</p>
    </div>
    <template #foot>
      <button class="btn" :disabled="busy" @click="test">Tester la connexion</button>
      <button class="btn" :disabled="busy" @click="check"><Icon name="inbox" class="ti"/> Relever maintenant</button>
      <span style="flex:1"></span>
      <button class="btn primary" :disabled="busy" @click="save"><Icon name="save" class="ti"/> Enregistrer</button>
    </template>
  </Modal>`,
};

// ---------- Page ----------
export const Archives = {
  components: { DocModal, AskModal, SettingsModal },
  setup() {
    const meta = ref(null);
    const docs = ref([]);
    const deadlines = ref([]);
    const folder = ref(Number(route.query.folder) || null);
    const view = ref(route.query.view === 'deadlines' ? 'deadlines' : 'docs');
    const q = ref('');
    const kind = ref('');
    const open = ref(Number(route.query.doc) || null);
    const asking = ref(false);
    const settings = ref(false);
    const drag = ref(false);
    const sending = reactive({ on: false, text: '' });
    const canEdit = can('archives', 'user');
    const canManage = can('archives', 'manager');
    const admin = computed(() => store.user?.role === 'admin');
    let poll = null, typing = null;
    const loadDocs = async () => {
      const p = new URLSearchParams();
      if (folder.value) p.set('folder', folder.value);
      if (q.value.trim()) p.set('q', q.value.trim());
      if (kind.value) p.set('kind', kind.value);
      docs.value = await GET('/archives/docs?' + p);
    };
    const load = async () => {
      meta.value = await GET('/archives');
      store.ai = meta.value.ai;
      if (folder.value && !meta.value.folders.some((f) => f.id === folder.value)) folder.value = null;
      await Promise.all([loadDocs(), GET('/archives/deadlines').then((r) => { deadlines.value = r; })]);
      // tant que l'IA lit des documents, la page se met à jour toute seule
      clearTimeout(poll);
      if (meta.value.reading > 0) poll = setTimeout(() => load().catch(() => {}), 2500);
    };
    onMounted(() => load().catch((e) => toast(e.message, 'error')));
    onUnmounted(() => { clearTimeout(poll); clearTimeout(typing); clearTimeout(dragOff); });
    watch(() => route.query.doc, (v) => { open.value = Number(v) || null; });
    watch(() => route.query.view, (v) => { view.value = v === 'deadlines' ? 'deadlines' : 'docs'; });
    watch([folder, kind], () => loadDocs().catch(() => {}));
    watch(q, () => { clearTimeout(typing); typing = setTimeout(() => loadDocs().catch(() => {}), 250); });
    const pick = (id) => { folder.value = id; if (view.value !== 'docs') go('/archives'); };
    const current = computed(() => meta.value?.folders.find((f) => f.id === folder.value) || null);
    // dossier où arrive un dépôt : celui qui est ouvert, sauf « À classer » (là, l'IA range le document elle-même)
    const target = computed(() => (current.value && current.value.system !== 'inbox' ? current.value : null));
    const pathOf = (id) => meta.value?.folders.find((f) => f.id === id)?.path || '';
    const total = computed(() => (meta.value?.folders || []).filter((f) => f.depth === 0).reduce((s, f) => s + f.count, 0));
    const upcoming = computed(() => deadlines.value.filter((d) => daysTo(d.deadline) !== null && daysTo(d.deadline) >= 0));

    const send = async (files) => {
      files = [...(files || [])];
      if (!files.length || sending.on) return;
      sending.on = true;
      let ok = 0, lastId = null;
      try {
        for (const [i, f] of files.entries()) {
          sending.text = `Envoi de ${f.name} (${i + 1}/${files.length})…`;
          try { lastId = (await uploadFile('/archives/upload' + (target.value ? '?folder=' + target.value.id : ''), f)).id; ok += 1; } catch (e) { toast(`${f.name} : ${e.message}`, 'error'); }
        }
      } finally { sending.on = false; }
      if (ok) toast(ok === 1 ? 'Document reçu' + (meta.value.ai ? ' : l’IA le lit et le range' : '') : `${ok} documents reçus` + (meta.value.ai ? ' : l’IA les lit et les range' : ''));
      await load();
      if (ok === 1 && files.length === 1 && lastId) go('/archives?doc=' + lastId);
    };
    // Voile « déposez ici » : seulement pour des fichiers ; il s'efface tout seul dès que le glissement s'arrête
    // (abandon, sortie de la fenêtre), l'événement « dragover » se répétant tant que le fichier survole la page
    let dragOff = null;
    const over = (e) => {
      if (!canEdit || !e.dataTransfer?.types?.includes('Files')) return;
      drag.value = true;
      clearTimeout(dragOff);
      dragOff = setTimeout(() => { drag.value = false; }, 700);
    };
    const drop = (e) => { clearTimeout(dragOff); drag.value = false; if (canEdit && e.dataTransfer?.files?.length) send(e.dataTransfer.files); };
    const readPending = async () => { try { const r = await act(() => POST('/archives/analyze-pending')); toast(`${r.queued} document(s) envoyé(s) en lecture`); await load(); } catch { /* message déjà affiché */ } };
    const newFolder = async () => {
      const name = prompt(current.value ? `Nom du nouveau dossier, dans « ${current.value.path} » :` : 'Nom du nouveau dossier :');
      if (!name?.trim()) return;
      try { const r = await act(() => POST('/archives/folders', { name, parent_id: current.value?.id || null }), 'Dossier créé'); await load(); folder.value = r.id; } catch { /* message déjà affiché */ }
    };
    const rename = async () => {
      const name = prompt('Nouveau nom du dossier :', current.value.name);
      if (!name?.trim() || name.trim() === current.value.name) return;
      try { await act(() => PUT('/archives/folders/' + current.value.id, { name }), 'Dossier renommé'); await load(); } catch { /* message déjà affiché */ }
    };
    const removeFolder = async () => {
      if (!confirm(`Supprimer le dossier « ${current.value.path} » ?`)) return;
      try { await act(() => DEL('/archives/folders/' + current.value.id), 'Dossier supprimé'); folder.value = null; await load(); } catch { /* message déjà affiché */ }
    };
    // `gone` : le document n'existe plus (supprimé, lien ancien) — on ne change pas d'adresse, pour que le bouton Retour
    // du navigateur ne ramène pas sans fin sur un document introuvable
    const closeDoc = (gone) => {
      open.value = null;
      if (gone === true) return;
      const p = new URLSearchParams(route.query); p.delete('doc');
      const qs = p.toString();
      go('/archives' + (qs ? '?' + qs : ''));
    };

    // Calendrier des échéances (mois affiché)
    const month = ref(new Date(new Date().getFullYear(), new Date().getMonth(), 1));
    const shift = (n) => { month.value = new Date(month.value.getFullYear(), month.value.getMonth() + n, 1); };
    const iso = (x) => `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`;
    const days = computed(() => {
      const first = new Date(month.value);
      const start = new Date(first); start.setDate(1 - ((first.getDay() + 6) % 7));
      const events = {};
      for (const d of deadlines.value) {
        if (d.cancel_by) (events[d.cancel_by] ||= []).push({ id: d.id, title: d.title, cls: 'cancel', label: 'À résilier' });
        if (d.contract_end) (events[d.contract_end] ||= []).push({ id: d.id, title: d.title, cls: 'end', label: 'Fin' });
      }
      return Array.from({ length: 42 }, (_, i) => { const x = new Date(start); x.setDate(start.getDate() + i); const key = iso(x); return { key, day: x.getDate(), other: x.getMonth() !== first.getMonth(), today: key === today(), events: events[key] || [] }; });
    });
    return { meta, docs, deadlines, upcoming, folder, view, q, kind, open, asking, settings, drag, sending, canEdit, canManage, admin, current, pathOf, total, month, days,
      load, pick, send, over, drop, readPending, target, newFolder, rename, removeFolder, closeDoc, shift, go, STATUS, due, fdate, money, datetime };
  },
  template: `
  <div v-if="meta" class="arch-page" @dragover.prevent="over" @drop.prevent="drop">
    <div class="page-head">
      <div><h1>Documents</h1><div class="sub">L'IA lit vos papiers, les range et vous prévient avant la fin d'un contrat.</div></div>
      <div class="btns">
        <button class="btn" @click="asking = true"><Icon name="sparkles" class="ti"/> Demander à l'IA</button>
        <button v-if="canEdit" class="btn primary" :disabled="sending.on" @click="$refs.picker.click()"><Icon name="upload" class="ti"/> Déposer des documents</button>
        <input v-if="canEdit" ref="picker" class="arch-picker" type="file" multiple hidden @change="send($event.target.files); $event.target.value = ''">
        <button v-if="admin" class="icon-btn" title="Réglages : rappels, factures, boîte e-mail" aria-label="Réglages des documents" @click="settings = true"><Icon name="settings" class="ti"/></button>
      </div>
    </div>

    <div class="arch">
      <aside class="arch-side card">
        <button class="arch-f" :class="{ on: view === 'docs' && !folder }" @click="pick(null)"><Icon name="file-text"/><span>Tous les documents</span><i>{{ total }}</i></button>
        <button v-for="f in meta.folders" :key="f.id" class="arch-f" :class="{ on: view === 'docs' && folder === f.id }" :style="{ paddingLeft: 12 + f.depth * 16 + 'px' }" @click="pick(f.id)">
          <Icon :name="f.system === 'inbox' ? 'inbox' : 'folder'"/><span>{{ f.name }}</span><i v-if="f.count">{{ f.count }}</i></button>
        <button v-if="canEdit" class="arch-f add" @click="newFolder"><Icon name="plus"/><span>Nouveau dossier</span></button>
        <hr>
        <button class="arch-f" :class="{ on: view === 'deadlines' }" @click="go('/archives?view=deadlines')"><Icon name="calendar-clock"/><span>Échéances des contrats</span><i v-if="upcoming.length">{{ upcoming.length }}</i></button>
      </aside>

      <section class="arch-main">
        <select class="arch-pick" :value="view === 'deadlines' ? 'deadlines' : folder || ''" @change="$event.target.value === 'deadlines' ? go('/archives?view=deadlines') : pick(Number($event.target.value) || null)" aria-label="Dossier">
          <option value="">Tous les documents ({{ total }})</option>
          <option v-for="f in meta.folders" :value="f.id">{{ '\\u00a0\\u00a0'.repeat(f.depth) + f.name }}{{ f.count ? ' (' + f.count + ')' : '' }}</option>
          <option value="deadlines">Échéances des contrats{{ upcoming.length ? ' (' + upcoming.length + ')' : '' }}</option>
        </select>

        <template v-if="view === 'docs'">
          <div v-if="sending.on" class="vr-note"><span class="typing"><span></span><span></span><span></span></span> <span>{{ sending.text }}</span></div>
          <div v-else-if="meta.reading" class="vr-note"><span class="typing"><span></span><span></span><span></span></span> <span>L'IA lit {{ meta.reading }} document{{ meta.reading > 1 ? 's' : '' }} : la liste se met à jour toute seule.</span></div>
          <div v-if="!meta.ai" class="vr-note"><Icon name="info" class="ti"/> <span>Sans clé IA, les documents sont gardés et se retrouvent par leur nom, mais ne sont ni lus ni rangés tout seuls. <template v-if="admin"><a href="#/settings?tab=ai">Paramètres → Agents IA</a> pour l'activer.</template></span></div>
          <div v-else-if="meta.unread && canEdit && !meta.reading" class="vr-note"><Icon name="info" class="ti"/> <span>{{ meta.unread }} document{{ meta.unread > 1 ? 's n’ont' : ' n’a' }} pas encore été lu{{ meta.unread > 1 ? 's' : '' }} par l'IA. <button class="btn sm" @click="readPending">Les lire maintenant</button></span></div>
          <div class="arch-bar">
            <div class="arch-search"><Icon name="search"/><input v-model="q" type="search" placeholder="Chercher : un nom, un mot du document, une référence…" aria-label="Chercher dans les documents"></div>
            <select v-model="kind" aria-label="Type de document"><option value="">Tous les types</option><option v-for="(l, k) in meta.kinds" :value="k">{{ l }}</option></select>
            <span v-if="current && canEdit" class="btns"><button class="icon-btn" title="Renommer ce dossier" aria-label="Renommer ce dossier" @click="rename"><Icon name="pencil" class="ti"/></button>
              <button v-if="canManage && !current.system" class="icon-btn" title="Supprimer ce dossier" aria-label="Supprimer ce dossier" @click="removeFolder"><Icon name="trash-2" class="ti"/></button></span>
          </div>
          <div class="card">
            <div class="table-wrap"><table>
              <thead><tr><th>Document</th><th>Type</th><th>Correspondant</th><th>Date</th><th class="num">Montant</th><th>Échéance</th></tr></thead>
              <tbody><tr v-for="d in docs" :key="d.id" class="click" @click="go('/archives?doc=' + d.id)">
                <td><b>{{ d.title }}</b> <span v-if="STATUS[d.status]" class="badge" :class="STATUS[d.status][1]">{{ STATUS[d.status][0] }}</span>
                  <span v-if="d.purchase_id" class="badge b-green" title="Encodé dans les Achats"><Icon name="shopping-cart" class="ti"/> Achats</span>
                  <div class="muted small">{{ pathOf(d.folder_id) }}<template v-if="d.source === 'email'"> · reçu par e-mail</template></div></td>
                <td>{{ meta.kinds[d.kind] }}</td><td>{{ d.correspondent }}</td><td class="nowrap">{{ fdate(d.doc_date) }}</td>
                <td class="num nowrap">{{ d.amount != null ? money(d.amount) : '' }}</td>
                <td class="nowrap"><template v-if="d.cancel_by || d.contract_end">{{ fdate(d.cancel_by || d.contract_end) }} <span v-if="due(d.cancel_by || d.contract_end)" class="badge" :class="due(d.cancel_by || d.contract_end)[1]">{{ due(d.cancel_by || d.contract_end)[0] }}</span></template></td>
              </tr></tbody>
            </table></div>
            <Empty v-if="!docs.length" icon="file-text" :text="q || kind ? 'Aucun document ne correspond' : current ? 'Ce dossier est vide' : 'Aucun document pour l’instant'"/>
          </div>
          <p v-if="canEdit" class="muted small arch-hint"><Icon name="upload" class="ti"/> Glissez des fichiers n'importe où sur cette page pour les déposer{{ target ? ' dans « ' + target.path + ' »' : '' }}.
            <template v-if="meta.inbox.address"> <Icon name="mail" class="ti"/> Ou transférez-les à <b>{{ meta.inbox.address }}</b>{{ meta.inbox.enabled ? '' : ' (relevé automatique coupé)' }}.</template>
            <template v-else-if="admin"> <Icon name="mail" class="ti"/> <a href="#" @click.prevent="settings = true">Régler la réception par e-mail</a>.</template></p>
        </template>

        <template v-else>
          <div class="card">
            <div class="card-head"><h2>Contrats à surveiller</h2></div>
            <div class="table-wrap"><table>
              <thead><tr><th>Contrat</th><th>Avec</th><th>À résilier avant le</th><th>Fin du contrat</th><th>Rappel</th></tr></thead>
              <tbody><tr v-for="d in deadlines" :key="d.id" class="click" @click="go('/archives?view=deadlines&doc=' + d.id)">
                <td><b>{{ d.title }}</b><div class="muted small">{{ meta.kinds[d.kind] }}<template v-if="d.renewal === 'tacit'"> · reconduction tacite</template></div></td>
                <td>{{ d.correspondent }}</td>
                <td class="nowrap"><template v-if="d.cancel_by">{{ fdate(d.cancel_by) }} <span class="badge" :class="due(d.cancel_by)[1]">{{ due(d.cancel_by)[0] }}</span></template><span v-else class="muted">préavis inconnu</span></td>
                <td class="nowrap">{{ fdate(d.contract_end) }} <span v-if="!d.cancel_by && d.contract_end" class="badge" :class="due(d.contract_end)[1]">{{ due(d.contract_end)[0] }}</span></td>
                <td class="nowrap">{{ d.reminder_date ? fdate(d.reminder_date) + (d.reminder_status === 'done' ? ' (traité)' : '') : '—' }}</td>
              </tr></tbody>
            </table></div>
            <Empty v-if="!deadlines.length" icon="calendar-clock" text="Aucun contrat avec une date de fin pour l’instant"/>
          </div>
          <div class="card hide-phone">
            <div class="card-head"><div class="btns cal-nav"><button class="btn sm" @click="shift(-1)" aria-label="Mois précédent">←</button><h2 style="margin:0;text-transform:capitalize">{{ month.toLocaleDateString('fr-LU', { month: 'long', year: 'numeric' }) }}</h2><button class="btn sm" @click="shift(1)" aria-label="Mois suivant">→</button></div>
              <span class="muted small"><span class="arch-dot cancel"></span> date limite de résiliation <span class="arch-dot end"></span> fin du contrat</span></div>
            <div class="cal"><div v-for="x in ['Lun','Mar','Mer','Jeu','Ven','Sam','Dim']" :key="x" class="cal-h">{{ x }}</div>
              <div v-for="x in days" :key="x.key" class="cal-d arch-day" :class="{ other: x.other, today: x.today }">
                <span class="n">{{ x.day }}</span>
                <div v-for="e in x.events" :key="e.cls + e.id" class="cal-post arch-ev" :class="e.cls" :title="e.label + ' : ' + e.title" @click="go('/archives?view=deadlines&doc=' + e.id)">{{ e.label }} : {{ e.title }}</div>
              </div>
            </div>
          </div>
        </template>
      </section>
    </div>
    <div v-if="drag && canEdit" class="arch-drop"><div><Icon name="upload"/><b>Déposez vos documents ici</b><span v-if="target">dans « {{ target.path }} »</span></div></div>
    <DocModal v-if="open" :key="open" :id="open" :folders="meta.folders" :kinds="meta.kinds" :ai="meta.ai" @close="closeDoc" @changed="load"/>
    <AskModal v-if="asking" :ai="meta.ai" @close="asking = false"/>
    <SettingsModal v-if="settings" :config="meta.config" @close="settings = false" @changed="load"/>
  </div>`,
};
