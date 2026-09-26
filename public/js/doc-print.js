// Document imprimable (devis, OR, facture, avoir) selon la mise en page choisie dans les paramètres.
// Utilisé pour l'impression / PDF et pour l'aperçu en direct des paramètres (avec un document d'exemple).
import { computed, watchEffect, onUnmounted } from 'vue';
import { money, date, DOC_TYPES, store } from './api.js';

export const LAYOUT_TEMPLATES = [
  { id: 'moderne', name: 'Moderne', desc: 'Épuré, titre en couleur' },
  { id: 'encadre', name: 'Encadré', desc: 'Blocs et tableau bordés' },
  { id: 'audacieux', name: 'Audacieux', desc: 'Grand bandeau couleur' },
  { id: 'raye', name: 'Rayé', desc: 'Lignes alternées, liseré' },
  { id: 'classique', name: 'Classique', desc: 'Centré, traditionnel' },
  { id: 'atelier', name: 'Atelier', desc: 'Véhicule mis en avant' },
];
export const LAYOUT_FONTS = [
  { id: 'inter', name: 'Inter (moderne)', css: "'Inter', Arial, sans-serif" },
  { id: 'grotesk', name: 'Space Grotesk (technique)', css: "'Space Grotesk', 'Inter', Arial, sans-serif" },
  { id: 'arial', name: 'Arial / Helvetica (neutre)', css: 'Arial, Helvetica, sans-serif' },
  { id: 'georgia', name: 'Georgia (classique)', css: "Georgia, 'Times New Roman', serif" },
  { id: 'palatino', name: 'Palatino (élégante)', css: "'Palatino Linotype', 'Book Antiqua', Palatino, serif" },
];
export const LAYOUT_PALETTES = [
  ['#2563eb', '#0f172a'], ['#0891b2', '#083344'], ['#16a34a', '#14532d'], ['#dc2626', '#1f2937'],
  ['#ea580c', '#431407'], ['#7c3aed', '#1e1b4b'], ['#db2777', '#3b0764'], ['#111827', '#6b7280'], ['#b45309', '#1c1917'],
];

// Document d'exemple pour l'aperçu (comme les exemples d'Odoo)
export function sampleDocument(type = 'invoice') {
  return {
    id: null, type, status: type === 'invoice' ? 'posted' : 'draft',
    number: { invoice: 'F2026-0042', quote: 'D2026-0107', order: 'OR2026-0213', credit_note: 'NC2026-0003' }[type],
    date: new Date().toISOString().slice(0, 10), due_date: new Date(Date.now() + 15 * 864e5).toISOString().slice(0, 10),
    customer_name: 'Jean Muller', customer_company: '', customer_address: '12, rue de la Gare', customer_zip: 'L-1611', customer_city: 'Luxembourg', customer_vat: '',
    plate: 'AB 1234', make: 'Volkswagen', model: 'Golf VII 1.6 TDI', vin: 'WVWZZZAUZHW123456', mileage: 128450,
    customer_complaint: type === 'order' ? 'Bruit au freinage à l\'avant, entretien annuel' : '',
    diagnosis: type === 'order' ? 'Plaquettes AV usées à 90 %, disques à la cote mini' : '',
    notes: type === 'quote' ? 'Devis valable 30 jours. Pièces d\'origine ou équivalentes.' : '',
    lines: [
      { kind: 'text', description: 'Entretien annuel', quantity: 0, unit_price: 0, discount: 0, tax_rate: 17 },
      { kind: 'part', description: 'Huile moteur 5W30 Castrol Edge (L)', quantity: 4.5, unit_price: 14.9, discount: 0, tax_rate: 17 },
      { kind: 'part', description: 'Filtre à huile Mann HU7008z', quantity: 1, unit_price: 12.4, discount: 0, tax_rate: 17 },
      { kind: 'part', description: 'Plaquettes de frein AV Brembo P85020', quantity: 1, unit_price: 64, discount: 10, tax_rate: 17 },
      { kind: 'part', description: 'Disques de frein AV Brembo (paire)', quantity: 1, unit_price: 118, discount: 10, tax_rate: 17 },
      { kind: 'labor', description: 'Main-d\'œuvre', quantity: 2.5, unit_price: 85, discount: 0, tax_rate: 17, unit: 'h' },
    ],
    amount_paid: 0, done: true,
  };
}

const lineTotal = (l) => (l.kind === 'text' ? 0 : Math.round((l.quantity || 0) * (l.unit_price || 0) * (1 - (l.discount || 0) / 100) * 100) / 100);
const TITLES = { order: 'Ordre de réparation' };
const PAPER = { A4: ['210mm', '297mm'], Letter: ['216mm', '279mm'] };

export const DocPrint = {
  props: { doc: Object, layout: Object, company: Object, footer: String, preview: Boolean },
  setup(props) {
    const L = computed(() => ({ ...(store.settings?.layout || {}), ...(props.layout || {}) }));
    const C = computed(() => props.company || store.settings?.company || {});
    const footerText = computed(() => props.footer ?? store.settings?.invoice_footer ?? '');
    const font = computed(() => (LAYOUT_FONTS.find((f) => f.id === L.value.font) || LAYOUT_FONTS[0]).css);
    const paper = computed(() => PAPER[L.value.paper] || PAPER.A4);
    const vars = computed(() => ({ '--p': L.value.primary || '#2563eb', '--s': L.value.secondary || '#0f172a', '--font': font.value, '--pw': paper.value[0], '--ph': paper.value[1] }));
    const totals = computed(() => {
      const byRate = {};
      let sub = 0;
      for (const l of props.doc?.lines || []) { if (l.kind === 'text') continue; const t = lineTotal(l); sub += t; byRate[l.tax_rate] = (byRate[l.tax_rate] || 0) + t; }
      const taxes = Object.entries(byRate).map(([rate, base]) => ({ rate, base, amount: Math.round(base * rate) / 100 }));
      const tax = taxes.reduce((a, t) => a + t.amount, 0);
      return { sub, taxes, total: Math.round((sub + tax) * 100) / 100 };
    });
    const hasDiscount = computed(() => L.value.show_discount !== false && (props.doc?.lines || []).some((l) => l.discount));
    const validity = computed(() => store.settings?.options?.ventes?.quote_validity_days || 30);
    const title = computed(() => TITLES[props.doc?.type] || DOC_TYPES[props.doc?.type] || 'Document');
    const showLogo = computed(() => L.value.show_logo !== false && L.value.logo_version);
    const logoUrl = computed(() => '/logo?v=' + L.value.logo_version);
    const paid = computed(() => L.value.show_paid_stamp !== false && props.doc?.type === 'invoice' && props.doc?.status === 'paid');
    const showQr = computed(() => L.value.show_qr !== false && props.doc?.type === 'invoice' && props.doc?.status !== 'paid' && C.value.iban);
    const qrUrl = computed(() => (props.doc?.id ? `/api/documents/${props.doc.id}/qr.svg` : '/api/qr.svg?text=' + encodeURIComponent(`BCD\n002\n1\nSCT\n${C.value.bic || ''}\n${C.value.name || ''}\n${C.value.iban || ''}\nEUR${totals.value.total.toFixed(2)}\n\n\n${props.doc?.number || ''}`)));
    const companyLine = computed(() => [C.value.name && `${C.value.name}${C.value.legal_form ? ' ' + C.value.legal_form : ''}`, C.value.rcs && `RCS ${C.value.rcs}`, C.value.vat_number && C.value.vat_number !== 'LU' && `TVA ${C.value.vat_number}`, C.value.matricule && `Matricule ${C.value.matricule}`, C.value.autorisation && `Autorisation n° ${C.value.autorisation}`].filter(Boolean).join(' · '));
    const vehicle = computed(() => L.value.show_vehicle !== false && props.doc?.plate);

    // Format du papier à l'impression (seulement pour le vrai document, pas pour les aperçus)
    let styleEl = null;
    if (!props.preview) {
      styleEl = document.createElement('style');
      document.head.appendChild(styleEl);
      watchEffect(() => { styleEl.textContent = `@page { size: ${L.value.paper === 'Letter' ? 'letter' : 'A4'}; margin: 0; }`; });
      onUnmounted(() => styleEl.remove());
    }
    return { L, C, footerText, vars, totals, hasDiscount, validity, title, showLogo, logoUrl, paid, showQr, qrUrl, companyLine, vehicle, lineTotal, money, date };
  },
  template: `
  <div class="ip-doc">
    <div class="ip" :class="['ip-' + (L.template || 'moderne'), 'ip-logo-' + (L.logo_size || 'm')]" :style="vars">
      <div class="ip-band"></div>
      <header class="ip-header">
        <div class="ip-brand">
          <img v-if="showLogo" :src="logoUrl" class="ip-logo" alt="">
          <div v-else class="ip-name">{{ C.name }}</div>
          <div v-if="L.tagline" class="ip-tagline">{{ L.tagline }}</div>
        </div>
        <div class="ip-company">
          <b v-if="showLogo">{{ C.name }}</b>
          <div v-if="C.address">{{ C.address }}</div>
          <div v-if="C.zip || C.city">{{ C.zip }} {{ C.city }}<template v-if="C.country && C.country !== 'Luxembourg'"> · {{ C.country }}</template></div>
          <div v-if="C.phone">Tél. {{ C.phone }}</div>
          <div v-if="C.email">{{ C.email }}</div>
          <div v-if="C.website">{{ C.website }}</div>
          <div v-if="C.vat_number && C.vat_number !== 'LU'">TVA {{ C.vat_number }}</div>
        </div>
      </header>
      <div v-if="L.header_note" class="ip-note">{{ L.header_note }}</div>

      <section class="ip-parties">
        <div class="ip-meta">
          <div class="ip-doctype">{{ title }}</div>
          <div class="ip-number">{{ doc.number || 'Brouillon' }}</div>
          <dl>
            <dt>Date</dt><dd>{{ date(doc.date) }}</dd>
            <template v-if="doc.due_date && doc.type === 'invoice'"><dt>Échéance</dt><dd>{{ date(doc.due_date) }}</dd></template>
            <template v-if="doc.type === 'quote'"><dt>Validité</dt><dd>{{ validity }} jours</dd></template>
          </dl>
        </div>
        <div class="ip-client">
          <small>{{ doc.type === 'quote' ? 'Devis pour' : doc.type === 'order' ? 'Client' : 'Facturé à' }}</small>
          <b>{{ doc.customer_company || doc.customer_name }}</b>
          <div v-if="doc.customer_company">{{ doc.customer_name }}</div>
          <div v-if="doc.customer_address">{{ doc.customer_address }}</div>
          <div>{{ doc.customer_zip }} {{ doc.customer_city }}</div>
          <div v-if="doc.customer_vat">TVA : {{ doc.customer_vat }}</div>
        </div>
      </section>

      <section v-if="vehicle" class="ip-vehicle">
        <span class="ip-plate">{{ doc.plate }}</span>
        <div><b>{{ doc.make }} {{ doc.model }}</b><div class="ip-sub"><span v-if="doc.vin">VIN {{ doc.vin }}</span><span v-if="doc.mileage"> · {{ Number(doc.mileage).toLocaleString('fr-LU') }} km</span></div></div>
      </section>
      <p v-if="doc.customer_complaint" class="ip-text"><b>Demande du client :</b> {{ doc.customer_complaint }}</p>
      <p v-if="doc.type === 'order' && doc.diagnosis" class="ip-text"><b>Diagnostic :</b> {{ doc.diagnosis }}</p>

      <table class="ip-lines">
        <thead><tr><th>Désignation</th><th class="n">Qté</th><th class="n">P.U. HT</th><th v-if="hasDiscount" class="n">Rem.</th><th class="n">TVA</th><th class="n">Total HT</th><th v-if="doc.type === 'order'" class="n">Fait</th></tr></thead>
        <tbody>
          <tr v-for="(l, i) in doc.lines" :key="i" :class="{ section: l.kind === 'text' }">
            <td v-if="l.kind === 'text'" :colspan="hasDiscount ? 6 : 5">{{ l.description }}</td>
            <template v-else>
              <td>{{ l.description }}</td><td class="n">{{ l.quantity }}<small v-if="l.unit"> {{ l.unit }}</small></td><td class="n">{{ money(l.unit_price) }}</td>
              <td v-if="hasDiscount" class="n">{{ l.discount ? l.discount + ' %' : '' }}</td><td class="n">{{ l.tax_rate }} %</td><td class="n">{{ money(lineTotal(l)) }}</td>
            </template>
            <td v-if="doc.type === 'order'" class="n">{{ l.kind === 'text' ? '' : l.done ? '✓' : '☐' }}</td>
          </tr>
        </tbody>
      </table>

      <section class="ip-bottom">
        <div class="ip-pay">
          <p v-if="doc.notes" class="ip-notes">{{ doc.notes }}</p>
          <div v-if="showQr" class="ip-qr">
            <img :src="qrUrl" alt="QR de paiement">
            <div><b>Payer avec votre appli bancaire</b><br>Scannez ce code : montant et communication sont déjà remplis.<br>
              <span v-if="L.show_bank !== false">IBAN {{ C.iban }}<template v-if="C.bic"> · BIC {{ C.bic }}</template><br></span>Communication : {{ doc.number }}</div>
          </div>
          <div v-else-if="L.show_bank !== false && C.iban && doc.type === 'invoice' && doc.status !== 'paid'" class="ip-bank">Paiement : IBAN {{ C.iban }}<template v-if="C.bic"> · BIC {{ C.bic }}</template> · Communication : {{ doc.number }}</div>
        </div>
        <div class="ip-totals">
          <div><span>Total HT</span><span>{{ money(totals.sub) }}</span></div>
          <div v-for="t in totals.taxes" :key="t.rate"><span>TVA {{ t.rate }} % <small>sur {{ money(t.base) }}</small></span><span>{{ money(t.amount) }}</span></div>
          <div class="grand"><span>Total TTC</span><span>{{ money(totals.total) }}</span></div>
          <div v-if="doc.type === 'invoice' && doc.amount_paid > 0 && doc.status !== 'paid'" class="due"><span>Reste à payer</span><span>{{ money(totals.total - doc.amount_paid) }}</span></div>
        </div>
      </section>

      <section v-if="L.show_signature !== false && (doc.type === 'quote' || doc.type === 'order')" class="ip-sign">
        <div>Bon pour accord — signature du client</div><div>Date</div>
      </section>
      <div v-if="paid" class="ip-stamp">PAYÉE</div>

      <footer class="ip-footer">
        <div v-if="footerText" class="ip-footer-text">{{ footerText }}</div>
        <div>{{ companyLine }}</div>
        <div v-if="L.show_bank !== false && C.iban">{{ C.bank_name }} · IBAN {{ C.iban }}<template v-if="C.bic"> · BIC {{ C.bic }}</template></div>
      </footer>
    </div>
    <div v-if="L.terms && (doc.type === 'invoice' || doc.type === 'quote')" class="ip ip-terms-page" :class="'ip-' + (L.template || 'moderne')" :style="vars">
      <h3>Conditions générales</h3>
      <div class="ip-terms">{{ L.terms }}</div>
    </div>
  </div>`,
};
