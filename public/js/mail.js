// E-mails, historique ("chatter") et activités planifiées — utilisables sur chaque page et chaque fiche.
import { ref, reactive, computed, onMounted, watch } from 'vue';
import { GET, POST, PUT, DEL, act, toast, store, date, datetime, today } from './api.js';
import { go } from './router.js';

export const meta = reactive({ loaded: false, modules: {}, types: {}, users: [], mail: null });
export async function loadMeta(force) {
  if (meta.loaded && !force) return meta;
  const [m, users, mail] = await Promise.all([GET('/activities/meta'), GET('/users'), GET('/mail/config')]);
  Object.assign(meta, m, { users: users.filter((u) => u.active), mail, loaded: true });
  return meta;
}
export const TYPE_ICON = { todo: '✅', call: '📞', email: '✉️', meeting: '🤝', reminder: '🔔', payment: '💶', order: '📦' };
const REC = { none: 'Pas de répétition', daily: 'Tous les jours', weekly: 'Toutes les semaines', monthly: 'Tous les mois', yearly: 'Tous les ans' };
export const bus = reactive({ tick: 0 }); // incrémenté à chaque changement pour rafraîchir compteurs et listes

// ---------- Rédaction d'un e-mail ----------
export const MailComposer = {
  props: { model: String, recordId: [Number, String], template: String, module: String },
  emits: ['close', 'sent'],
  setup(props, { emit }) {
    const f = reactive({ to: '', cc: '', subject: '', intro: '', include_document: false, template: props.template || '', templates: [] });
    const when = ref('now');
    const at = ref(`${today()}T08:00`);
    const preview = ref('');
    const busy = ref(false);
    const ai = reactive({ open: false, instruction: '', busy: false });
    const load = async (template) => {
      const r = await GET(`/mail/compose?model=${props.model || ''}&id=${props.recordId || ''}&template=${template || ''}`);
      Object.assign(f, { ...r, to: f.to || r.to });
      preview.value = '';
    };
    onMounted(async () => { await loadMeta(); await load(props.template); });
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
  <Modal title="✉️ Envoyer un e-mail" wide @close="$emit('close')">
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
      <button class="btn sm" @click="ai.open = !ai.open">✨ Rédiger avec Sophie (IA)</button>
      <button class="btn sm" @click="showPreview">👁 Aperçu</button>
    </div>
    <div v-if="ai.open" class="btns"><input v-model="ai.instruction" style="flex:1" placeholder="Ex. : plus court, ton ferme, en allemand, proposer un rendez-vous mardi…" @keydown.enter="draft"><button class="btn primary sm" :disabled="ai.busy" @click="draft">{{ ai.busy ? 'Sophie écrit…' : 'Rédiger' }}</button></div>
    <iframe v-if="preview" :srcdoc="preview" style="width:100%;height:340px;border:1px solid var(--line);border-radius:8px;background:#fff"></iframe>
    <div class="btns" style="border-top:1px solid var(--line);padding-top:12px">
      <label class="check"><input type="radio" value="now" v-model="when"> Envoyer maintenant</label>
      <label class="check"><input type="radio" value="later" v-model="when"> Programmer l'envoi</label>
      <input v-if="when === 'later'" type="datetime-local" v-model="at" style="width:auto">
    </div>
    <template #foot>
      <a class="btn" :href="mailto" style="margin-right:auto">Ouvrir dans ma messagerie</a>
      <button class="btn" @click="$emit('close')">Annuler</button>
      <button class="btn primary" :disabled="busy || !f.to || !f.subject || (meta.mail && !meta.mail.configured)" @click="send">{{ when === 'later' ? '🕒 Programmer' : '➤ Envoyer' }}</button>
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
  <Modal :title="a.id ? 'Modifier l\\'activité' : '⏰ Planifier une activité'" @close="$emit('close')">
    <div class="btns"><button v-for="(l, k) in meta.types" class="btn sm" :class="{primary: a.type === k}" @click="a.type = k">{{ TYPE_ICON[k] }} {{ l }}</button></div>
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
      <span class="act-icon">{{ TYPE_ICON[a.type] || '✅' }}</span>
      <div style="flex:1;min-width:0">
        <div><b>{{ a.summary }}</b> <span v-if="a.recurrence !== 'none'" title="Répétition" class="muted small">🔁</span></div>
        <div class="small" :class="late ? 'neg' : isToday ? 'warn' : 'muted'">{{ late ? 'En retard · ' : isToday ? 'Aujourd\\'hui · ' : '' }}{{ date(a.due_date) }} {{ a.due_time || '' }} · {{ a.user_name }}</div>
        <div v-if="showRecord && a.record" class="small"><a :href="'#' + a.record.link">🔗 {{ a.record.label }}</a></div>
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
  components: { MailComposer, ActivityModal, ActivityItem },
  setup(props) {
    const data = ref(null);
    const mode = ref(null); // 'mail' | 'note' | 'activity'
    const note = ref('');
    const editing = ref(null);
    const load = async () => { if (props.recordId && props.recordId !== 'new') data.value = await GET(`/chatter/${props.model}/${props.recordId}`); };
    onMounted(load);
    watch(() => [props.recordId, bus.tick], load);
    const addNote = async () => { await act(() => POST(`/chatter/${props.model}/${props.recordId}/note`, { body: note.value })); note.value = ''; mode.value = null; load(); };
    const cancelMail = async (e) => { await act(() => DEL('/mail/' + e.id), 'Envoi annulé'); load(); };
    return { data, mode, note, editing, load, addNote, cancelMail, datetime };
  },
  template: `
  <div class="card chatter no-print" v-if="data">
    <div class="btns">
      <button class="btn sm" :class="{primary: mode==='mail'}" @click="mode = 'mail'">✉️ Envoyer un e-mail</button>
      <button class="btn sm" :class="{primary: mode==='note'}" @click="mode = mode === 'note' ? null : 'note'">📝 Note</button>
      <button class="btn sm" :class="{primary: mode==='activity'}" @click="mode = 'activity'">⏰ Planifier une activité</button>
    </div>
    <div v-if="mode==='note'" style="margin-top:10px"><textarea v-model="note" placeholder="Note interne (visible uniquement par l'équipe)"></textarea><button class="btn sm primary" style="margin-top:6px" :disabled="!note.trim()" @click="addNote">Enregistrer la note</button></div>
    <template v-if="data.activities.length">
      <h3 style="margin:14px 0 6px">Activités planifiées</h3>
      <ActivityItem v-for="a in data.activities" :key="a.id" :a="a" @changed="load" @edit="editing = $event"/>
    </template>
    <template v-if="data.scheduled.length">
      <h3 style="margin:14px 0 6px">E-mails programmés</h3>
      <div v-for="e in data.scheduled" class="list-item small"><span>🕒 {{ datetime(e.scheduled_at) }} → {{ e.to_addr }} · {{ e.subject }}</span><button class="btn sm danger" @click="cancelMail(e)">Annuler</button></div>
    </template>
    <h3 style="margin:14px 0 6px">Historique</h3>
    <div v-for="m in data.messages" class="chat-msg" :class="m.kind">
      <span class="avatar" :style="{background: m.user_color || '#94a3b8', width: '26px', height: '26px', fontSize: '11px'}">{{ (m.user_name || '⚙')[0] }}</span>
      <div style="flex:1;min-width:0"><div class="small muted">{{ m.user_name || 'Système' }} · {{ datetime(m.created_at.replace(' ', 'T') + 'Z') }}<span v-if="m.email_status === 'error'" class="neg"> · échec</span></div><div style="white-space:pre-wrap">{{ m.body }}</div></div>
    </div>
    <div v-if="!data.messages.length" class="muted small">Aucun échange pour l'instant.</div>
    <MailComposer v-if="mode==='mail'" :model="model" :record-id="recordId" @close="mode = null" @sent="load"/>
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
    <button class="btn" @click="open = 'mail'" title="Envoyer un e-mail">✉️</button>
    <button class="btn" @click="open = 'list'" title="Activités de ce module">⏰ <span class="badge" :class="late ? 'b-red' : 'b-gray'" v-if="list.length">{{ list.length }}</span></button>
    <MailComposer v-if="open === 'mail'" @close="open = null"/>
    <Modal v-if="open === 'list'" :title="'⏰ Activités — ' + (meta.modules[module] || module)" @close="open = null">
      <button class="btn primary" @click="open = 'new'">+ Nouvelle activité</button>
      <ActivityItem v-for="a in list" :key="a.id" :a="a" show-record @changed="load" @edit="editing = $event; open = null"/>
      <Empty v-if="!list.length" icon="⏰" text="Aucune activité planifiée dans ce module"/>
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
  template: `<button class="btn bell" @click="go('/activities')" :title="c.late + ' en retard, ' + c.today + ' aujourd\\'hui'">⏰<span v-if="c.late + c.today" class="badge" :class="c.late ? 'b-red' : 'b-orange'">{{ c.late + c.today }}</span></button>`,
};
