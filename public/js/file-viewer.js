// Afficheur de document dans la page, comme dans Odoo : l'original (PDF ou photo) à côté de la fiche, sur ordinateur,
// tablette et téléphone. Les PDF sont dessinés par PDF.js (fichiers locaux, dossier /pdfjs) : pas besoin du lecteur PDF
// du navigateur, qui n'existe pas sur téléphone. Si PDF.js ne peut pas démarrer (navigateur trop ancien), le lecteur
// du navigateur prend le relais ; un fichier illisible est signalé, avec le bouton « Ouvrir » de la fiche pour repli.
import { ref, computed, watch, onMounted, onBeforeUnmount, nextTick } from 'vue';

const BASE = '/pdfjs/';
let lib = null;
/** PDF.js n'est chargé qu'au premier PDF ouvert (il ne ralentit pas le démarrage du logiciel). */
const loadLib = () => (lib ||= import(BASE + 'pdf.min.mjs').then((m) => { m.GlobalWorkerOptions.workerSrc = BASE + 'pdf.worker.min.mjs'; return m; }).catch((e) => { lib = null; throw e; }));

const ZOOMS = [0.5, 0.75, 1, 1.25, 1.5, 2, 3];
const KEEP = 8;               // pages gardées dessinées autour de celle qu'on regarde (les autres sont libérées)
const MAX_PIXELS = 12_000_000; // taille maximale d'une page dessinée (au-delà, certains téléphones n'affichent rien)

export const FileViewer = {
  props: { src: String, mime: String, name: String },
  setup(props) {
    const box = ref(null);
    const mode = ref('none');   // 'pdf' | 'image' | 'native' (lecteur du navigateur) | 'none'
    const pages = ref([]);      // { n, w, h, done }
    const current = ref(1);
    const zoom = ref(1);        // 1 = toute la largeur
    const loading = ref(false);
    const note = ref('');
    const isPdf = computed(() => props.mime === 'application/pdf');
    const isImage = computed(() => /^image\/(jpeg|png|webp|gif)$/.test(props.mime || ''));

    // Objets de PDF.js : gardés hors de Vue (ils n'ont pas à être observés)
    let task = null, pdf = null, observer = null, resizer = null, token = 0, drawing = Promise.resolve(), redrawT = null, lastWidth = 0;
    const canvases = new Map();     // numéro de page → <canvas>
    const renders = new Map();      // numéro de page → dessin en cours
    const wanted = new Set();       // pages visibles (ou proches) à dessiner
    const setCanvas = (n, el) => { if (el) canvases.set(n, el); else canvases.delete(n); };
    const width = () => Math.max(120, (box.value?.clientWidth || 0) - 20); // largeur utile (marges de 10 px)

    const release = (p) => { const c = canvases.get(p.n); if (c) { c.width = 0; c.height = 0; } p.done = false; };
    async function draw(n, my) {
      const p = pages.value[n - 1];
      const canvas = canvases.get(n);
      if (!p || !canvas || !pdf || my !== token || p.done) return;
      const page = await pdf.getPage(n);
      if (my !== token) return;
      const base = page.getViewport({ scale: 1 });
      p.w = base.width; p.h = base.height; // la vraie forme de la page (la première sert de modèle en attendant)
      let scale = (width() * zoom.value / base.width) * Math.min(window.devicePixelRatio || 1, 2);
      const pixels = base.width * base.height * scale * scale;
      if (pixels > MAX_PIXELS) scale *= Math.sqrt(MAX_PIXELS / pixels);
      const viewport = page.getViewport({ scale });
      canvas.width = Math.floor(viewport.width); canvas.height = Math.floor(viewport.height);
      const r = page.render({ canvas, viewport });
      renders.set(n, r);
      try { await r.promise; if (my === token) p.done = true; } catch (e) { if (e?.name !== 'RenderingCancelledException') throw e; } finally { renders.delete(n); page.cleanup?.(); }
    }
    // Les pages sont dessinées une à la fois, les plus proches de celle qu'on regarde d'abord
    function schedule() {
      const my = token;
      drawing = drawing.then(async () => {
        while (my === token) {
          const next = [...wanted].filter((n) => !pages.value[n - 1]?.done).sort((a, b) => Math.abs(a - current.value) - Math.abs(b - current.value))[0];
          if (!next) break;
          try { await draw(next, my); } catch { wanted.delete(next); if (pages.value[next - 1]) pages.value[next - 1].failed = true; }
        }
        // mémoire : on ne garde dessinées que les pages autour de celle qu'on regarde
        if (my === token) for (const p of pages.value) if (p.done && !wanted.has(p.n) && Math.abs(p.n - current.value) > KEEP) release(p);
      });
    }
    const watchPages = () => {
      observer?.disconnect();
      observer = new IntersectionObserver((entries) => {
        for (const e of entries) { const n = Number(e.target.dataset.n); if (e.isIntersecting) wanted.add(n); else wanted.delete(n); }
        schedule();
      }, { root: box.value, rootMargin: '150% 0px' });
      for (const el of box.value?.querySelectorAll('.fv-page') || []) observer.observe(el);
    };
    // Largeur ou zoom changés : tout est redessiné à la bonne netteté
    const redraw = () => {
      if (mode.value !== 'pdf') return;
      token += 1;
      for (const r of renders.values()) r.cancel();
      for (const p of pages.value) release(p);
      schedule();
    };
    const stop = async () => {
      token += 1;
      clearTimeout(redrawT);
      observer?.disconnect(); observer = null;
      for (const r of renders.values()) r.cancel();
      renders.clear(); wanted.clear();
      const t = task; task = null; pdf = null;
      if (t) await t.destroy().catch(() => {});
    };

    async function open() {
      await stop();
      mode.value = 'none'; pages.value = []; current.value = 1; zoom.value = 1; note.value = ''; loading.value = false;
      if (!props.src) { mode.value = 'none'; return; }
      if (isImage.value) { mode.value = 'image'; return; }
      if (!isPdf.value) { mode.value = 'none'; return; }
      const my = token;
      loading.value = true;
      let pdfjs;
      try { pdfjs = await loadLib(); } catch { if (my === token) { mode.value = 'native'; loading.value = false; } return; }
      if (my !== token) return;
      try {
        task = pdfjs.getDocument({ url: props.src, withCredentials: true, standardFontDataUrl: BASE + 'standard_fonts/', wasmUrl: BASE + 'wasm/', iccUrl: BASE + 'iccs/', enableXfa: false });
        const doc = await task.promise;
        if (my !== token) return;
        pdf = doc;
        const first = (await doc.getPage(1)).getViewport({ scale: 1 });
        if (my !== token) return;
        pages.value = Array.from({ length: doc.numPages }, (_, i) => ({ n: i + 1, w: first.width, h: first.height, done: false, failed: false }));
        mode.value = 'pdf';
        loading.value = false;
        await nextTick();
        if (my !== token) return;
        lastWidth = width();
        watchPages();
      } catch (e) {
        if (my !== token) return;
        loading.value = false;
        mode.value = 'none';
        note.value = e?.name === 'PasswordException' ? 'Ce PDF est protégé par un mot de passe : utilisez « Ouvrir » pour le lire.'
          : /Invalid|Missing|Unexpected|Format/i.test(e?.name || '') ? 'Ce fichier ne peut pas être affiché ici (PDF abîmé ou incomplet). Essayez « Ouvrir » ou « Télécharger ».'
            : 'Le document n’a pas pu être chargé. Vérifiez la connexion, ou utilisez « Ouvrir ».';
      }
    }
    onMounted(() => {
      open();
      resizer = new ResizeObserver(() => {
        const w = width();
        if (Math.abs(w - lastWidth) < 8) return;
        lastWidth = w;
        clearTimeout(redrawT);
        redrawT = setTimeout(redraw, 200);
      });
      if (box.value) resizer.observe(box.value);
    });
    onBeforeUnmount(() => { resizer?.disconnect(); stop(); });
    watch(() => [props.src, props.mime], open);
    watch(zoom, () => { if (mode.value === 'pdf') nextTick(redraw); });

    const onScroll = () => {
      if (mode.value !== 'pdf' || !box.value) return;
      const mid = box.value.scrollTop + box.value.clientHeight / 2;
      let best = 1;
      for (const el of box.value.querySelectorAll('.fv-page')) { if (el.offsetTop <= mid) best = Number(el.dataset.n); else break; }
      current.value = best;
    };
    const step = (d) => { const i = ZOOMS.indexOf(zoom.value); const j = Math.min(ZOOMS.length - 1, Math.max(0, (i < 0 ? 2 : i) + d)); zoom.value = ZOOMS[j]; };
    const goPage = (d) => {
      const n = Math.min(pages.value.length, Math.max(1, current.value + d));
      const el = box.value?.querySelector(`.fv-page[data-n="${n}"]`);
      if (el) box.value.scrollTop = el.offsetTop - 10;
    };
    const pageStyle = (p) => ({ width: zoom.value * 100 + '%', aspectRatio: `${p.w} / ${p.h}` });
    const zoomLabel = computed(() => Math.round(zoom.value * 100) + ' %');
    return { box, mode, pages, current, zoom, loading, note, setCanvas, onScroll, step, goPage, pageStyle, zoomLabel, ZOOMS };
  },
  template: `
  <div class="fv">
    <div v-if="mode === 'pdf' || mode === 'image'" class="fv-bar">
      <span v-if="mode === 'pdf' && pages.length > 1" class="fv-nav">
        <button type="button" class="fv-btn" title="Page précédente" aria-label="Page précédente" :disabled="current <= 1" @click="goPage(-1)">‹</button>
        <span class="fv-count">Page {{ current }} / {{ pages.length }}</span>
        <button type="button" class="fv-btn" title="Page suivante" aria-label="Page suivante" :disabled="current >= pages.length" @click="goPage(1)">›</button>
      </span>
      <span v-else class="fv-count">{{ mode === 'pdf' ? '1 page' : 'Photo' }}</span>
      <span class="fv-zoom">
        <button type="button" class="fv-btn" title="Réduire" aria-label="Réduire" :disabled="zoom <= ZOOMS[0]" @click="step(-1)">−</button>
        <button type="button" class="fv-btn fv-fit" title="Ajuster à la largeur" aria-label="Ajuster à la largeur" @click="zoom = 1">{{ zoomLabel }}</button>
        <button type="button" class="fv-btn" title="Agrandir" aria-label="Agrandir" :disabled="zoom >= ZOOMS[ZOOMS.length - 1]" @click="step(1)">+</button>
      </span>
    </div>
    <div ref="box" class="fv-scroll" :class="'is-' + mode" tabindex="0" role="group" :aria-label="'Document original' + (name ? ' : ' + name : '')" @scroll.passive="onScroll">
      <template v-if="mode === 'pdf'">
        <div v-for="p in pages" :key="p.n" class="fv-page" :data-n="p.n" :style="pageStyle(p)">
          <canvas :ref="(el) => setCanvas(p.n, el)" :aria-label="'Page ' + p.n"></canvas>
          <span v-if="p.failed" class="fv-wait">Cette page n'a pas pu être affichée</span>
          <span v-else-if="!p.done" class="fv-wait"><span class="typing"><span></span><span></span><span></span></span></span>
        </div>
      </template>
      <img v-else-if="mode === 'image'" :src="src" :alt="name || 'Document'" :style="{ width: zoom * 100 + '%' }">
      <iframe v-else-if="mode === 'native'" :src="src" title="Document original"></iframe>
      <div v-else-if="loading" class="fv-none"><span class="typing"><span></span><span></span><span></span></span><div>Chargement du document…</div></div>
      <div v-else class="fv-none"><Icon name="file-text"/><div>{{ note || 'Pas d’aperçu pour ce format : utilisez « Ouvrir » ou « Télécharger »' }}</div></div>
    </div>
  </div>`,
};
