// Personnalisation des fiches (façon « Studio » d'Odoo).
// - StudioZone : la zone affichée sur chaque fiche (champs, zones de fichiers PDF, boutons créés par le gérant) ;
// - StudioDesigner : le concepteur (ajouter, modifier, ranger, supprimer des éléments) — réservé à l'administrateur ;
// - StudioPanel : l'onglet « Personnalisation » des paramètres.
import { ref, reactive, computed, onMounted, watch } from 'vue';
import { GET, POST, PUT, DEL, act, toast, date, store } from './api.js';

const ICON = { text: '🔤', textarea: '📝', number: '🔢', date: '📅', checkbox: '☑️', select: '📋', file: '📎', button: '🔘' };
const ACTION_ICON = { link: '🔗', email: '✉️', activity: '⏰', stamp: '✅' };
const VALUE_KINDS = ['text', 'textarea', 'number', 'date', 'checkbox', 'select'];
const fileSize = (n) => (n > 1048576 ? (n / 1048576).toFixed(1).replace('.', ',') + ' Mo' : Math.max(1, Math.round((n || 0) / 1024)) + ' ko');
const safeLink = (u) => /^(https?:\/\/|mailto:|tel:)/i.test(u || '');

// Envoi d'un fichier brut (PDF, photo) à l'API
async function uploadFile(url, file) {
  const r = await fetch('/api' + url, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': file.type || 'application/octet-stream', 'X-Filename': encodeURIComponent(file.name) }, body: file });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error || 'Envoi impossible');
  return d;
}

// ---------- Concepteur ----------
export const StudioDesigner = {
  props: { target: String },
  emits: ['changed'],
  setup(props, { emit }) {
    const meta = ref(null);
    const fields = ref([]);
    const edit = ref(null);
    const load = async () => {
      if (!meta.value) meta.value = await GET('/studio/meta');
      fields.value = props.target ? await GET('/studio/fields?target=' + props.target) : [];
    };
    onMounted(load);
    watch(() => props.target, () => { edit.value = null; load(); });
    const info = computed(() => (meta.value?.targets || []).find((t) => t.key === props.target) || { label: '', placeholders: [] });
    const stampable = computed(() => fields.value.filter((f) => ['date', 'checkbox', 'text'].includes(f.kind) && f.active && f.id !== edit.value?.id));
    const blank = (kind) => ({ target: props.target, kind, label: '', help: '', active: 1,
      options: kind === 'button' ? { action: 'link', url: 'https://', subject: '', body: '', summary: '', activity_type: 'todo', days: 0, field_id: null } : kind === 'file' ? { accept: 'pdf' } : kind === 'select' ? { choices: '' } : {} });
    const add = (kind) => { edit.value = blank(kind); };
    const open = (f) => {
      const o = { ...f.options };
      if (f.kind === 'select') o.choices = (o.choices || []).join('\n');
      if (f.kind === 'button') Object.assign(o, { url: o.url || 'https://', subject: o.subject || '', body: o.body || '', summary: o.summary || '', activity_type: o.activity_type || 'todo', days: o.days || 0, field_id: o.field_id || null });
      edit.value = { ...f, options: o };
    };
    const done = async () => { edit.value = null; await load(); emit('changed'); };
    const save = async () => {
      const e = edit.value;
      const body = { target: e.target, kind: e.kind, label: e.label, help: e.help, active: e.active ? 1 : 0, options: e.options };
      if (e.id) await act(() => PUT('/studio/fields/' + e.id, body), 'Élément enregistré');
      else await act(() => POST('/studio/fields', body), 'Élément ajouté');
      await done();
    };
    const remove = async (f) => {
      const what = f.kind === 'file' ? 'Les fichiers déjà déposés restent attachés à leurs fiches.' : f.kind === 'button' ? '' : 'Ce qui a été saisi dans ce champ, sur toutes les fiches, sera effacé.';
      if (!confirm('Supprimer « ' + f.label + ' » ? ' + what)) return;
      await act(() => DEL('/studio/fields/' + f.id), 'Élément supprimé');
      await done();
    };
    const move = async (i, d) => {
      const ids = fields.value.map((f) => f.id);
      const j = i + d;
      if (j < 0 || j >= ids.length) return;
      [ids[i], ids[j]] = [ids[j], ids[i]];
      fields.value = await act(() => POST('/studio/order', { target: props.target, ids }));
      emit('changed');
    };
    const insert = (key, prop) => { edit.value.options[prop] = (edit.value.options[prop] || '') + '{' + key + '}'; };
    const describe = (f) => {
      if (f.kind !== 'button') return meta.value?.kinds[f.kind] || '';
      return 'Bouton — ' + (meta.value?.actions[f.options.action] || '');
    };
    return { meta, fields, edit, info, stampable, add, open, save, remove, move, insert, describe, ICON, ACTION_ICON };
  },
  template: `
  <div class="studio-designer" v-if="meta">
    <div v-for="(f, i) in fields" :key="f.id" class="st-item" :class="{ off: !f.active, cur: edit && edit.id === f.id }">
      <span class="st-ico">{{ f.kind === 'button' ? ACTION_ICON[f.options.action] : ICON[f.kind] }}</span>
      <div class="st-item-txt"><b>{{ f.label }}</b><div class="muted small">{{ describe(f) }}<span v-if="!f.active"> · masqué</span></div></div>
      <button class="icon-btn" title="Monter" :disabled="i === 0" @click="move(i, -1)">↑</button>
      <button class="icon-btn" title="Descendre" :disabled="i === fields.length - 1" @click="move(i, 1)">↓</button>
      <button class="btn sm" @click="open(f)">Modifier</button>
      <button class="icon-btn" title="Supprimer" @click="remove(f)">🗑</button>
    </div>
    <p v-if="!fields.length" class="muted small">Aucun élément personnalisé sur la fiche « {{ info.label }} ». Ajoutez-en un ci-dessous.</p>

    <div v-if="!edit" class="st-add">
      <div class="muted small" style="margin-bottom:6px">Ajouter sur la fiche « {{ info.label }} » :</div>
      <div class="btns">
        <button class="btn sm" @click="add('text')">🔤 Zone de texte</button>
        <button class="btn sm" @click="add('textarea')">📝 Grande zone de texte</button>
        <button class="btn sm" @click="add('file')">📎 Zone PDF</button>
        <button class="btn sm" @click="add('button')">🔘 Bouton</button>
        <button class="btn sm" @click="add('date')">📅 Date</button>
        <button class="btn sm" @click="add('number')">🔢 Nombre</button>
        <button class="btn sm" @click="add('checkbox')">☑️ Case à cocher</button>
        <button class="btn sm" @click="add('select')">📋 Liste de choix</button>
      </div>
    </div>

    <div v-else class="st-edit">
      <h3>{{ edit.id ? 'Modifier' : 'Nouveau' }} : {{ meta.kinds[edit.kind] }}</h3>
      <div class="form-grid">
        <label>Nom affiché<input v-model="edit.label" maxlength="60" :placeholder="edit.kind === 'button' ? 'Ex. : Catalogue pièces' : edit.kind === 'file' ? 'Ex. : Carte grise' : 'Ex. : Numéro de sinistre'"></label>
        <label>Aide (facultatif)<input v-model="edit.help" maxlength="200" placeholder="Petit texte d'explication"></label>
        <label v-if="edit.kind === 'text' || edit.kind === 'textarea'">Texte d'exemple (facultatif)<input v-model="edit.options.placeholder" maxlength="80"></label>
        <label v-if="edit.kind === 'number'">Unité (facultatif)<input v-model="edit.options.unit" maxlength="12" placeholder="km, €, bar…"></label>
        <label v-if="edit.kind === 'file'">Fichiers acceptés<select v-model="edit.options.accept"><option value="pdf">PDF seulement</option><option value="any">PDF et images (photos, scans)</option></select></label>
        <label v-if="edit.kind === 'select'" class="full">Choix proposés (un par ligne)<textarea v-model="edit.options.choices" rows="4" placeholder="Oui&#10;Non&#10;À vérifier"></textarea></label>
      </div>
      <template v-if="edit.kind === 'button'">
        <div class="form-grid" style="margin-top:12px">
          <label class="full">Que fait ce bouton ?<select v-model="edit.options.action"><option v-for="(l, k) in meta.actions" :key="k" :value="k">{{ l }}</option></select></label>
          <template v-if="edit.options.action === 'link'">
            <label class="full">Adresse à ouvrir<input v-model="edit.options.url" placeholder="https://www.exemple.com/recherche?q={plaque}"></label>
          </template>
          <template v-if="edit.options.action === 'email'">
            <label class="full">Objet du message<input v-model="edit.options.subject" maxlength="200" placeholder="Votre véhicule {plaque} est prêt"></label>
            <label class="full">Message<textarea v-model="edit.options.body" rows="5" placeholder="Bonjour {client},&#10;&#10;…"></textarea></label>
          </template>
          <template v-if="edit.options.action === 'activity'">
            <label>Type<select v-model="edit.options.activity_type"><option v-for="(l, k) in meta.activity_types" :key="k" :value="k">{{ l }}</option></select></label>
            <label>Dans combien de jours ?<input type="number" min="0" max="365" v-model.number="edit.options.days"></label>
            <label class="full">À faire<input v-model="edit.options.summary" maxlength="200" placeholder="Rappeler {client} pour le contrôle technique"></label>
          </template>
          <template v-if="edit.options.action === 'stamp'">
            <label class="full">Champ à remplir<select v-model.number="edit.options.field_id"><option :value="null">— choisir —</option><option v-for="f in stampable" :key="f.id" :value="f.id">{{ f.label }} ({{ meta.kinds[f.kind] }})</option></select></label>
          </template>
        </div>
        <p v-if="edit.options.action === 'stamp'" class="muted small">Une date reçoit la date du jour, une case est cochée, une zone de texte reçoit le nom de la personne et l'heure. Créez d'abord le champ à remplir, puis ce bouton.</p>
        <div v-if="['link', 'email', 'activity'].includes(edit.options.action) && info.placeholders.length" class="st-ph">
          <span class="muted small">Mots remplacés par les informations de la fiche (cliquez pour insérer) :</span>
          <button v-for="p in info.placeholders" :key="p" class="st-chip" @click="insert(p, edit.options.action === 'link' ? 'url' : edit.options.action === 'email' ? 'body' : 'summary')">{{ '{' + p + '}' }}</button>
        </div>
      </template>
      <label v-if="edit.id" class="st-check"><input type="checkbox" :checked="!!edit.active" @change="edit.active = $event.target.checked ? 1 : 0"> Affiché sur les fiches (décochez pour le masquer sans rien effacer)</label>
      <div class="btns" style="margin-top:12px"><button class="btn primary" :disabled="!edit.label.trim()" @click="save">{{ edit.id ? 'Enregistrer' : 'Ajouter' }}</button><button class="btn" @click="edit = null">Annuler</button></div>
    </div>
  </div>`,
};

// ---------- Zone affichée sur une fiche ----------
export const StudioZone = {
  props: { model: String, recordId: [Number, String] },
  emits: ['mail', 'changed'],
  components: { StudioDesigner },
  setup(props, { emit }) {
    const data = ref(null);
    const design = ref(false);
    const saved = ref(null);   // identifiant du dernier champ enregistré (petite coche)
    const busy = ref(null);    // zone en cours d'envoi de fichier
    const picker = ref(null);
    let target = null, savedT;
    const admin = computed(() => store.user?.role === 'admin');
    const load = async () => {
      if (!props.recordId || props.recordId === 'new') { data.value = null; return; }
      try { data.value = await GET('/studio/record/' + props.model + '/' + props.recordId); } catch { data.value = null; }
    };
    onMounted(load);
    watch(() => [props.model, props.recordId], load);
    const canWrite = computed(() => !!data.value?.can_write);
    const inputs = computed(() => (data.value?.fields || []).filter((f) => VALUE_KINDS.includes(f.kind)));
    const zones = computed(() => (data.value?.fields || []).filter((f) => f.kind === 'file'));
    const buttons = computed(() => (data.value?.fields || []).filter((f) => f.kind === 'button'));
    const save = async (f) => {
      try {
        const r = await PUT('/studio/record/' + props.model + '/' + props.recordId, { values: { [f.id]: f.value } });
        const fresh = r.fields.find((x) => x.id === f.id);
        if (fresh) f.value = fresh.value;
        saved.value = f.id; clearTimeout(savedT); savedT = setTimeout(() => { saved.value = null; }, 2000);
      } catch (e) { toast(e.message, 'error'); await load(); }
    };
    const pick = (f) => { target = f; picker.value.accept = f.options.accept === 'any' ? 'application/pdf,image/jpeg,image/png,image/webp' : 'application/pdf'; picker.value.click(); };
    const send = async (f, list) => {
      busy.value = f.id;
      try {
        for (const file of list) await act(() => uploadFile('/studio/files/' + props.model + '/' + props.recordId + '/' + f.id, file));
        toast(list.length > 1 ? list.length + ' fichiers ajoutés' : 'Fichier ajouté');
      } catch { /* l'erreur est déjà affichée */ } finally { busy.value = null; await load(); }
    };
    const chosen = (e) => { const list = [...e.target.files]; e.target.value = ''; if (target && list.length) send(target, list); };
    const drop = (f, e) => { if (!canWrite.value) return; const list = [...(e.dataTransfer?.files || [])]; if (list.length) send(f, list); };
    const removeFile = async (a) => { if (!confirm('Retirer « ' + a.filename + ' » de la fiche ?')) return; await act(() => DEL('/attachment/' + a.id), 'Fichier retiré'); await load(); };
    const press = async (b) => {
      if (b.options.action === 'email') { emit('mail', b.mail); return; }
      const r = await act(() => POST('/studio/buttons/' + props.model + '/' + props.recordId + '/' + b.id, {}));
      toast(r.done);
      data.value = { ...r.record, can_write: data.value.can_write };
      emit('changed');
    };
    const closeDesign = async () => { design.value = false; await load(); };
    return { data, design, saved, busy, picker, admin, canWrite, inputs, zones, buttons, save, pick, chosen, drop, removeFile, press, closeDesign, fileSize, safeLink, date, ACTION_ICON };
  },
  template: `
  <div v-if="data && (data.fields.length || admin)" class="card studio-zone no-print" :class="{ empty: !data.fields.length }">
    <div class="card-head" v-if="data.fields.length || admin">
      <h2 v-if="data.fields.length">Informations complémentaires</h2>
      <span v-else class="muted small">✨ Ajoutez vos propres zones de texte, boutons et zones PDF sur la fiche « {{ data.target_label }} ».</span>
      <button v-if="admin" class="btn sm" @click="design = true">⚙ Personnaliser</button>
    </div>
    <div v-if="buttons.length" class="btns st-buttons">
      <template v-for="b in buttons" :key="b.id">
        <a v-if="b.options.action === 'link' && safeLink(b.href)" class="btn" :href="b.href" target="_blank" rel="noopener noreferrer" :title="b.help">{{ ACTION_ICON.link }} {{ b.label }}</a>
        <button v-else-if="b.options.action !== 'link'" class="btn" :title="b.help" :disabled="b.options.action !== 'email' && !canWrite" @click="press(b)">{{ ACTION_ICON[b.options.action] }} {{ b.label }}</button>
      </template>
    </div>
    <div v-if="inputs.length" class="form-grid st-fields">
      <label v-for="f in inputs" :key="f.id" :class="{ full: f.kind === 'textarea', 'st-check': f.kind === 'checkbox' }">
        <template v-if="f.kind === 'checkbox'">
          <input type="checkbox" :checked="!!f.value" :disabled="!canWrite" @change="f.value = $event.target.checked; save(f)"> {{ f.label }}<span v-if="saved === f.id" class="st-saved">✓</span>
          <small v-if="f.help" class="muted">{{ f.help }}</small>
        </template>
        <template v-else>
          <span>{{ f.label }}<span v-if="f.kind === 'number' && f.options.unit" class="muted"> ({{ f.options.unit }})</span><span v-if="saved === f.id" class="st-saved">✓ enregistré</span></span>
          <input v-if="f.kind === 'text'" v-model="f.value" maxlength="500" :placeholder="f.options.placeholder" :disabled="!canWrite" @change="save(f)">
          <textarea v-else-if="f.kind === 'textarea'" v-model="f.value" rows="3" :placeholder="f.options.placeholder" :disabled="!canWrite" @change="save(f)"></textarea>
          <input v-else-if="f.kind === 'number'" v-model="f.value" type="text" inputmode="decimal" class="right" :disabled="!canWrite" @change="save(f)">
          <input v-else-if="f.kind === 'date'" v-model="f.value" type="date" :disabled="!canWrite" @change="save(f)">
          <select v-else-if="f.kind === 'select'" v-model="f.value" :disabled="!canWrite" @change="save(f)"><option :value="null">—</option><option v-for="c in f.options.choices" :key="c" :value="c">{{ c }}</option></select>
          <small v-if="f.help" class="muted">{{ f.help }}</small>
        </template>
      </label>
    </div>
    <div v-for="f in zones" :key="f.id" class="st-zone" @dragover.prevent @drop.prevent="drop(f, $event)">
      <div class="st-zone-head">
        <div><b>📎 {{ f.label }}</b><div v-if="f.help" class="muted small">{{ f.help }}</div></div>
        <button v-if="canWrite" class="btn sm" :disabled="busy === f.id" @click="pick(f)">{{ busy === f.id ? 'Envoi…' : f.options.accept === 'any' ? '+ Ajouter un fichier' : '+ Ajouter un PDF' }}</button>
      </div>
      <div v-for="a in f.files" :key="a.id" class="st-file">
        <a :href="'/api/attachment/' + a.id" target="_blank" rel="noopener">{{ a.mime === 'application/pdf' ? '📄' : '🖼️' }} {{ a.filename }}</a>
        <span class="muted small">{{ fileSize(a.size) }} · {{ date(a.created_at.slice(0, 10)) }}</span>
        <button v-if="canWrite" class="icon-btn" title="Retirer ce fichier" @click="removeFile(a)">✕</button>
      </div>
      <div v-if="!f.files.length" class="muted small">Aucun fichier.<template v-if="canWrite"> Glissez un {{ f.options.accept === 'any' ? 'fichier' : 'PDF' }} ici, ou utilisez le bouton.</template></div>
    </div>
    <input ref="picker" type="file" multiple hidden @change="chosen">
    <Modal v-if="design" :title="'Personnaliser la fiche « ' + data.target_label + ' »'" wide @close="closeDesign">
      <p class="muted small" style="margin-top:0">Ce que vous ajoutez ici apparaît sur toutes les fiches de ce type, dans le bloc « Informations complémentaires ».</p>
      <StudioDesigner :target="data.target"/>
      <template #foot><button class="btn primary" @click="closeDesign">Terminé</button></template>
    </Modal>
  </div>`,
};

// ---------- Onglet « Personnalisation » des paramètres ----------
export const StudioPanel = {
  components: { StudioDesigner },
  setup() {
    const meta = ref(null);
    const target = ref('order');
    const load = async () => { meta.value = await GET('/studio/meta'); };
    onMounted(load);
    return { meta, target, load };
  },
  template: `
  <div class="card" v-if="meta">
    <div class="card-head"><h2>Personnalisation des fiches</h2><span class="small muted">comme « Studio » dans Odoo</span></div>
    <p class="muted" style="margin-top:0">Ajoutez vos propres zones de texte, zones de dépôt de PDF et boutons sur les fiches. Ils apparaissent dans le bloc « Informations complémentaires » de chaque fiche, où vous trouvez aussi le bouton « ⚙ Personnaliser ».</p>
    <div class="st-targets">
      <button v-for="t in meta.targets" :key="t.key" :class="{ on: target === t.key }" @click="target = t.key">{{ t.label }}<span v-if="t.count" class="badge b-blue">{{ t.count }}</span></button>
    </div>
    <StudioDesigner :target="target" @changed="load"/>
  </div>`,
};
