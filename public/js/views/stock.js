import { ref, computed, onMounted } from 'vue';
import { GET, POST, PUT, DEL, act, money, num, date, datetime, today, TAX_RATES } from '../api.js';
import { route, go } from '../router.js';
import { PaymentModal } from './documents.js';

const PRODUCT_FIELDS = ['ref', 'ean', 'name', 'category', 'brand', 'supplier_id', 'purchase_price', 'sale_price', 'tax_rate', 'qty_min', 'location', 'unit', 'is_service', 'labor_hours', 'active'];
const MOVE_KIND = { purchase: 'Réception', sale: 'Vente', adjust: 'Inventaire', return: 'Retour' };

export const ProductList = {
  setup() {
    const rows = ref([]);
    const q = ref('');
    const low = ref(!!route.query.low);
    const tab = ref('items');
    const moves = ref([]);
    const valuation = ref({});
    const load = async () => {
      rows.value = await GET(`/products?q=${encodeURIComponent(q.value)}${low.value ? '&low=1' : ''}`);
      valuation.value = await GET('/stock/valuation');
    };
    const loadMoves = async () => { moves.value = await GET('/stock/moves'); };
    onMounted(load);
    const reorder = async () => {
      const r = await act(() => POST('/stock/reorder'));
      if (!r.created.length) return act(async () => { throw new Error('Aucun article sous le seuil avec un fournisseur défini'); });
      go(r.created.length === 1 ? '/purchase/' + r.created[0] : '/purchases');
    };
    return { rows, q, low, load, tab, moves, loadMoves, valuation, reorder, go, money, num, datetime, MOVE_KIND };
  },
  template: `
  <div>
    <div class="page-head">
      <div><h1>Articles & stock</h1><div class="sub">Valeur du stock : {{ money(valuation.purchase_value) }} (prix d'achat) · {{ valuation.items || 0 }} références en stock</div></div>
      <div class="btns"><ModuleTools module="stock"/><button class="btn" @click="reorder">🔄 Commander le stock bas</button><button class="btn primary" @click="go('/product/new')">+ Nouvel article</button></div>
    </div>
    <div class="tabs"><button :class="{active: tab==='items'}" @click="tab='items'">Articles</button><button :class="{active: tab==='moves'}" @click="tab='moves'; loadMoves()">Mouvements de stock</button></div>
    <div class="card" v-if="tab==='items'">
      <div class="toolbar"><input v-model="q" @input="load" placeholder="Référence, EAN, nom, marque…"><label class="check"><input type="checkbox" v-model="low" @change="load"> Stock bas uniquement</label><span class="muted" style="margin-left:auto">{{ rows.length }} articles</span></div>
      <div class="table-wrap"><table>
        <thead><tr><th>Réf.</th><th>Désignation</th><th>Marque</th><th>Emplacement</th><th class="num">Stock</th><th class="num">Min.</th><th class="num">Achat HT</th><th class="num">Vente HT</th><th class="num">Marge</th></tr></thead>
        <tbody><tr v-for="p in rows" class="click" @click="go('/product/' + p.id)">
          <td><b>{{ p.ref }}</b></td><td>{{ p.name }} <span v-if="p.is_service" class="badge b-purple">forfait</span></td><td>{{ p.brand }}</td><td>{{ p.location }}</td>
          <td class="num" :class="{neg: !p.is_service && p.qty_min > 0 && p.qty_on_hand <= p.qty_min}">{{ p.is_service ? '' : num(p.qty_on_hand) }}</td><td class="num">{{ p.is_service ? '' : num(p.qty_min) }}</td>
          <td class="num">{{ money(p.purchase_price) }}</td><td class="num">{{ money(p.sale_price) }}</td>
          <td class="num">{{ p.sale_price ? Math.round(100 * (p.sale_price - p.purchase_price) / p.sale_price) + ' %' : '' }}</td>
        </tr></tbody>
      </table></div>
      <Empty v-if="!rows.length" icon="📦" text="Aucun article"/>
    </div>
    <div class="card" v-else>
      <div class="table-wrap"><table>
        <thead><tr><th>Date</th><th>Article</th><th>Type</th><th>Pièce</th><th class="num">Quantité</th><th class="num">Coût unit.</th></tr></thead>
        <tbody><tr v-for="m in moves"><td>{{ datetime(m.date) }}</td><td>{{ m.ref }} {{ m.name }}</td><td>{{ MOVE_KIND[m.kind] || m.kind }}</td><td>{{ m.doc_number || m.purchase_number || m.note }}</td>
          <td class="num" :class="m.qty > 0 ? 'pos' : 'neg'">{{ m.qty > 0 ? '+' : '' }}{{ num(m.qty) }}</td><td class="num">{{ money(m.unit_cost) }}</td></tr></tbody>
      </table></div>
    </div>
  </div>`,
};

export const ProductDetail = {
  setup() {
    const isNew = route.params.id === 'new';
    const p = ref(null);
    const suppliers = ref([]);
    const adj = ref(null);
    const load = async () => { p.value = isNew ? { tax_rate: 17, unit: 'pce', active: 1, is_service: 0, qty_min: 0, purchase_price: 0, sale_price: 0, moves: [] } : await GET('/products/' + route.params.id); };
    onMounted(async () => { suppliers.value = await GET('/suppliers'); load(); });
    const save = async () => {
      const data = Object.fromEntries(PRODUCT_FIELDS.map((k) => [k, p.value[k]]));
      if (isNew) { const r = await act(() => POST('/products', data), 'Article créé'); go('/product/' + r.id); } else { await act(() => PUT('/products/' + p.value.id, data), 'Enregistré'); load(); }
    };
    const adjust = async () => { await act(() => POST(`/products/${p.value.id}/adjust`, adj.value), 'Stock corrigé'); adj.value = null; load(); };
    const remove = async () => { if (!confirm('Supprimer cet article ?')) return; await act(() => DEL('/products/' + p.value.id)); go('/stock'); };
    const coef = (c) => { p.value.sale_price = Math.round(p.value.purchase_price * c * 100) / 100; };
    return { p, isNew, suppliers, save, adj, adjust, remove, coef, money, num, datetime, MOVE_KIND, TAX_RATES };
  },
  template: `
  <div v-if="p">
    <div class="page-head">
      <h1>{{ isNew ? 'Nouvel article' : (p.ref ? p.ref + ' — ' : '') + p.name }}</h1>
      <div class="btns" v-if="!isNew"><button class="btn" v-if="!p.is_service" @click="adj = {qty: p.qty_on_hand, note: 'Inventaire'}">📋 Inventaire</button><button class="btn danger" @click="remove">🗑</button></div>
    </div>
    <div class="grid g2">
      <div class="card">
        <div class="form-grid">
          <label>Référence<input v-model="p.ref"></label><label>EAN / code-barres<input v-model="p.ean"></label>
          <label class="full">Désignation *<input v-model="p.name"></label>
          <label>Catégorie<input v-model="p.category" placeholder="Filtres, freinage, pneus…"></label><label>Marque<input v-model="p.brand"></label>
          <label>Fournisseur<select v-model="p.supplier_id"><option :value="null">—</option><option v-for="s in suppliers" :value="s.id">{{ s.name }}</option></select></label>
          <label>Emplacement<input v-model="p.location" placeholder="Étagère A3"></label>
          <label>Prix d'achat HT<input v-model.number="p.purchase_price" type="number" step="0.01"></label>
          <label>Prix de vente HT<input v-model.number="p.sale_price" type="number" step="0.01"></label>
          <div class="full btns small"><span class="muted">Coefficient :</span><button class="btn sm" v-for="c in [1.3, 1.5, 1.8, 2]" @click="coef(c)">×{{ c }}</button>
            <span class="muted" v-if="p.sale_price">Marge {{ Math.round(100 * (p.sale_price - p.purchase_price) / p.sale_price) }} % · TTC {{ money(p.sale_price * (1 + p.tax_rate / 100)) }}</span></div>
          <label>TVA<select v-model.number="p.tax_rate"><option v-for="r in TAX_RATES" :value="r">{{ r }} %</option></select></label>
          <label>Unité<input v-model="p.unit"></label>
          <label>Stock minimum<input v-model.number="p.qty_min" type="number"></label>
          <label class="check full"><input type="checkbox" :checked="!!p.is_service" @change="p.is_service = $event.target.checked ? 1 : 0"> Forfait / prestation (pas de stock)</label>
          <label v-if="p.is_service">Temps M.O. inclus (h)<input v-model.number="p.labor_hours" type="number" step="0.1"></label>
          <label class="check full"><input type="checkbox" :checked="!!p.active" @change="p.active = $event.target.checked ? 1 : 0"> Actif</label>
        </div>
        <button class="btn primary" style="margin-top:12px" :disabled="!p.name" @click="save">Enregistrer</button>
      </div>
      <div class="card" v-if="!isNew && !p.is_service">
        <div class="grid g2" style="margin-bottom:12px"><div class="kpi"><div class="l">En stock</div><div class="v">{{ num(p.qty_on_hand) }} {{ p.unit }}</div></div><div class="kpi"><div class="l">Valeur</div><div class="v">{{ money(p.qty_on_hand * p.purchase_price) }}</div></div></div>
        <h2>Mouvements</h2>
        <div v-for="m in p.moves" class="list-item small"><span>{{ datetime(m.date) }} · {{ MOVE_KIND[m.kind] }} {{ m.doc_number || m.purchase_number || m.note }}</span><b :class="m.qty > 0 ? 'pos' : 'neg'">{{ m.qty > 0 ? '+' : '' }}{{ num(m.qty) }}</b></div>
      </div>
    </div>
    <Chatter v-if="!isNew" model="product" :record-id="p.id" style="margin-top:16px"/>
    <Modal v-if="adj" title="Inventaire / correction de stock" @close="adj = null">
      <label>Quantité réellement en stock<input v-model.number="adj.qty" type="number" step="0.01"></label>
      <label>Motif<input v-model="adj.note"></label>
      <template #foot><button class="btn primary" @click="adjust">Valider</button></template>
    </Modal>
  </div>`,
};

export const PurchaseList = {
  setup() {
    const rows = ref([]);
    onMounted(async () => { rows.value = await GET('/purchases'); });
    return { rows, go, money, date };
  },
  template: `
  <div>
    <div class="page-head"><div><h1>Achats</h1><div class="sub">Commandes fournisseurs, réceptions et factures d'achat (pièces et frais généraux)</div></div><div class="btns"><ModuleTools module="achats"/><button class="btn primary" @click="go('/purchase/new')">+ Nouvel achat</button></div></div>
    <div class="card">
      <div class="table-wrap"><table>
        <thead><tr><th>N°</th><th>Date</th><th>Fournisseur</th><th>Réf. facture</th><th>Statut</th><th class="num">Total TTC</th><th class="num">Reste à payer</th></tr></thead>
        <tbody><tr v-for="p in rows" class="click" @click="go('/purchase/' + p.id)">
          <td><b>{{ p.number }}</b></td><td>{{ date(p.date) }}</td><td>{{ p.supplier_name }}</td><td>{{ p.supplier_ref }}</td><td><Badge :status="p.status"/></td>
          <td class="num">{{ money(p.total) }}</td><td class="num">{{ p.posted && p.status !== 'paid' ? money(p.total - p.amount_paid) : '' }}</td>
        </tr></tbody>
      </table></div>
      <Empty v-if="!rows.length" icon="🛒" text="Aucun achat"/>
    </div>
  </div>`,
};

export const PurchaseEditor = {
  components: { PaymentModal },
  setup() {
    const isNew = route.params.id === 'new';
    const p = ref(null);
    const suppliers = ref([]);
    const accounts = ref([]);
    const showPay = ref(false);
    const load = async () => { p.value = isNew ? { date: today(), status: 'draft', lines: [], payments: [] } : await GET('/purchases/' + route.params.id); };
    onMounted(async () => {
      suppliers.value = await GET('/suppliers');
      accounts.value = (await GET('/accounting/accounts')).filter((a) => a.type === 'expense' || a.code.startsWith('2') || a.code.startsWith('3'));
      load();
    });
    const lineTotal = (l) => Math.round((l.quantity || 0) * (l.unit_price || 0) * 100) / 100;
    const totals = computed(() => {
      const sub = (p.value?.lines || []).reduce((s, l) => s + lineTotal(l), 0);
      const tax = (p.value?.lines || []).reduce((s, l) => s + lineTotal(l) * (l.tax_rate || 0) / 100, 0);
      return { sub, tax: Math.round(tax * 100) / 100, total: Math.round((sub + tax) * 100) / 100 };
    });
    const addLine = () => p.value.lines.push({ description: '', quantity: 1, unit_price: 0, tax_rate: 17, product_id: null, account_code: null });
    const pickProduct = (l, x) => { if (x) Object.assign(l, { product_id: x.id, description: `${x.ref ? x.ref + ' — ' : ''}${x.name}`, unit_price: x.purchase_price, tax_rate: x.tax_rate }); };
    const save = async () => {
      if (isNew) { const r = await act(() => POST('/purchases', p.value), 'Enregistré'); go('/purchase/' + r.id); return r.id; }
      await act(() => PUT('/purchases/' + p.value.id, p.value), 'Enregistré'); await load(); return p.value.id;
    };
    const action = async (a, msg) => { const id = p.value.posted ? p.value.id : await save(); await act(() => POST(`/purchases/${id}/${a}`), msg); await load(); };
    const pay = async (x) => { await act(() => POST(`/purchases/${p.value.id}/payments`, x), 'Paiement enregistré'); showPay.value = false; load(); };
    const remove = async () => { if (!confirm('Supprimer cet achat ?')) return; await act(() => DEL('/purchases/' + p.value.id)); go('/purchases'); };
    return { p, isNew, suppliers, accounts, totals, lineTotal, addLine, pickProduct, save, action, pay, remove, showPay, money, date, TAX_RATES };
  },
  template: `
  <div v-if="p">
    <div class="page-head">
      <h1>Achat {{ p.number || '(nouveau)' }} <Badge v-if="!isNew" :status="p.status"/></h1>
      <div class="btns">
        <button class="btn" v-if="!p.posted" @click="save">💾 Enregistrer</button>
        <button class="btn" v-if="!isNew && p.status==='draft'" @click="action('order', 'Marqué commandé')">📤 Commandé</button>
        <button class="btn" v-if="!isNew && p.lines.some(l => l.product_id && l.received_qty < l.quantity)" @click="action('receive', 'Marchandise réceptionnée — stock mis à jour')">📥 Réceptionner</button>
        <button class="btn success" v-if="!isNew && !p.posted" @click="action('post', 'Facture fournisseur comptabilisée')">✔ Comptabiliser la facture</button>
        <button class="btn primary" v-if="p.posted && p.status !== 'paid'" @click="showPay = true">💶 Payer</button>
        <button class="btn danger" v-if="!isNew && !p.posted" @click="remove">🗑</button>
      </div>
    </div>
    <div class="card">
      <div class="form-grid">
        <label>Fournisseur<select v-model="p.supplier_id" :disabled="p.posted"><option :value="null">—</option><option v-for="s in suppliers" :value="s.id">{{ s.name }}</option></select></label>
        <label>Date<input v-model="p.date" type="date" :disabled="p.posted"></label>
        <label>N° facture fournisseur<input v-model="p.supplier_ref" :disabled="p.posted"></label>
        <label>Échéance<input v-model="p.due_date" type="date" :disabled="p.posted"></label>
      </div>
    </div>
    <div class="card">
      <div class="table-wrap"><table class="lines">
        <thead><tr><th>Article / description</th><th>Compte de charge</th><th class="q num">Qté</th><th class="p num">P.U. HT</th><th class="t">TVA</th><th class="num">Total HT</th><th class="num">Reçu</th><th></th></tr></thead>
        <tbody><tr v-for="(l, i) in p.lines">
          <td><Picker v-if="!p.posted && !l.description" endpoint="/products" :label="x => (x.ref ? x.ref + ' — ' : '') + x.name" placeholder="Article du stock (ou laisser vide)…" @pick="x => pickProduct(l, x)"/>
            <input v-else v-model="l.description" :disabled="p.posted"><button v-if="!p.posted && !l.description" class="btn sm" style="margin-top:4px" @click="l.description = 'Frais'">Saisie libre (frais généraux)</button></td>
          <td><select v-model="l.account_code" :disabled="p.posted"><option :value="null">Par défaut (achats)</option><option v-for="a in accounts" :value="a.code">{{ a.code }} {{ a.name }}</option></select></td>
          <td><input v-model.number="l.quantity" type="number" class="right" :disabled="p.posted"></td>
          <td><input v-model.number="l.unit_price" type="number" step="0.01" class="right" :disabled="p.posted"></td>
          <td><select v-model.number="l.tax_rate" :disabled="p.posted"><option v-for="r in TAX_RATES" :value="r">{{ r }}%</option></select></td>
          <td class="num">{{ money(lineTotal(l)) }}</td><td class="num">{{ l.product_id ? l.received_qty || 0 : '' }}</td>
          <td><button v-if="!p.posted" class="icon-btn" @click="p.lines.splice(i, 1)">✕</button></td>
        </tr></tbody>
      </table></div>
      <button v-if="!p.posted" class="btn sm" style="margin-top:10px" @click="addLine">+ Ligne</button>
      <div class="totals" style="max-width:320px;margin-left:auto;margin-top:12px">
        <span class="muted">Total HT</span><b class="num">{{ money(totals.sub) }}</b><span class="muted">TVA</span><span class="num">{{ money(totals.tax) }}</span>
        <span class="grand">Total TTC</span><span class="grand num">{{ money(totals.total) }}</span>
        <template v-if="p.amount_paid"><span class="muted">Payé</span><span class="num pos">{{ money(p.amount_paid) }}</span></template>
      </div>
    </div>
    <Chatter v-if="!isNew" model="purchase" :record-id="p.id"/>
    <PaymentModal v-if="showPay" :residual="Math.round((p.total - p.amount_paid) * 100) / 100" title="Paiement fournisseur" @close="showPay = false" @save="pay"/>
  </div>`,
};

export const SupplierList = {
  setup() {
    const rows = ref([]);
    const edit = ref(null);
    const accounts = ref([]);
    const load = async () => { rows.value = await GET('/suppliers'); };
    onMounted(async () => { load(); accounts.value = (await GET('/accounting/accounts')).filter((a) => a.type === 'expense'); });
    const save = async () => {
      const s = edit.value;
      if (s.id) await act(() => PUT('/suppliers/' + s.id, s), 'Enregistré'); else await act(() => POST('/suppliers', s), 'Fournisseur créé');
      edit.value = null; load();
    };
    const remove = async () => { await act(() => DEL('/suppliers/' + edit.value.id)); edit.value = null; load(); };
    const mailTo = ref(null);
    return { rows, edit, accounts, save, remove, money, mailTo };
  },
  template: `
  <div>
    <div class="page-head"><h1>Fournisseurs</h1><div class="btns"><ModuleTools module="achats"/><button class="btn primary" @click="edit = {country: 'LU', default_account: '6070'}">+ Nouveau fournisseur</button></div></div>
    <div class="card">
      <div class="table-wrap"><table>
        <thead><tr><th>Nom</th><th>Contact</th><th>IBAN</th><th>Compte</th><th class="num">À payer</th></tr></thead>
        <tbody><tr v-for="s in rows" class="click" @click="edit = {...s}"><td><b>{{ s.name }}</b></td><td>{{ s.phone }} <span class="muted small">{{ s.email }}</span></td><td class="small">{{ s.iban }}</td><td>{{ s.default_account }}</td><td class="num">{{ s.balance ? money(s.balance) : '' }}</td></tr></tbody>
      </table></div>
      <Empty v-if="!rows.length" icon="🏭" text="Aucun fournisseur"/>
    </div>
    <Modal v-if="edit" :title="edit.id ? edit.name : 'Nouveau fournisseur'" @close="edit = null" wide>
      <div class="form-grid">
        <label>Nom *<input v-model="edit.name"></label><label>N° TVA<input v-model="edit.vat_number"></label>
        <label>Téléphone<input v-model="edit.phone"></label><label>E-mail<input v-model="edit.email"></label>
        <label class="full">Adresse<input v-model="edit.address"></label><label>Code postal<input v-model="edit.zip"></label><label>Localité<input v-model="edit.city"></label>
        <label>IBAN<input v-model="edit.iban"></label><label>Site web / portail<input v-model="edit.website"></label>
        <label>Compte de charge par défaut<select v-model="edit.default_account"><option v-for="a in accounts" :value="a.code">{{ a.code }} {{ a.name }}</option></select></label>
        <label class="full">Notes<textarea v-model="edit.notes"></textarea></label>
      </div>
      <template #foot><button v-if="edit.id" class="btn danger" style="margin-right:auto" @click="remove">Supprimer</button><button v-if="edit.id" class="btn" @click="mailTo = edit.id">✉️ E-mail</button><button class="btn primary" :disabled="!edit.name" @click="save">Enregistrer</button></template>
    </Modal>
    <MailComposer v-if="mailTo" model="supplier" :record-id="mailTo" @close="mailTo = null"/>
  </div>`,
};
