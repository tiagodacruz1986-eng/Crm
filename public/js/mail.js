// E-mails, historique ("chatter") et activités planifiées — utilisables sur chaque page et chaque fiche.
import { ref, reactive, computed, onMounted, watch } from 'vue';
import { StudioZone } from './studio.js';
import { GET, POST, PUT, DEL, act, toast, store, date, datetime, today } from './api.js';
import { go } from './router.js';
import { can } from './apps.js';

export const meta = reactive({ loaded: false, modules: {}, types: {}, users: [], mail: null });
export async function loadMeta(force) {
  if (meta.loaded && !force) return meta;
  // la configuration e-mail n'est qu'un plus : son absence ne doit jamais empêcher d'afficher les activités
  const [m, users, mail] = await Promise.all([GET('/activities/meta'), GET('/users'), GET('/mail/config').catch(() => ({}))]);
  Object.assign(meta, m, { users: users.filter((u) => u.active), mail, loaded: true });
  return meta;
}
export const TYPE_ICON = { todo: 'circle-check', call: 'phone', email: 'mail', meeting: 'handshake', reminder: 'bell', payment: 'banknote', order: 'package' };
const REC = { none: 'Pas de répétition', daily: 'Tous les jours', weekly: 'Toutes les semaines', monthly: 'Tous les mois', yearly: 'Tous les ans' };
export const bus = reactive({ tick: 0 }); // incrémenté à chaque changement pour rafraîchir compteurs et listes

// ---------- Rédaction d'un e-mail ----------
export const MailComposer = {
  props: { model: String, recordId: [Number, String], template: String, module: String, preset: Object },
  emits: ['close', 'sent'],
  setup(props, { emit }) {
    const f = reactive({ to: '', cc: '', subject: '', intro: '', include_document: false, template: props.template || '', templates: [] });
    const when = ref('now');
    // envoi programmé : par défaut demain matin (une heure déjà passée serait refusée)
    const tomorrow = () => { const d = new Date(); d.setDate(d.getDate() + 1); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
    const at = ref(`${tomorrow()}T08:00`);
    const preview = ref('');
    const busy = ref(false);
    const ai = reactive({ open: false, instruction: '', busy: false });
    const load = async (template) => {
      const r = await GET(`/mail/compose?model=${props.model || ''}&id=${props.recordId || ''}&template=${template || ''}`);
      Object.assign(f, { ...r, to: f.to || r.to });
      preview.value = '';
    };
    onMounted(async () => {
      await loadMeta(); await load(props.template);
      // objet et message préparés par un bouton personnalisé de la fiche
      if (props.preset) { if (props.preset.subject) f.subject = props.preset.subject; if (props.preset.body) f.intro = props.preset.body; f.include_document = false; }
    });
    const showPreview = async () => {
      preview.value = (await act(() => POST('/mail/preview', { model: props.model, record_id: props.recordId, intro: f.intro, include_document: f.include_document }))).html;
    };
    const draft = async () => {
      ai.busy = true;
      try { f.intro = (await act(() => POST('/mail/draft-ai', { model: props.model, record_id: props.recordId, subject: f.subject, intro: f.intro, instruction: ai.instruction }))).intro; ai.open = false; }
      finally { ai.busy = false; }
    };
    const send = async () => {
      busy.value = true;
      try {
        const r = await act(() => POST('/mail/send', { model: props.model, record_id: props.recordId, to: f.to, cc: f.cc, subject: f.subject, intro: f.intro, include_document: f.include_document, scheduled_at: when.value === 'later' ? at.value : null }));
        toast(r.status === 'scheduled' ? `E-mail programmé pour le ${datetime(at.value)}` : `E-mail envoyé à ${f.to}`);
        bus.tick++;
        emit('sent', r);
        emit('close');
      } finally { busy.value = false; }
    };
    const mailto = computed(() => `mailto:${encodeURIComponent(f.to)}?subject=${encodeURIComponent(f.subject)}${f.cc ? `&cc=${encodeURIComponent(f.cc)}` : ''}&body=${encodeURIComponent(f.intro)}`);
    return { f, when, at, preview, busy, ai, load, showPreview, draft, send, mailto, meta, store };
  },
  template: `
  <Modal title="Envoyer un e-mail" wide @close="$emit('close')">
    <div v-if="meta.mail && !meta.mail.configured" class="error">L'envoi automatique n'est pas encore configuré (Paramètres → E-mails). Vous pouvez quand même ouvrir le message dans votre messagerie habituelle.</div>
    <div class="form-grid">
      <label v-if="f.templates.length > 1">Modèle<select v-model="f.template" @change="load(f.template)"><option v-for="t in f.templates" :value="t.key">{{ t.label }}</option></select></label>
      <label style="grid-column: span 2">À<input v-model="f.to" type="email" placeholder="client@exemple.lu"></label>
      <label>Cc<input v-model="f.cc"></label>
      <label class="full">Objet<input v-model="f.subject"></label>
    </div>
    <label>Message<textarea v-model="f.intro" rows="9"></textarea></label>
    <div class="btns">
      <label class="check" v-if="model"><input type="checkbox" v-model="f.include_document"> Inclure le détail (lignes, total, QR code de paiement)</label>
      <button class="btn sm" @click="ai.open = !ai.open"><Icon name="sparkles" class="ti"/> Rédiger avec Sophie (IA)</button>
      <button class="btn sm" @click="showPreview"><Icon name="eye" class="ti"/> Aperçu</button>
    </div>
    <div v-if="ai.open" class="btns"><input v-model="ai.instruction" style="flex:1" placeholder="Ex. : plus court, ton ferme, en allemand, proposer un rendez-vous mardi…" @keydown.enter="draft"><button class="btn primary sm" :disabled="ai.busy" @click="draft">{{ ai.busy ? 'Sophie écrit…' : 'Rédiger' }}</button></div>
    <iframe v-if="preview" :srcdoc="preview" sandbox="allow-same-origin" title="Aperçu de l'e-mail" style="width:100%;height:340px;border:1px solid var(--line);border-radius:8px;background:#fff"></iframe>
    <div class="btns" style="border-top:1px solid var(--line);padding-top:12px">
      <label class="check"><input type="radio" value="now" v-model="when"> Envoyer maintenant</label>
      <label class="check"><input type="radio" value="later" v-model="when"> Programmer l'envoi</label>
      <input v-if="when === 'later'" type="datetime-local" v-model="at" style="width:auto">
    </div>
    <template #foot>
      <a class="btn" :href="mailto" style="margin-right:auto">Ouvrir dans ma messagerie</a>
      <button class="btn" @click="$emit('close')">Annuler</button>
      <button class="btn primary" :disabled="busy || !f.to || !f.subject || (meta.mail && !meta.mail.configured)" @click="send">{{ when === 'later' ? 'Programmer' : '➤ Envoyer' }}</button>
    </template>
  </Modal>`,
};

// ---------- Création / modification d'une activité ----------
export const ActivityModal = {
  props: { activity: Object, model: String, recordId: [Number, String], module: String },
  emits: ['close', 'saved'],
  setup(props, { emit }) {
    const a = reactive({ type: 'todo', summary: '', note: '', due_date: today(), due_time: '', user_id: store.user?.id, recurrence: 'none', module: props.module || '', ...(props.activity || {}) });
    onMounted(loadMeta);
    const quick = (days) => { const d = new Date(); d.setDate(d.getDate() + days); a.due_date = new Date(d - d.getTimezoneOffset() * 6e4).toISOString().slice(0, 10); };
    const save = async () => {
      if (a.id) await act(() => PUT('/activities/' + a.id, a), 'Activité modifiée');
      else await act(() => POST('/activities', { ...a, model: props.model || null, record_id: props.recordId || null }), 'Activité planifiée');
      bus.tick++;
      emit('saved'); emit('close');
    };
    return { a, meta, quick, save, REC, TYPE_ICON };
  },
  template: `
  <Modal :title="a.id ? 'Modifier l\\'activité' : 'Planifier une activité'" @close="$emit('close')">
    <div class="btns"><button v-for="(l, k) in meta.types" class="btn sm" :class="{primary: a.type === k}" @click="a.type = k"><Icon :name="TYPE_ICON[k]" class="ti"/> {{ l }}</button></div>
    <label>Résumé<input v-model="a.summary" placeholder="Ex. : Rappeler le client pour le devis"></label>
    <div class="form-grid">
      <label>Échéance<input type="date" v-model="a.due_date"></label>
      <label>Heure (facultatif)<input type="time" v-model="a.due_time"></label>
      <label>Assigné à<select v-model="a.user_id"><option v-for="u in meta.users" :value="u.id">{{ u.name }}</option></select></label>
      <label>Répétition<select v-model="a.recurrence"><option v-for="(l, k) in REC" :value="k">{{ l }}</option></select></label>
      <label v-if="!model">Module<select v-model="a.module"><option v-for="(l, k) in meta.modules" :value="k">{{ l }}</option></select></label>
    </div>
    <div class="btns small"><span class="muted">Raccourcis :</span><button class="btn sm" @click="quick(0)">Aujourd'hui</button><button class="btn sm" @click="quick(1)">Demain</button><button class="btn sm" @click="quick(7)">Dans 1 semaine</button><button class="btn sm" @click="quick(30)">Dans 1 mois</button></div>
    <label>Note<textarea v-model="a.note"></textarea></label>
    <template #foot><button class="btn" @click="$emit('close')">Annuler</button><button class="btn primary" :disabled="!a.summary || !a.due_date" @click="save">Enregistrer</button></template>
  </Modal>`,
};

// Ligne d'activité réutilisable
export const ActivityItem = {
  props: { a: Object, showRecord: Boolean },
  emits: ['changed', 'edit'],
  setup(props, { emit }) {
    const done = ref(false);
    const feedback = ref('');
    const late = computed(() => props.a.due_date < today());
    const isToday = computed(() => props.a.due_date === today());
    const finish = async () => { const r = await act(() => POST(`/activities/${props.a.id}/done`, { feedback: feedback.value }), 'Activité terminée'); if (r.next) toast(`Prochaine occurrence le ${date(r.next)}`); bus.tick++; emit('changed'); };
    const cancel = async () => { if (!confirm('Annuler cette activité ?')) return; await act(() => DEL('/activities/' + props.a.id)); bus.tick++; emit('changed'); };
    return { done, feedback, late, isToday, finish, cancel, date, go, TYPE_ICON, meta };
  },
  template: `
  <div class="activity" :class="{late, today: isToday}">
    <div style="display:flex;gap:8px;align-items:flex-start">
      <span class="act-icon"><Icon :name="TYPE_ICON[a.type] || 'circle-check'" class="ti"/></span>
      <div style="flex:1;min-width:0">
        <div><b>{{ a.summary }}</b> <span v-if="a.recurrence !== 'none'" title="Répétition" class="muted small"><Icon name="repeat" class="ti"/></span></div>
        <div class="small" :class="late ? 'neg' : isToday ? 'warn' : 'muted'">{{ late ? 'En retard · ' : isToday ? 'Aujourd\\'hui · ' : '' }}{{ date(a.due_date) }} {{ a.due_time || '' }} · {{ a.user_name }}</div>
        <div v-if="showRecord && a.record" class="small"><a :href="'#' + a.record.link"><Icon name="link" class="ti"/> {{ a.record.label }}</a></div>
        <div v-else-if="showRecord" class="small muted">{{ meta.modules[a.module] || a.module }}</div>
        <div v-if="a.note" class="small" style="white-space:pre-wrap;margin-top:4px">{{ a.note }}</div>
      </div>
    </div>
    <div v-if="done" class="btns" style="margin-top:6px"><input v-model="feedback" placeholder="Compte rendu (facultatif)" style="flex:1" @keydown.enter="finish"><button class="btn sm success" @click="finish">Valider</button></div>
    <div v-else class="btns" style="margin-top:6px"><button class="btn sm success" @click="done = true">✓ Fait</button><button class="btn sm" @click="$emit('edit', a)">✎</button><button class="btn sm danger" @click="cancel">✕</button></div>
  </div>`,
};

// ---------- Historique + activités d'une fiche (comme le "chatter" d'Odoo) ----------
export const Chatter = {
  props: { model: String, recordId: [Number, String] },
  emits: ['mailed'], // un e-mail vient de partir (ou d'être programmé) depuis l'historique : la fiche peut réagir
  components: { MailComposer, ActivityModal, ActivityItem, StudioZone },
  inheritAttrs: false, // (deux blocs : la zone personnalisée puis l'historique, qui reçoit les attributs)
  setup(props, { emit }) {
    const data = ref(null);
    const mode = ref(null); // 'mail' | 'chat' | 'note' | 'activity'
    const preset = ref(null); // e-mail préparé par un bouton personnalisé de la fiche
    const STUDIO = ['customer', 'vehicle', 'document', 'product', 'purchase', 'lead'];
    const note = ref('');
    const editing = ref(null);
    const load = async () => { if (props.recordId && props.recordId !== 'new') data.value = await GET(`/chatter/${props.model}/${props.recordId}`); };
    onMounted(load);
    watch(() => [props.recordId, bus.tick], load);
    const addNote = async () => { await act(() => POST(`/chatter/${props.model}/${props.recordId}/note`, { body: note.value })); note.value = ''; mode.value = null; load(); };
    const cancelMail = async (e) => { await act(() => DEL('/mail/' + e.id), 'Envoi annulé'); bus.tick++; };
    // ---------- Conversation par e-mail avec le client (ou le fournisseur), gardée dans la fiche ----------
    const WHO = { purchase: 'fournisseur', supplier: 'fournisseur', product: null, archive: null };
    const who = computed(() => (props.model in WHO ? WHO[props.model] : 'client'));
    const canMail = can('emails', 'user');
    const isAdmin = computed(() => store.user?.role === 'admin');
    const chat = reactive({ to: '', subject: '', text: '', busy: false });
    const openChat = (m) => {
      const c = data.value?.contact || {};
      const addr = m ? (/[^\s<>,;]+@[^\s<>,;]+/.exec(m.from_addr || '') || [''])[0] : '';
      const subject = m?.subject ? (/^\s*re\s*:/i.test(m.subject) ? m.subject : 'Re: ' + m.subject) : c.subject || '';
      Object.assign(chat, { to: addr || c.to || '', subject });
      mode.value = 'chat';
    };
    const sendChat = async () => {
      if (chat.busy) return;
      chat.busy = true;
      try {
        const r = await act(() => POST('/mail/send', { model: props.model, record_id: Number(props.recordId), to: chat.to.trim(), subject: chat.subject.trim(), intro: chat.text.trim(), include_document: false }), 'E-mail envoyé au ' + who.value);
        chat.text = ''; mode.value = null; bus.tick++; emit('mailed', r);
      } catch { /* le message d'erreur est déjà affiché ; le texte reste dans la zone */ } finally { chat.busy = false; }
    };
    const checking = ref(false);
    const checkReplies = async () => {
      if (checking.value) return;
      checking.value = true;
      try { const r = await act(() => POST('/mail/replies/check')); toast(r.matched ? (r.matched > 1 ? r.matched + ' réponses rangées dans leurs fiches' : '1 réponse rangée dans sa fiche') : 'Aucune nouvelle réponse'); bus.tick++; }
      catch { /* erreur déjà affichée */ } finally { checking.value = false; }
    };
    const opened = reactive({}); // textes longs dépliés
    const isLong = (t) => String(t || '').length > 420 || String(t || '').split('\n').length > 7;
    const size = (n) => (n > 1048576 ? (n / 1048576).toFixed(1).replace('.', ',') + ' Mo' : Math.max(1, Math.round(n / 1024)) + ' ko');
    const stamp = (m) => datetime(m.created_at.replace(' ', 'T') + 'Z');
    return { data, mode, note, editing, load, addNote, cancelMail, datetime, preset, STUDIO, who, canMail, isAdmin, chat, openChat, sendChat, checking, checkReplies, opened, isLong, size, stamp, go };
  },
  template: `
  <StudioZone v-if="STUDIO.includes(model) && recordId && recordId !== 'new'" :model="model" :record-id="recordId" @mail="preset = $event; mode = 'mail'" @changed="load"/>
  <div class="card chatter no-print" v-if="data" v-bind="$attrs">
    <div class="btns">
      <button class="btn sm" :class="{primary: mode==='mail'}" @click="mode = 'mail'"><Icon name="mail" class="ti"/> Envoyer un e-mail</button>
      <button class="btn sm" v-if="who && canMail" :class="{primary: mode==='chat'}" @click="mode === 'chat' ? (mode = null) : openChat()"><Icon name="message-circle" class="ti"/> Écrire au {{ who }}</button>
      <button class="btn sm" :class="{primary: mode==='note'}" @click="mode = mode === 'note' ? null : 'note'"><Icon name="notebook-pen" class="ti"/> Note</button>
      <button class="btn sm" :class="{primary: mode==='activity'}" @click="mode = 'activity'"><Icon name="alarm-clock" class="ti"/> Planifier une activité</button>
    </div>
    <div v-if="mode==='chat'" class="chat-box">
      <div class="chat-box-head">
        <label>À <input type="email" v-model="chat.to" :placeholder="'Adresse e-mail du ' + who"></label>
        <label>Objet <input v-model="chat.subject" maxlength="200"></label>
      </div>
      <textarea v-model="chat.text" rows="4" :placeholder="'Votre message au ' + who + ' — il part par e-mail et reste dans cette fiche'"></textarea>
      <div class="chat-box-foot">
        <span class="small muted" v-if="data.inbox?.enabled"><Icon name="inbox" class="ti"/> Sa réponse reviendra ici, dans l'historique.</span>
        <span class="small muted" v-else><Icon name="info" class="ti"/> Pour voir ses réponses ici, activez la réception dans <a v-if="isAdmin" href="#/settings?tab=mail">Paramètres → E-mails</a><template v-else>Paramètres → E-mails (gérant)</template>.</span>
        <button class="btn sm primary" :disabled="chat.busy || !chat.text.trim() || !chat.to.trim() || !chat.subject.trim()" @click="sendChat"><Icon name="send" class="ti"/> Envoyer</button>
      </div>
    </div>
    <div v-if="mode==='note'" style="margin-top:10px"><textarea v-model="note" placeholder="Note interne (visible uniquement par l'équipe)"></textarea><button class="btn sm primary" style="margin-top:6px" :disabled="!note.trim()" @click="addNote">Enregistrer la note</button></div>
    <template v-if="data.activities.length">
      <h3 style="margin:14px 0 6px">Activités planifiées</h3>
      <ActivityItem v-for="a in data.activities" :key="a.id" :a="a" @changed="load" @edit="editing = $event"/>
    </template>
    <template v-if="data.scheduled.length">
      <h3 style="margin:14px 0 6px">E-mails programmés</h3>
      <div v-for="e in data.scheduled" class="list-item small"><span><Icon name="clock" class="ti"/> {{ datetime(e.scheduled_at) }} → {{ e.to_addr }} · {{ e.subject }}</span><button class="btn sm danger" @click="cancelMail(e)">Annuler</button></div>
    </template>
    <div class="chat-title">
      <h3>Historique</h3>
      <span class="small muted" v-if="data.inbox?.enabled && who">
        <template v-if="data.inbox.error"><span class="neg">Relève des réponses impossible</span> · </template>
        <template v-else-if="data.inbox.at">Réponses relevées le {{ datetime(data.inbox.at) }} · </template>
        <button v-if="canMail" class="link-btn" :disabled="checking" @click="checkReplies">{{ checking ? 'Relève en cours…' : 'Relever maintenant' }}</button>
      </span>
    </div>
    <div v-for="m in data.messages" :key="m.id" class="chat-msg" :class="m.kind">
      <span v-if="m.kind === 'email_in'" class="avatar mail-in-avatar" title="E-mail reçu"><Icon name="mail" class="ti"/></span>
      <span v-else class="avatar" :style="{background: m.user_color || '#94a3b8', width: '26px', height: '26px', fontSize: '11px'}">{{ (m.user_name || '•')[0] }}</span>
      <div style="flex:1;min-width:0">
        <!-- Réponse reçue par e-mail -->
        <template v-if="m.kind === 'email_in'">
          <div class="small muted"><b class="mail-from">{{ m.from_addr || 'Expéditeur inconnu' }}</b> · reçu le {{ stamp(m) }}</div>
          <div class="mail-bubble in">
            <div class="mail-subject" v-if="m.subject">{{ m.subject }}</div>
            <div class="mail-text" :class="{clamp: isLong(m.body) && !opened[m.id]}">{{ m.body }}</div>
            <button v-if="isLong(m.body)" class="link-btn" @click="opened[m.id] = !opened[m.id]">{{ opened[m.id] ? 'Réduire' : 'Lire la suite' }}</button>
            <div class="mail-files" v-if="m.files && m.files.length">
              <a v-for="f in m.files" :key="f.id" class="mail-file" :href="'/api/attachment/' + f.id" target="_blank" rel="noopener" :title="'Ouvrir ' + f.filename"><Icon name="paperclip" class="ti"/> {{ f.filename }} <span class="muted">· {{ size(f.size) }}</span></a>
            </div>
          </div>
          <button v-if="canMail && who" class="link-btn" @click="openChat(m)"><Icon name="reply" class="ti"/> Répondre</button>
        </template>
        <!-- E-mail envoyé : son texte se relit dans la fiche -->
        <template v-else-if="m.kind === 'email' && m.email_intro">
          <div class="small muted">{{ m.user_name || 'Système' }} · {{ stamp(m) }}<span v-if="m.email_status === 'error'" class="neg"> · échec</span></div>
          <div class="mail-line">{{ m.body }}</div>
          <div class="mail-bubble out">
            <div class="mail-text" :class="{clamp: isLong(m.email_intro) && !opened[m.id]}">{{ m.email_intro }}</div>
            <button v-if="isLong(m.email_intro)" class="link-btn" @click="opened[m.id] = !opened[m.id]">{{ opened[m.id] ? 'Réduire' : 'Lire la suite' }}</button>
            <div class="small muted" v-if="m.email_with_doc"><Icon name="file-text" class="ti"/> avec le document</div>
          </div>
        </template>
        <template v-else>
          <div class="small muted">{{ m.user_name || 'Système' }} · {{ stamp(m) }}<span v-if="m.email_status === 'error'" class="neg"> · échec</span></div>
          <div class="chat-body">{{ m.body }}</div>
        </template>
      </div>
    </div>
    <div v-if="!data.messages.length" class="muted small">Aucun échange pour l'instant.</div>
    <MailComposer v-if="mode==='mail'" :model="model" :record-id="recordId" :preset="preset" @close="mode = null; preset = null" @sent="load(); $emit('mailed', $event)"/>
    <ActivityModal v-if="mode==='activity' || editing" :activity="editing" :model="model" :record-id="recordId" @close="mode = null; editing = null" @saved="load"/>
  </div>`,
};

// ---------- Boutons "E-mail" et "Activités" présents sur chaque page ----------
export const ModuleTools = {
  props: { module: String },
  components: { MailComposer, ActivityModal, ActivityItem },
  setup(props) {
    const list = ref([]);
    const open = ref(null); // 'mail' | 'list' | 'new'
    const editing = ref(null);
    const load = async () => { list.value = await GET(`/activities?module=${props.module}`); };
    onMounted(load);
    watch(() => bus.tick, load);
    const late = computed(() => list.value.filter((a) => a.due_date < today()).length);
    return { list, open, editing, load, late, meta };
  },
  template: `
  <span class="btns module-tools">
    <button class="btn" @click="open = 'mail'" title="Envoyer un e-mail"><Icon name="mail"/></button>
    <button class="btn" @click="open = 'list'" title="Activités de ce module"><Icon name="alarm-clock"/> <span class="badge" :class="late ? 'b-red' : 'b-gray'" v-if="list.length">{{ list.length }}</span></button>
    <MailComposer v-if="open === 'mail'" @close="open = null"/>
    <Modal v-if="open === 'list'" :title="'Activités — ' + (meta.modules[module] || module)" @close="open = null">
      <button class="btn primary" @click="open = 'new'">+ Nouvelle activité</button>
      <ActivityItem v-for="a in list" :key="a.id" :a="a" show-record @changed="load" @edit="editing = $event; open = null"/>
      <Empty v-if="!list.length" icon="alarm-clock" text="Aucune activité planifiée dans ce module"/>
      <a href="#/activities" @click="open = null">Voir toutes mes activités →</a>
    </Modal>
    <ActivityModal v-if="open === 'new' || editing" :activity="editing" :module="module" @close="open = null; editing = null" @saved="load"/>
  </span>`,
};

// ---------- Cloche de la barre du haut ----------
export const ActivityBell = {
  setup() {
    const c = ref({ late: 0, today: 0, upcoming: 0 });
    const load = async () => { try { c.value = await GET('/activities/counts'); } catch { /* déconnecté */ } };
    onMounted(() => { load(); setInterval(load, 60000); });
    watch(() => bus.tick, load);
    return { c, go };
  },
  template: `<button class="btn bell" @click="go('/activities')" :title="c.late + ' en retard, ' + c.today + ' aujourd\\'hui'"><Icon name="bell"/><span v-if="c.late + c.today" class="badge" :class="c.late ? 'b-red' : 'b-orange'">{{ c.late + c.today }}</span></button>`,
};
