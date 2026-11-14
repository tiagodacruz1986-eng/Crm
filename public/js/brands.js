// Logo de la marque d'un véhicule : <BrandLogo make="Volkswagen" :size="28"/>
// L'image vient des logos enregistrés dans le logiciel (repris d'Odoo ou ajoutés par le garage) ; sans image,
// une pastille neutre avec les premières lettres de la marque. Module sans dépendance : il sert aussi à la tablette.
import { reactive, h } from 'vue';

const state = reactive({ aliases: {}, logos: {}, ready: false });
let loading = null;
/** Charge (une fois) la liste des logos ; force = recharger après un ajout ou un import. */
export function loadBrands(force = false) {
  if (loading && !force) return loading;
  loading = fetch('/brands.json', { cache: 'no-cache' }).then((r) => (r.ok ? r.json() : null)).then((d) => {
    if (d) { state.aliases = d.aliases || {}; state.logos = d.logos || {}; }
    state.ready = true;
  }).catch(() => { state.ready = true; });
  return loading;
}

/** « Mercedes-Benz », « MERCEDES » → « mercedes » (même règle que le serveur). */
export function brandSlug(make) {
  const s = String(make ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');
  return state.aliases[s] || s;
}
/** Lettres affichées quand la marque n'a pas de logo : « BMW », « LR » (Land Rover), « Vo » (Volvo). */
export function brandInitials(make) {
  const name = String(make ?? '').trim();
  if (!name) return '';
  if (name.length <= 3) return name.toUpperCase();
  const words = name.split(/[\s\-/]+/).filter(Boolean);
  if (words.length > 1) return words.slice(0, 3).map((w) => w[0].toUpperCase()).join('');
  return name[0].toUpperCase() + name[1].toLowerCase();
}
export const brandLogoUrl = (make) => { const slug = brandSlug(make); const l = slug && state.logos[slug]; return l ? '/brand/' + slug + '?v=' + l.v : null; };

export const BrandLogo = {
  props: { make: String, size: { type: [Number, String], default: 28 } },
  setup(props) {
    loadBrands();
    return () => {
      const make = String(props.make ?? '').trim();
      if (!make) return null;
      const px = Number(props.size) || 28;
      const url = brandLogoUrl(make);
      const box = { width: px + 'px', height: px + 'px' };
      if (url) return h('span', { class: 'make-logo', style: box, title: make }, [h('img', { src: url, alt: make, loading: 'lazy' })]);
      const txt = brandInitials(make);
      // trois lettres (« BMW ») : un peu plus petit pour tenir sur une ligne
      return h('span', { class: 'make-logo mono', style: { ...box, fontSize: Math.max(8, Math.round(px * (txt.length >= 3 ? 0.3 : 0.38))) + 'px' }, title: make, 'aria-label': make }, txt);
    };
  },
};
