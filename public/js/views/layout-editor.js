// Paramètres → Mise en page des documents : modèle, logo, couleurs, police, textes, avec aperçu en direct.
import { ref, computed, onMounted, onUnmounted, nextTick } from 'vue';
import { DEL, act, toast, store, DOC_TYPES } from '../api.js';
import { DocPrint, LAYOUT_TEMPLATES, LAYOUT_FONTS, LAYOUT_PALETTES, sampleDocument } from '../doc-print.js';

const PAGE_PX = { A4: [794, 1123], Letter: [816, 1056] };
const toHex = (r, g, b) => '#' + [r, g, b].map((v) => Math.round(v).toString(16).padStart(2, '0')).join('');

// Couleurs dominantes du logo (comme Odoo) : teinte la plus présente → couleur principale
function colorsFromImage(img) {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(img, 0, 0, 64, 64);
  const px = ctx.getImageData(0, 0, 64, 64).data;
  const buckets = new Map();
  const darks = [];
  for (let i = 0; i < px.length; i += 4) {
    const [r, g, b, a] = [px[i], px[i + 1], px[i + 2], px[i + 3]];
    if (a < 200) continue;
    const max = Math.max(r, g, b) / 255, min = Math.min(r, g, b) / 255, l = (max + min) / 2;
    const sat = max === min ? 0 : (max - min) / (1 - Math.abs(2 * l - 1));
    if (l < 0.3 && l > 0.03) darks.push([r, g, b]);
    if (sat < 0.3 || l > 0.9 || l < 0.12) continue;
    let h;
    if (max * 255 === r) h = ((g - b) / 255 / (max - min)) % 6; else if (max * 255 === g) h = (b - r) / 255 / (max - min) + 2; else h = (r - g) / 255 / (max - min) + 4;
    const k = Math.round(((h * 60 + 360) % 360) / 24);
    const e = buckets.get(k) || { n: 0, r: 0, g: 0, b: 0 };
    e.n++; e.r += r; e.g += g; e.b += b;
    buckets.set(k, e);
  }
  const sorted = [...buckets.values()].sort((a, b) => b.n - a.n);
  if (!sorted.length) return null;
  const avg = (e) => toHex(e.r / e.n, e.g / e.n, e.b / e.n);
  const primary = avg(sorted[0]);
  let secondary;
  if (sorted[1] && sorted[1].n > sorted[0].n * 0.25) secondary = avg(sorted[1]);
  else if (darks.length > 40) secondary = toHex(...[0, 1, 2].map((j) => darks.reduce((s, d) => s + d[j], 0) / darks.length));
  else secondary = toHex(...[0, 1, 2].map((j) => sorted[0][['r', 'g', 'b'][j]] / sorted[0].n * 0.3));
  return { primary, secondary };
}

export const LayoutEditor = {
  components: { DocPrint },
  props: { s: Object },
  setup(props) {
    const L = computed(() => props.s.layout);
    const previewType = ref('invoice');
    const sample = computed(() => {
      const d = sampleDocument(previewType.value === 'paid' ? 'invoice' : previewType.value);
      if (previewType.value === 'paid') d.status = 'paid';
      return d;
    });
    const thumbDoc = sampleDocument('invoice');
    const page = computed(() => PAGE_PX[L.value.paper] || PAGE_PX.A4);
    const paper = ref(null);
    const paperInner = ref(null);
    const grid = ref(null);
    const scale = ref(0.6);
    const paperH = ref(700);
    const thumbScale = ref(0.15);
    let ro;
    const measure = () => {
      if (paper.value) scale.value = paper.value.clientWidth / page.value[0];
      if (paperInner.value) paperH.value = paperInner.value.offsetHeight * scale.value;
      const t = grid.value?.querySelector('.tpl-thumb');
      if (t) thumbScale.value = t.clientWidth / page.value[0];
    };
    onMounted(() => {
      ro = new ResizeObserver(measure);
      [paper.value, paperInner.value, grid.value].forEach((el) => el && ro.observe(el));
      nextTick(measure);
    });
    onUnmounted(() => ro?.disconnect());

    // Logo
    const fileInput = ref(null);
    const over = ref(false);
    const uploading = ref(false);
    const logoUrl = computed(() => (L.value.logo_version ? '/logo?v=' + L.value.logo_version : null));
    const upload = async (file) => {
      if (!file) return;
      if (!/^image\/(png|jpeg|webp)$/.test(file.type)) return toast('Choisissez une image PNG, JPEG ou WebP (le PNG transparent est idéal)', 'error');
      uploading.value = true;
      try {
        const res = await fetch('/api/settings/logo', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/octet-stream' }, body: file });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Envoi impossible');
        L.value.logo_version = data.logo_version;
        store.settings.layout = { ...store.settings.layout, logo_version: data.logo_version };
        toast('Logo enregistré');
        await applyLogoColors(true);
      } catch (e) { toast(e.message, 'error'); } finally { uploading.value = false; }
    };
    const onDrop = (e) => { over.value = false; upload(e.dataTransfer.files[0]); };
    const removeLogo = async () => {
      if (!confirm('Retirer le logo des documents ?')) return;
      const r = await act(() => DEL('/settings/logo'), 'Logo retiré');
      L.value.logo_version = r.logo_version;
      store.settings.layout = { ...store.settings.layout, logo_version: null };
    };
    const applyLogoColors = (quiet) => new Promise((resolve) => {
      if (!logoUrl.value) { toast('Ajoutez d\'abord votre logo', 'error'); return resolve(); }
      const img = new Image();
      img.onload = () => {
        const c = colorsFromImage(img);
        if (c) { L.value.primary = c.primary; L.value.secondary = c.secondary; toast(quiet ? 'Couleurs reprises de votre logo 🎨 (pensez à enregistrer)' : 'Couleurs reprises de votre logo 🎨'); }
        else if (!quiet) toast('Le logo n\'a pas de couleur marquée : choisissez une palette', 'error');
        resolve();
      };
      img.onerror = resolve;
      img.src = logoUrl.value;
    });
    const setColor = (k, v) => { if (/^#[0-9a-f]{6}$/i.test(v)) L.value[k] = v.toLowerCase(); };
    const TOGGLES = [['show_logo', 'Logo'], ['show_vehicle', 'Bloc véhicule (plaque, VIN, km)'], ['show_qr', 'QR code de paiement'], ['show_bank', 'Coordonnées bancaires'],
      ['show_discount', 'Colonne remise'], ['show_signature', 'Signature « bon pour accord »'], ['show_paid_stamp', 'Tampon « PAYÉE »']];
    const PREVIEWS = [['invoice', 'Facture'], ['paid', 'Facture payée'], ['quote', 'Devis'], ['order', 'OR'], ['credit_note', 'Avoir']];
    return { L, previewType, sample, thumbDoc, page, paper, paperInner, grid, scale, paperH, thumbScale, fileInput, over, uploading, logoUrl, upload, onDrop, removeLogo,
      applyLogoColors, setColor, TOGGLES, PREVIEWS, LAYOUT_TEMPLATES, LAYOUT_FONTS, LAYOUT_PALETTES, DOC_TYPES };
  },
  template: `
  <div class="layout-editor">
    <div class="card">
      <div class="le-section">
        <h3>Modèle</h3>
        <div class="tpl-grid" ref="grid">
          <button v-for="t in LAYOUT_TEMPLATES" :key="t.id" class="tpl" :class="{ on: L.template === t.id }" @click="L.template = t.id">
            <div class="tpl-thumb"><div class="ip-doc-wrap" :style="{ transform: 'scale(' + thumbScale + ')', transformOrigin: '0 0', position: 'absolute', top: 0, left: 0 }"><DocPrint :doc="thumbDoc" :layout="{ ...L, template: t.id, terms: '' }" :company="s.company" :footer="s.invoice_footer" preview/></div></div>
            <b>{{ t.name }}</b><small>{{ t.desc }}</small>
          </button>
        </div>
      </div>

      <div class="le-section">
        <h3>Logo</h3>
        <div class="logo-drop" :class="{ over }" @click="fileInput.click()" @dragover.prevent="over = true" @dragleave="over = false" @drop.prevent="onDrop">
          <div class="logo-box"><img v-if="logoUrl" :src="logoUrl" alt="Logo"><span v-else>Aucun logo</span></div>
          <div class="small"><b>{{ uploading ? 'Envoi…' : logoUrl ? 'Changer le logo' : 'Ajouter votre logo' }}</b><br><span class="muted">Glissez l'image ici ou cliquez. PNG transparent idéal, JPEG ou WebP, 3 Mo max.</span></div>
          <input ref="fileInput" type="file" accept="image/png,image/jpeg,image/webp" hidden @change="upload($event.target.files[0]); $event.target.value = ''">
        </div>
        <div class="btns" style="margin-top:10px;align-items:center">
          <span class="muted small">Taille :</span>
          <div class="seg"><button v-for="[k, l] in [['s','Petit'],['m','Moyen'],['l','Grand']]" :class="{ on: L.logo_size === k }" @click="L.logo_size = k">{{ l }}</button></div>
          <button v-if="logoUrl" class="btn sm danger" @click="removeLogo">Retirer</button>
        </div>
      </div>

      <div class="le-section">
        <h3>Couleurs</h3>
        <div class="colors">
          <div class="color-field"><input type="color" :value="L.primary" @input="L.primary = $event.target.value"><div><small>Principale</small><input type="text" :value="L.primary" @change="setColor('primary', $event.target.value)"></div></div>
          <div class="color-field"><input type="color" :value="L.secondary" @input="L.secondary = $event.target.value"><div><small>Secondaire</small><input type="text" :value="L.secondary" @change="setColor('secondary', $event.target.value)"></div></div>
        </div>
        <div class="palettes">
          <button v-for="p in LAYOUT_PALETTES" class="palette" :title="p.join(' / ')" @click="L.primary = p[0]; L.secondary = p[1]"><span :style="{ background: p[0] }"></span><span :style="{ background: p[1] }"></span></button>
          <button class="btn sm" :disabled="!logoUrl" @click="applyLogoColors(false)">🎨 Couleurs du logo</button>
        </div>
      </div>

      <div class="le-section">
        <h3>Police et papier</h3>
        <div class="form-grid">
          <label>Police<select v-model="L.font"><option v-for="f in LAYOUT_FONTS" :value="f.id">{{ f.name }}</option></select></label>
          <label>Format<select v-model="L.paper"><option value="A4">A4 (Europe)</option><option value="Letter">Letter (US)</option></select></label>
        </div>
      </div>

      <div class="le-section">
        <h3>Textes</h3>
        <div class="form-grid">
          <label class="full">Slogan (sous le logo)<input v-model="L.tagline" maxlength="120" placeholder="Ex. : Votre garage de confiance depuis 1998"></label>
          <label class="full">Mention en haut des documents<textarea v-model="L.header_note" rows="2" maxlength="300" placeholder="Ex. : Nouveau ! Service climatisation et pneus toutes marques."></textarea></label>
          <label class="full">Pied de page<textarea v-model="s.invoice_footer" rows="2"></textarea></label>
          <label class="full">Conditions générales (page 2 des factures et devis)<textarea v-model="L.terms" rows="5" maxlength="6000" placeholder="Ex. : 1. Paiement à 15 jours. 2. Pénalités de retard… 3. Droit de rétention du véhicule…"></textarea></label>
        </div>
      </div>

      <div class="le-section" style="margin-bottom:0">
        <h3>Afficher</h3>
        <div class="toggles"><label v-for="[k, l] in TOGGLES" class="check"><input type="checkbox" v-model="L[k]"> {{ l }}</label></div>
        <p class="muted small" style="margin:10px 0 0">Les coordonnées (adresse, TVA, RCS, IBAN…) viennent de l'onglet « Société ».</p>
      </div>
    </div>

    <div class="le-preview">
      <div class="le-preview-bar">
        <div class="seg"><button v-for="[k, l] in PREVIEWS" :class="{ on: previewType === k }" @click="previewType = k">{{ l }}</button></div>
        <span class="muted small">Aperçu en direct · exemple</span>
      </div>
      <div class="le-paper" ref="paper" :style="{ height: paperH + 'px' }">
        <div ref="paperInner" :style="{ transform: 'scale(' + scale + ')', transformOrigin: '0 0', position: 'absolute', top: 0, left: 0, width: page[0] + 'px' }">
          <DocPrint :doc="sample" :layout="L" :company="s.company" :footer="s.invoice_footer" preview/>
        </div>
      </div>
    </div>
  </div>`,
};
