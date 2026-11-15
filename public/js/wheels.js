// Gardiennage des roues, côté bureau : la carte de la fiche véhicule (jeu été / jeu hiver) et la vue d'ensemble
// du Parc automobile (roues en gardiennage, pneus à remplacer).
import { ref, reactive, computed, watch, onMounted, onUnmounted } from 'vue';
import { GET, PUT, DEL, act, toast, date as fdate } from './api.js';
import { go, leaveGuards } from './router.js';
import { can } from './apps.js';
import { SEASONS, POSITIONS, replaceLabel, formOf, changes, shrinkPhoto, localToday } from './wheels-common.js';

async function sendPhoto(url, blob) {
  const r = await fetch('/api' + url, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': blob.type || 'image/jpeg' }, body: blob })
    .catch(() => { throw new Error('Pas de connexion au serveur du garage'); });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error || 'Envoi de la photo impossible');
  return d;
}
const QUOTE = { planned: 'à faire', done: 'fait', cancelled: 'annulé' };
const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : '');

export const WheelStorage = {
  props: { vehicleId: Number, tyreSize: String, customerId: Number },
  setup(props) {
    const w = ref(null);
    const f = reactive({ summer: formOf(null), winter: formOf(null) });
    const base = reactive({ summer: formOf(null), winter: formOf(null) });
    const busy = ref('');     // jeu en cours d'enregistrement
    const sending = ref('');  // « winter-fl » : photo en cours d'envoi
    const picker = ref(null);
    const canEdit = can('vehicules', 'user');
    const canQuote = can('ventes', 'user');
    let target = null;
    const reset = (k, d) => { Object.assign(f[k], formOf(d[k])); Object.assign(base[k], formOf(d[k])); };
    const load = async () => { const d = await GET('/wheels/vehicle/' + props.vehicleId); w.value = d; for (const s of SEASONS) reset(s.key, d); };
    onMounted(() => load().catch((e) => toast(e.message, 'error')));
    const diff = (k) => changes(f[k], base[k]);
    const dirty = (k) => Object.keys(diff(k)).length > 0;
    const save = async (k) => {
      if (busy.value || !dirty(k)) return;
      busy.value = k;
      try {
        const had = w.value[k].quote?.status === 'planned';
        const sent = { ...f[k] };
        const d = await act(() => PUT(`/wheels/vehicle/${props.vehicleId}/${k}`, diff(k)));
        // ce qui a été tapé pendant l'envoi reste à l'écran, à enregistrer : seuls les champs non touchés sont repris
        const fresh = formOf(d[k]);
        w.value = d; Object.assign(base[k], fresh);
        for (const key of Object.keys(fresh)) if (f[k][key] === sent[key]) f[k][key] = fresh[key];
        toast(!had && d[k].quote?.status === 'planned' ? 'Enregistré — un rappel « devis pneus à faire » est dans les activités' : 'Enregistré');
      } catch { /* message déjà affiché */ } finally { busy.value = ''; }
    };
    const pick = (k, p) => { if (sending.value) return; target = { k, p }; picker.value.click(); };
    const onFile = async (e) => {
      const file = e.target.files?.[0];
      e.target.value = '';
      if (!file || !target) return;
      const { k, p } = target;
      sending.value = `${k}-${p}`;
      try { w.value = await sendPhoto(`/wheels/vehicle/${props.vehicleId}/${k}/photo/${p}`, await shrinkPhoto(file)); } catch (err) { toast(err.message, 'error'); } finally { sending.value = ''; }
    };
    const removePhoto = async (k, p) => {
      if (!confirm('Retirer cette photo ?')) return;
      try { w.value = await act(() => DEL(`/wheels/vehicle/${props.vehicleId}/${k}/photo/${p}`)); } catch { /* message déjà affiché */ }
    };
    // Quitter la fiche avec une saisie non enregistrée : question, comme sur les autres fiches
    const leaveOk = () => !SEASONS.some((s) => dirty(s.key)) || confirm('La fiche des roues n’est pas enregistrée. Quitter quand même ?');
    onMounted(() => leaveGuards.add(leaveOk));
    onUnmounted(() => leaveGuards.delete(leaveOk));
    const src = (a) => '/api/attachment/' + a.id;
    const alt = (s, p) => `Roue ${p.label.toLowerCase()}, jeu ${s.label.toLowerCase()}`;
    const quoteUrl = (s) => {
      const x = w.value[s.key];
      const what = `Remplacement des pneus ${s.label.toLowerCase()} ${replaceLabel(x)}` + ([x.brand, x.size].filter(Boolean).length ? ` (${[x.brand, x.size].filter(Boolean).join(' ')})` : '');
      return `#/new/quote?customer_id=${props.customerId}&vehicle_id=${props.vehicleId}&complaint=${encodeURIComponent(what)}`;
    };
    const setToday = (k) => { f[k].stored_at = localToday(); };
    return { w, f, busy, sending, picker, canEdit, canQuote, dirty, save, pick, onFile, removePhoto, src, alt, quoteUrl, setToday, replaceLabel, fdate, SEASONS, POSITIONS, QUOTE };
  },
  template: `
  <div v-if="w" class="card wh-card">
    <div class="card-head"><h2><Icon name="circle-dot" class="ti"/> Gardiennage des roues</h2><a class="small" href="#/vehicles?view=wheels">Toutes les roues en gardiennage</a></div>
    <div class="wh-grid">
      <section v-for="s in SEASONS" :key="s.key" class="wh-set" :class="s.key">
        <div class="wh-head">
          <span class="wh-title"><Icon :name="s.icon" class="ti"/> Roues {{ s.label.toLowerCase() }}</span>
          <span v-if="w[s.key].stored_at" class="badge b-blue">Au garage depuis le {{ fdate(w[s.key].stored_at) }}</span>
          <span v-if="replaceLabel(w[s.key])" class="badge b-red">Pneus {{ replaceLabel(w[s.key]) }} à remplacer</span>
        </div>
        <div class="form-grid wh-form">
          <label>Marque des pneus<input v-model="f[s.key].brand" maxlength="80" :disabled="!canEdit" placeholder="Michelin, Continental…"></label>
          <label>Dimension<input v-model="f[s.key].size" maxlength="80" :disabled="!canEdit" :placeholder="tyreSize || '205/55 R16 91V'"></label>
          <label>Date du gardiennage<span class="wh-date"><input v-model="f[s.key].stored_at" type="date" :disabled="!canEdit"><button v-if="canEdit" type="button" class="btn sm" @click="setToday(s.key)">Aujourd'hui</button></span></label>
          <label>Emplacement<input v-model="f[s.key].location" maxlength="80" :disabled="!canEdit" placeholder="Rack, étagère…"></label>
          <div class="full wh-replace">
            <span>Pneus à remplacer pour la saison prochaine</span>
            <label class="check"><input v-model="f[s.key].replace_front" type="checkbox" :disabled="!canEdit"> Avant</label>
            <label class="check"><input v-model="f[s.key].replace_rear" type="checkbox" :disabled="!canEdit"> Arrière</label>
          </div>
          <label class="full">Remarque<textarea v-model="f[s.key].notes" maxlength="1000" rows="2" :disabled="!canEdit" placeholder="Usure, jantes, vis antivol…"></textarea></label>
        </div>
        <div class="wh-photos">
          <div v-for="p in POSITIONS" :key="p.key" class="wh-photo">
            <template v-if="w[s.key].photos[p.key]">
              <a :href="src(w[s.key].photos[p.key])" target="_blank" rel="noopener" title="Agrandir la photo"><img :src="src(w[s.key].photos[p.key])" :alt="alt(s, p)" loading="lazy"></a>
              <span v-if="canEdit" class="wh-tools">
                <button class="icon-btn" title="Remplacer la photo" aria-label="Remplacer la photo" :disabled="!!sending" @click="pick(s.key, p.key)"><Icon name="camera" class="ti"/></button>
                <button class="icon-btn" title="Retirer la photo" aria-label="Retirer la photo" :disabled="!!sending" @click="removePhoto(s.key, p.key)"><Icon name="trash-2" class="ti"/></button>
              </span>
              <div class="wh-cap">{{ p.label }}</div>
            </template>
            <button v-else type="button" class="wh-add" :disabled="!canEdit || !!sending" @click="pick(s.key, p.key)">
              <span v-if="sending === s.key + '-' + p.key" class="typing"><span></span><span></span><span></span></span><Icon v-else name="camera" class="ti"/>
              <b>{{ p.label }}</b><small v-if="canEdit">{{ sending === s.key + '-' + p.key ? 'Envoi…' : 'Ajouter une photo' }}</small><small v-else>Pas de photo</small>
            </button>
          </div>
        </div>
        <div class="wh-foot">
          <span v-if="w[s.key].quote" class="muted small"><Icon name="bell" class="ti"/> Rappel « devis à faire » : {{ QUOTE[w[s.key].quote.status] || w[s.key].quote.status }}</span>
          <span v-else-if="w[s.key].checked_at" class="muted small">Dernière saisie : {{ w[s.key].checked_by_name || '—' }}, le {{ fdate(w[s.key].checked_at) }}</span>
          <span v-else class="muted small">Pas encore rempli</span>
          <span class="btns">
            <a v-if="replaceLabel(w[s.key]) && customerId && canQuote" class="btn sm" :href="quoteUrl(s)">+ Devis pneus</a>
            <button v-if="canEdit" class="btn primary sm" :disabled="!dirty(s.key) || !!busy" @click="save(s.key)">Enregistrer</button>
          </span>
        </div>
      </section>
    </div>
    <input ref="picker" class="wh-picker" type="file" accept="image/*" hidden @change="onFile">
  </div>`,
};

/** Vue d'ensemble : toutes les roues en gardiennage, et les pneus à remplacer (pour préparer les devis de la saison). */
export const WheelList = {
  setup() {
    const rows = ref([]);
    const filter = ref('all');
    const q = ref('');
    const load = async () => { rows.value = await GET('/wheels' + (filter.value === 'all' ? '' : '?filter=' + filter.value)); };
    onMounted(() => load().catch((e) => toast(e.message, 'error')));
    watch(filter, () => load().catch(() => {}));
    const fold = (v) => String(v ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
    const shown = computed(() => {
      const words = fold(q.value).split(/\s+/).filter(Boolean);
      return rows.value.filter((r) => { const hay = fold([r.plate, String(r.plate || '').replace(/\s/g, ''), r.customer_name, r.make, r.model, r.brand, r.size, r.location].join(' ')); return words.every((x) => hay.includes(x)); });
    });
    const FILTERS = [['all', 'Toutes'], ['stored', 'En gardiennage'], ['replace', 'Pneus à remplacer']];
    return { rows, shown, filter, q, FILTERS, go, fdate, replaceLabel, cap };
  },
  template: `
  <div class="card wh-list">
    <div class="toolbar">
      <div class="seg"><button v-for="x in FILTERS" :key="x[0]" :class="{ on: filter === x[0] }" @click="filter = x[0]">{{ x[1] }}</button></div>
      <input v-model="q" type="search" placeholder="Plaque, client, marque, emplacement…" aria-label="Chercher dans les roues">
      <span class="muted" style="margin-left:auto">{{ shown.length }} jeu{{ shown.length > 1 ? 'x' : '' }} de roues</span>
    </div>
    <div class="table-wrap"><table>
      <thead><tr><th>Plaque</th><th>Véhicule</th><th>Client</th><th>Jeu</th><th>Pneus</th><th>À remplacer</th><th>En gardiennage depuis</th><th>Emplacement</th><th class="num">Photos</th></tr></thead>
      <tbody><tr v-for="r in shown" :key="r.id" class="click" @click="go('/vehicle/' + r.vehicle_id)">
        <td><span class="plate">{{ r.plate || '—' }}</span></td>
        <td><span class="brand-line"><BrandLogo :make="r.make" :size="26"/><span>{{ r.make }} {{ r.model }}</span></span></td>
        <td>{{ r.customer_name }}</td>
        <td><span class="wh-season"><Icon :name="r.season === 'winter' ? 'snowflake' : 'sun'" class="ti"/> {{ r.season === 'winter' ? 'Hiver' : 'Été' }}</span></td>
        <td>{{ r.brand }} <span class="muted small">{{ r.size }}</span></td>
        <td><span v-if="replaceLabel(r)" class="badge b-red">{{ cap(replaceLabel(r)) }}</span> <span v-if="replaceLabel(r) && r.quote_status === 'planned'" class="badge b-orange">Devis à faire</span><span v-else-if="replaceLabel(r) && r.quote_status === 'done'" class="badge b-green">Devis fait</span></td>
        <td>{{ fdate(r.stored_at) }}</td>
        <td>{{ r.location }}</td>
        <td class="num">{{ r.photo_count || '' }}</td>
      </tr></tbody>
    </table></div>
    <Empty v-if="!shown.length" icon="circle-dot" :text="rows.length ? 'Aucun jeu de roues ne correspond à cette recherche' : 'Aucune roue enregistrée — la fiche se remplit depuis un véhicule, ou par le mécanicien sur la tablette de l’atelier'"/>
  </div>`,
};
