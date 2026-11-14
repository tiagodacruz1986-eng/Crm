// Fenêtre « Logos des marques » (Parc automobile) : reprendre les logos d'Odoo, ajouter ou remplacer une image, la retirer.
import { ref, computed, onMounted } from 'vue';
import { GET, POST, DEL, act, toast, store } from './api.js';
import { loadBrands, BrandLogo } from './brands.js';

async function sendLogo(name, file) {
  const r = await fetch('/api/brands/logo?name=' + encodeURIComponent(name), { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': file.type || 'application/octet-stream' }, body: file });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error || 'Envoi impossible');
  return d;
}

export const BrandManager = {
  emits: ['close'],
  components: { BrandLogo },
  setup() {
    const rows = ref([]);
    const odoo = ref(false);
    const busy = ref(false);
    const other = ref('');
    const picker = ref(null);
    let target = '';
    const admin = computed(() => store.user?.role === 'admin');
    const load = async () => { const r = await GET('/brands'); rows.value = r.brands; odoo.value = r.odoo; await loadBrands(true); };
    onMounted(load);
    const pick = (name) => { target = String(name || '').trim(); if (!target) { toast('Indiquez d’abord le nom de la marque', 'error'); return; } picker.value.click(); };
    const chosen = async (e) => {
      const file = e.target.files[0]; e.target.value = '';
      if (!file || !target) return;
      try { await sendLogo(target, file); toast('Logo enregistré pour ' + target); other.value = ''; } catch (err) { toast(err.message, 'error'); }
      await load();
    };
    const remove = async (b) => { if (!confirm('Retirer le logo de ' + b.name + ' ?')) return; await act(() => DEL('/brands/' + b.slug), 'Logo retiré'); await load(); };
    const fromOdoo = async () => {
      if (busy.value) return;
      busy.value = true;
      try {
        const r = await act(() => POST('/brands/import-odoo'));
        toast(r.imported ? r.imported + ' logo(s) repris d’Odoo' + (r.kept ? ' — ' + r.kept + ' logo(s) ajoutés par vous ont été gardés' : '') : 'Aucun nouveau logo trouvé dans Odoo', r.imported ? 'ok' : 'error');
      } catch { /* le message d'erreur est déjà affiché */ } finally { busy.value = false; await load(); }
    };
    const sourceLabel = (b) => (!b.logo ? 'pas de logo' : b.source === 'odoo' ? 'repris d’Odoo' : 'ajouté par vous');
    return { rows, odoo, busy, other, picker, admin, pick, chosen, remove, fromOdoo, sourceLabel };
  },
  template: `
  <Modal title="Logos des marques" wide @close="$emit('close')">
    <p class="muted small" style="margin-top:0">Le logo de la marque s'affiche dans le parc automobile, sur les ordres de réparation, dans l'atelier et sur la tablette. Les logos sont ceux de votre Odoo, ou des images que vous ajoutez (PNG, JPEG ou WebP, 1 Mo au plus).</p>
    <div class="btns" v-if="admin">
      <button v-if="odoo" class="btn primary" :disabled="busy" @click="fromOdoo"><Icon name="download" class="ti"/> {{ busy ? 'Reprise en cours…' : 'Reprendre les logos d’Odoo' }}</button>
      <span v-else class="muted small">Pour reprendre vos logos d'Odoo en un clic : renseignez d'abord la connexion dans <a href="#/settings?tab=odoo" @click="$emit('close')">Paramètres → Import Odoo</a>.</span>
    </div>
    <div class="brand-list">
      <div v-for="b in rows" :key="b.slug" class="brand-row">
        <BrandLogo :make="b.name" :size="40"/>
        <div class="brand-row-txt"><b>{{ b.name }}</b><div class="muted small">{{ b.vehicles }} véhicule(s) · {{ sourceLabel(b) }}</div></div>
        <button class="btn sm" @click="pick(b.name)">{{ b.logo ? 'Remplacer…' : 'Ajouter un logo…' }}</button>
        <button v-if="b.logo" class="icon-btn" title="Retirer ce logo" aria-label="Retirer ce logo" @click="remove(b)"><Icon name="trash-2" class="ti"/></button>
      </div>
      <p v-if="!rows.length" class="muted small">Aucun véhicule enregistré pour l'instant : les marques apparaîtront ici.</p>
    </div>
    <div class="brand-add">
      <label>Autre marque<input v-model="other" maxlength="60" placeholder="Ex. : Cupra" @keydown.enter="pick(other)"></label>
      <button class="btn" :disabled="!other.trim()" @click="pick(other)">Ajouter un logo…</button>
    </div>
    <input ref="picker" type="file" accept="image/png,image/jpeg,image/webp" hidden @change="chosen">
    <template #foot><button class="btn primary" @click="$emit('close')">Terminé</button></template>
  </Modal>`,
};
