import { ref, onMounted } from 'vue';
import { GET, POST, PUT, act, store } from '../api.js';

const ROLE = { admin: 'Gérant (admin)', office: 'Bureau / accueil', mechanic: 'Mécanicien' };

export const Settings = {
  setup() {
    const s = ref(null);
    const users = ref([]);
    const accounts = ref([]);
    const tab = ref('company');
    const editUser = ref(null);
    const newAcc = ref(null);
    const load = async () => { s.value = await GET('/settings'); users.value = await GET('/users'); accounts.value = await GET('/accounting/accounts'); };
    onMounted(load);
    const save = async () => { store.settings = await act(() => PUT('/settings', s.value), 'Paramètres enregistrés'); store.company = store.settings.company.name; };
    const saveUser = async () => {
      const u = editUser.value;
      if (u.id) await act(() => PUT('/users/' + u.id, u), 'Utilisateur modifié'); else await act(() => POST('/users', u), 'Utilisateur créé');
      editUser.value = null; load();
    };
    const saveAcc = async () => { await act(() => POST('/accounting/accounts', newAcc.value), 'Compte enregistré'); newAcc.value = null; load(); };
    return { s, users, accounts, tab, save, editUser, saveUser, newAcc, saveAcc, ROLE, store };
  },
  template: `
  <div v-if="s">
    <div class="page-head"><h1>Paramètres</h1><button class="btn primary" v-if="['company','workshop','ai'].includes(tab)" @click="save">Enregistrer</button></div>
    <div class="tabs">
      <button v-for="[k, l] in [['company','Société'],['workshop','Atelier & factures'],['users','Utilisateurs & mécaniciens'],['accounts','Plan comptable'],['ai','Agents IA']]" :class="{active: tab===k}" @click="tab = k">{{ l }}</button>
    </div>
    <div class="card" v-if="tab==='company'">
      <div class="form-grid">
        <label>Nom commercial<input v-model="s.company.name"></label><label>Forme juridique<input v-model="s.company.legal_form"></label>
        <label class="full">Adresse<input v-model="s.company.address"></label><label>Code postal<input v-model="s.company.zip"></label><label>Localité<input v-model="s.company.city"></label><label>Pays<input v-model="s.company.country"></label>
        <label>Téléphone<input v-model="s.company.phone"></label><label>E-mail<input v-model="s.company.email"></label><label>Site web<input v-model="s.company.website"></label>
        <label>N° TVA<input v-model="s.company.vat_number"></label><label>RCS<input v-model="s.company.rcs" placeholder="B123456"></label><label>Matricule<input v-model="s.company.matricule"></label><label>Autorisation d'établissement<input v-model="s.company.autorisation"></label>
        <label>Banque<input v-model="s.company.bank_name"></label><label>IBAN (imprimé + QR code de paiement)<input v-model="s.company.iban"></label><label>BIC<input v-model="s.company.bic"></label>
      </div>
    </div>
    <div class="card" v-if="tab==='workshop'">
      <div class="form-grid">
        <label>Taux horaire M.O. (HT)<input type="number" v-model.number="s.workshop.labor_rate"></label>
        <label>TVA par défaut (%)<input type="number" v-model.number="s.workshop.default_tax"></label>
        <label>Délai de paiement (jours)<input type="number" v-model.number="s.workshop.payment_terms"></label>
        <label>Nombre de ponts<input type="number" v-model.number="s.workshop.bays"></label>
        <label>Préfixe devis<input v-model="s.numbering.quote"></label><label>Préfixe OR<input v-model="s.numbering.order"></label>
        <label>Préfixe factures<input v-model="s.numbering.invoice"></label><label>Préfixe avoirs<input v-model="s.numbering.credit_note"></label>
        <label class="full">Pied de facture<textarea v-model="s.invoice_footer"></textarea></label>
      </div>
    </div>
    <div class="card" v-if="tab==='users'">
      <div class="card-head"><h2>Équipe</h2><button class="btn primary" @click="editUser = {role: 'mechanic', color: '#3b82f6', active: 1}">+ Ajouter</button></div>
      <table><thead><tr><th>Nom</th><th>Rôle</th><th>Identifiant</th><th>Coût horaire</th><th>Statut</th></tr></thead>
        <tbody><tr v-for="u in users" class="click" @click="editUser = {...u}">
          <td><span class="avatar" :style="{background: u.color}">{{ u.name[0] }}</span> {{ u.name }}</td><td>{{ ROLE[u.role] }}</td>
          <td class="small">{{ u.role === 'mechanic' ? (u.has_pin ? 'PIN kiosque ✓' : 'pas de PIN') : u.email }}</td><td>{{ u.hourly_cost ? u.hourly_cost + ' €' : '' }}</td>
          <td><Badge :label="u.active ? 'Actif' : 'Inactif'" :color="u.active ? 'green' : 'gray'"/></td></tr></tbody></table>
    </div>
    <div class="card" v-if="tab==='accounts'">
      <div class="card-head"><div><h2 style="margin:0">Plan comptable</h2><div class="muted small">Inspiré du PCN luxembourgeois — à faire valider par votre fiduciaire.</div></div><button class="btn" @click="newAcc = {type: 'expense'}">+ Compte</button></div>
      <table><thead><tr><th>Code</th><th>Intitulé</th><th>Type</th></tr></thead><tbody><tr v-for="a in accounts" class="click" @click="newAcc = {...a}"><td><b>{{ a.code }}</b></td><td>{{ a.name }}</td><td>{{ a.type }}</td></tr></tbody></table>
    </div>
    <div class="card" v-if="tab==='ai'">
      <p>Statut : <b :class="store.ai ? 'pos' : 'neg'">{{ store.ai ? 'Agents IA actifs' : 'Mode démo — ajoutez ANTHROPIC_API_KEY dans le fichier .env puis redémarrez' }}</b></p>
      <label>Contexte de votre garage (partagé avec tous les agents)
        <textarea v-model="s.ai.garage_context" rows="8" placeholder="Ex. : Garage multimarque à Esch-sur-Alzette, 4 mécaniciens, spécialisé VW/Audi et véhicules électriques. Objectif 2027 : ouvrir une carrosserie…"></textarea></label>
    </div>

    <Modal v-if="editUser" :title="editUser.id ? editUser.name : 'Nouvel utilisateur'" @close="editUser = null">
      <div class="form-grid">
        <label>Nom<input v-model="editUser.name"></label>
        <label>Rôle<select v-model="editUser.role"><option v-for="(l, k) in ROLE" :value="k">{{ l }}</option></select></label>
        <template v-if="editUser.role !== 'mechanic'"><label>E-mail<input v-model="editUser.email" type="email"></label><label>Mot de passe {{ editUser.id ? '(laisser vide = inchangé)' : '' }}<input v-model="editUser.password" type="password"></label></template>
        <label v-else>Code PIN kiosque (4-6 chiffres) {{ editUser.id ? '(vide = inchangé)' : '' }}<input v-model="editUser.pin" inputmode="numeric" maxlength="6"></label>
        <label>Couleur<input v-model="editUser.color" type="color" style="height:38px"></label>
        <label>Coût horaire (€)<input v-model.number="editUser.hourly_cost" type="number"></label>
        <label class="check" v-if="editUser.id"><input type="checkbox" :checked="!!editUser.active" @change="editUser.active = $event.target.checked ? 1 : 0"> Actif</label>
      </div>
      <template #foot><button class="btn primary" @click="saveUser">Enregistrer</button></template>
    </Modal>
    <Modal v-if="newAcc" title="Compte comptable" @close="newAcc = null">
      <div class="form-grid"><label>Code<input v-model="newAcc.code"></label><label>Intitulé<input v-model="newAcc.name"></label>
        <label>Type<select v-model="newAcc.type"><option value="asset">Actif</option><option value="liability">Passif</option><option value="equity">Capitaux propres</option><option value="income">Produit</option><option value="expense">Charge</option></select></label></div>
      <template #foot><button class="btn primary" @click="saveAcc">Enregistrer</button></template>
    </Modal>
  </div>`,
};
