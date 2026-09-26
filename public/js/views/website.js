// Site web (inspiré d'Odoo) : blocs à glisser, textes écrits par l'IA, aperçu en direct, publication en un clic.
import { ref, reactive, computed, onMounted, onUnmounted, watch, nextTick } from 'vue';
import { GET, PUT, POST, act, toast, store } from '../api.js';
import { can } from '../apps.js';

const ICON = { hero: '🏁', services: '🛠️', promo: '🎯', about: '🏡', reviews: '⭐', gallery: '🖼️', faq: '❓', hours: '🕘', contact: '✉️' };
const NEW = {
  hero: () => ({ title: 'Titre accrocheur', subtitle: 'Sous-titre', cta_label: 'Prendre rendez-vous', image: '' }),
  services: () => ({ title: 'Nos services', items: [{ icon: '🛠️', name: 'Service', text: 'Description', price: '' }] }),
  promo: () => ({ badge: 'Offre du moment', title: 'Votre offre', text: 'Détails de l\'offre' }),
  about: () => ({ title: 'À propos', text: 'Présentez votre garage…', image: '' }),
  reviews: () => ({ title: 'Avis clients', items: [{ name: 'Prénom', text: 'Avis', stars: 5 }] }),
  gallery: () => ({ title: 'Notre atelier', images: [] }),
  faq: () => ({ title: 'Questions fréquentes', items: [{ q: 'Question ?', a: 'Réponse.' }] }),
  hours: () => ({ title: 'Horaires & accès' }),
  contact: () => ({ title: 'Contact', text: 'Écrivez-nous, nous répondons vite.' }),
};

export const Website = {
  setup() {
    const cfg = ref(null);
    const types = ref({});
    const url = ref('');
    const sel = ref(null);
    const html = ref('');
    const saving = ref(false);
    const gen = reactive({ open: false, notes: '', tone: 'chaleureux et professionnel', busy: false });
    const device = ref('desktop');
    const addType = ref('');
    const manager = computed(() => can('site', 'manager'));
    const editor = computed(() => can('site', 'user'));
    let ready = false;

    const preview = async () => {
      const r = await fetch('/api/website/preview', { method: 'POST', credentials: 'same-origin' });
      html.value = await r.text();
    };
    const load = async () => {
      const r = await GET('/website');
      cfg.value = r.config; types.value = r.types; url.value = r.url;
      if (!sel.value && cfg.value.blocks[0]) sel.value = cfg.value.blocks[0].id;
      await preview();
      nextTick(() => { ready = true; });
    };
    onMounted(load);
    let t;
    const save = async (quiet = true) => {
      if (!editor.value) return;
      saving.value = true;
      try {
        const { published, ...rest } = cfg.value;
        await PUT('/website', rest); // pas de réaffectation : on ne perd pas ce qui est tapé pendant l'envoi
        await preview();
        if (!quiet) toast('Site enregistré');
      } catch (e) { toast(e.message, 'error'); } finally { saving.value = false; }
    };
    // Enregistrement automatique et aperçu mis à jour pendant la saisie
    watch(cfg, () => { if (!ready) return; clearTimeout(t); t = setTimeout(save, 700); }, { deep: true });
    onUnmounted(() => clearTimeout(t));

    const block = computed(() => cfg.value?.blocks.find((b) => b.id === sel.value));
    const move = (i, d) => { const b = cfg.value.blocks; const j = i + d; if (j < 0 || j >= b.length) return; [b[i], b[j]] = [b[j], b[i]]; };
    const remove = (i) => { if (!confirm('Supprimer ce bloc ?')) return; const [b] = cfg.value.blocks.splice(i, 1); if (b.id === sel.value) sel.value = cfg.value.blocks[0]?.id; };
    const add = () => {
      if (!addType.value) return;
      const b = { id: Math.random().toString(16).slice(2, 10), type: addType.value, ...NEW[addType.value]() };
      const i = cfg.value.blocks.findIndex((x) => x.type === 'contact');
      cfg.value.blocks.splice(i >= 0 ? i : cfg.value.blocks.length, 0, b);
      sel.value = b.id; addType.value = '';
    };
    const togglePublish = async () => {
      const next = !cfg.value.published;
      if (next && !confirm('Publier le site ? Il sera visible par tout le monde à l\'adresse indiquée.')) return;
      const r = await act(() => PUT('/website', { published: next }), next ? '🚀 Site publié !' : 'Site dépublié');
      ready = false; cfg.value = { ...cfg.value, published: r.published }; nextTick(() => { ready = true; });
      preview();
    };
    const upload = async (file, target, key) => {
      if (!file) return;
      if (!/^image\/(png|jpeg|webp)$/.test(file.type)) return toast('Image PNG, JPEG ou WebP', 'error');
      const res = await fetch('/api/website/images', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/octet-stream' }, body: file });
      const d = await res.json();
      if (!res.ok) return toast(d.error || 'Envoi impossible', 'error');
      if (Array.isArray(target[key])) target[key].push(d.url); else target[key] = d.url;
    };
    const generate = async () => {
      gen.busy = true;
      try {
        const r = await POST('/website/generate', { notes: gen.notes, tone: gen.tone });
        ready = false; cfg.value = r.config; nextTick(() => { ready = true; });
        await preview();
        gen.open = false;
        toast(r.ai ? '✨ Textes rédigés par l\'IA — relisez-les avant de publier' : 'Site de départ créé à partir de vos informations (ajoutez une clé IA pour des textes sur mesure)');
      } catch (e) { toast(e.message, 'error'); } finally { gen.busy = false; }
    };
    const copy = () => { navigator.clipboard?.writeText(url.value); toast('Adresse copiée'); };
    return { cfg, types, url, sel, block, html, saving, gen, device, addType, manager, editor, move, remove, add, togglePublish, upload, generate, save, copy, ICON, store };
  },
  template: `
  <div v-if="cfg" class="site-editor">
    <aside class="card site-side">
      <div class="site-status" :class="{ live: cfg.published }">
        <div><b>{{ cfg.published ? 'En ligne' : 'Brouillon' }}</b><small>{{ cfg.published ? url : 'Le site n\\'est pas encore visible' }}</small></div>
        <button v-if="manager" class="btn sm" :class="cfg.published ? '' : 'primary'" @click="togglePublish"><Icon :name="cfg.published ? 'eye-off' : 'rocket'"/> {{ cfg.published ? 'Dépublier' : 'Publier' }}</button>
      </div>
      <div class="btns" style="margin:10px 0 14px">
        <a v-if="cfg.published" class="btn sm" :href="url" target="_blank" rel="noopener"><Icon name="external-link"/> Ouvrir</a>
        <button v-if="cfg.published" class="btn sm" @click="copy"><Icon name="copy"/> Copier l'adresse</button>
        <button class="btn sm" @click="gen.open = true"><Icon name="wand-sparkles"/> Rédiger avec l'IA</button>
        <span class="muted small" v-if="saving">Enregistrement…</span>
      </div>

      <h3 class="sec-title">Blocs de la page</h3>
      <div class="block-list">
        <div v-for="(b, i) in cfg.blocks" :key="b.id" class="block-item" :class="{ on: sel === b.id, off: b.hidden }" @click="sel = b.id">
          <span class="bi-ico">{{ ICON[b.type] }}</span>
          <span class="bi-name"><b>{{ types[b.type] }}</b><small>{{ b.title }}</small></span>
          <span class="bi-acts" @click.stop>
            <button class="icon-btn" title="Monter" @click="move(i, -1)"><Icon name="arrow-up"/></button>
            <button class="icon-btn" title="Descendre" @click="move(i, 1)"><Icon name="arrow-down"/></button>
            <button class="icon-btn" :title="b.hidden ? 'Afficher' : 'Masquer'" @click="b.hidden = !b.hidden"><Icon :name="b.hidden ? 'eye-off' : 'eye'"/></button>
            <button class="icon-btn" title="Supprimer" @click="remove(i)"><Icon name="x"/></button>
          </span>
        </div>
      </div>
      <div class="btns" style="margin-top:8px"><select v-model="addType" style="flex:1"><option value="">+ Ajouter un bloc…</option><option v-for="(l, k) in types" :value="k">{{ ICON[k] }} {{ l }}</option></select><button class="btn sm" :disabled="!addType" @click="add">Ajouter</button></div>

      <template v-if="block">
        <h3 class="sec-title">{{ ICON[block.type] }} {{ types[block.type] }}</h3>
        <label>Titre<input v-model="block.title"></label>
        <label v-if="block.type === 'promo'">Étiquette<input v-model="block.badge"></label>
        <label v-if="block.type === 'hero'">Sous-titre<textarea v-model="block.subtitle" rows="3"></textarea></label>
        <label v-if="['about', 'promo', 'contact'].includes(block.type)">Texte<textarea v-model="block.text" rows="5"></textarea></label>
        <label v-if="block.type === 'hero'">Bouton<input v-model="block.cta_label"></label>
        <div v-if="['hero', 'about'].includes(block.type)" class="img-field">
          <div class="img-prev" :style="block.image ? { backgroundImage: 'url(' + block.image + ')' } : {}"></div>
          <label class="btn sm"><Icon name="image"/> {{ block.image ? 'Changer la photo' : 'Ajouter une photo' }}<input type="file" accept="image/png,image/jpeg,image/webp" hidden @change="upload($event.target.files[0], block, 'image'); $event.target.value = ''"></label>
          <button v-if="block.image" class="btn sm" @click="block.image = ''">Retirer</button>
        </div>
        <template v-if="block.type === 'services'">
          <div v-for="(it, j) in block.items" :key="j" class="sub-item">
            <div class="row3"><input v-model="it.icon" class="emoji-in" maxlength="8"><input v-model="it.name" placeholder="Service"><input v-model="it.price" placeholder="Prix (ex. dès 89 €)"></div>
            <textarea v-model="it.text" rows="2" placeholder="Description"></textarea>
            <button class="link small danger" @click="block.items.splice(j, 1)">Retirer</button>
          </div>
          <button class="btn sm" @click="block.items.push({ icon: '🔧', name: '', text: '', price: '' })">+ Service</button>
        </template>
        <template v-if="block.type === 'reviews'">
          <div v-for="(it, j) in block.items" :key="j" class="sub-item">
            <div class="row3"><input v-model="it.name" placeholder="Nom"><select v-model.number="it.stars"><option v-for="n in 5" :value="n">{{ '★'.repeat(n) }}</option></select></div>
            <textarea v-model="it.text" rows="2" placeholder="Avis (recopiez de vrais avis, par ex. Google)"></textarea>
            <button class="link small danger" @click="block.items.splice(j, 1)">Retirer</button>
          </div>
          <button class="btn sm" @click="block.items.push({ name: '', text: '', stars: 5 })">+ Avis</button>
        </template>
        <template v-if="block.type === 'faq'">
          <div v-for="(it, j) in block.items" :key="j" class="sub-item">
            <input v-model="it.q" placeholder="Question"><textarea v-model="it.a" rows="2" placeholder="Réponse"></textarea>
            <button class="link small danger" @click="block.items.splice(j, 1)">Retirer</button>
          </div>
          <button class="btn sm" @click="block.items.push({ q: '', a: '' })">+ Question</button>
        </template>
        <template v-if="block.type === 'gallery'">
          <div class="gal-grid"><div v-for="(u, j) in block.images" :key="u" class="img-prev" :style="{ backgroundImage: 'url(' + u + ')' }"><button class="icon-btn" @click="block.images.splice(j, 1)"><Icon name="x"/></button></div></div>
          <label class="btn sm"><Icon name="image"/> Ajouter une photo<input type="file" accept="image/png,image/jpeg,image/webp" hidden @change="upload($event.target.files[0], block, 'images'); $event.target.value = ''"></label>
        </template>
        <p v-if="block.type === 'hours'" class="muted small">Horaires et adresse repris automatiquement des Paramètres (Société, Atelier).</p>
        <p v-if="block.type === 'contact'" class="muted small">Chaque demande envoyée crée une opportunité dans le CRM et une activité « à rappeler ».</p>
      </template>

      <h3 class="sec-title">Apparence & référencement</h3>
      <div class="form-grid">
        <label>Thème<select v-model="cfg.theme"><option value="dark">Sombre</option><option value="light">Clair</option></select></label>
        <label>Couleur<div class="color-field"><input type="color" :value="cfg.accent || store.settings?.layout?.primary || '#2563eb'" @input="cfg.accent = $event.target.value"><button class="link small" @click="cfg.accent = ''">Couleur du logo</button></div></label>
        <label class="full">Titre Google<input v-model="cfg.seo_title" maxlength="70" placeholder="Garage … — entretien et réparation à …"></label>
        <label class="full">Description Google<textarea v-model="cfg.seo_description" maxlength="160" rows="2"></textarea></label>
      </div>
    </aside>

    <section class="site-preview">
      <div class="le-preview-bar"><div class="seg"><button :class="{ on: device === 'desktop' }" @click="device = 'desktop'">Ordinateur</button><button :class="{ on: device === 'mobile' }" @click="device = 'mobile'">Téléphone</button></div><span class="muted small">Aperçu en direct</span></div>
      <div class="site-frame" :class="device"><iframe :srcdoc="html" sandbox="allow-same-origin" title="Aperçu du site"></iframe></div>
    </section>

    <Modal v-if="gen.open" title="✨ Rédiger le site avec l'IA" @close="gen.open = false">
      <p class="muted" style="margin-top:0">L'IA écrit les textes (accroche, services, offre de saison, à propos, FAQ, référencement Google) à partir de vos informations. Vos photos et vos avis ne sont pas touchés.</p>
      <label>Vos consignes<textarea v-model="gen.notes" rows="4" placeholder="Ex. : spécialiste Volkswagen et Audi, véhicule de courtoisie gratuit, on parle français, portugais et luxembourgeois…"></textarea></label>
      <label>Ton<select v-model="gen.tone"><option>chaleureux et professionnel</option><option>premium et haut de gamme</option><option>dynamique et moderne</option><option>simple et familial</option></select></label>
      <template #foot><button class="btn" @click="gen.open = false">Annuler</button><button class="btn primary" :disabled="gen.busy" @click="generate">{{ gen.busy ? 'Rédaction en cours…' : 'Rédiger' }}</button></template>
    </Modal>
  </div>`,
};
