import { ref, reactive, onMounted, onUnmounted } from 'vue';
import { GET, POST, PUT, act, toast, store, datetime } from '../api.js';

const ROLE = { admin: 'Gérant (admin)', office: 'Bureau / accueil', mechanic: 'Mécanicien' };

export const Settings = {
  setup() {
    const s = ref(null);
    const users = ref([]);
    const accounts = ref([]);
    const tab = ref('company');
    const editUser = ref(null);
    const newAcc = ref(null);
    const odoo = ref(null);
    const odooOpts = reactive({ customers: true, suppliers: true, vehicles: true, products: true });
    const odooTest = ref(null);
    let odooPoll;
    const loadOdoo = async () => {
      odoo.value = { ...(await GET('/odoo')), form: odoo.value?.form || null };
      if (!odoo.value.form) odoo.value.form = { ...odoo.value.config, api_key: '' };
      if (odoo.value.job.running && !odooPoll) odooPoll = setInterval(async () => {
        const r = await GET('/odoo');
        odoo.value.job = r.job; odoo.value.last = r.last;
        if (!r.job.running) { clearInterval(odooPoll); odooPoll = null; toast(r.job.error ? 'Import Odoo : ' + r.job.error : 'Import Odoo terminé', r.job.error ? 'error' : 'ok'); }
      }, 1500);
    };
    onUnmounted(() => clearInterval(odooPoll));
    const saveOdoo = async () => { await act(() => PUT('/odoo', odoo.value.form), 'Connexion Odoo enregistrée'); odoo.value.form.api_key = ''; await loadOdoo(); };
    const testOdoo = async () => { await saveOdoo(); odooTest.value = await act(() => POST('/odoo/test')); };
    const importOdoo = async () => {
      if (!confirm('Importer les données depuis Odoo ? Les éléments déjà importés seront mis à jour (pas de doublons).')) return;
      await act(() => POST('/odoo/import', { options: odooOpts }));
      await loadOdoo();
    };
    const mail = ref(null);
    const loadMail = async () => { mail.value = { ...(await GET('/mail/config')), pass: '' }; };
    const saveMail = async () => { await act(() => PUT('/mail/config', mail.value), 'Configuration e-mail enregistrée'); await loadMail(); };
    const testMail = async () => { await saveMail(); await act(() => POST('/mail/test'), '✅ Connexion au serveur d\'e-mail réussie'); };
    const preset = (k) => Object.assign(mail.value, { gmail: { host: 'smtp.gmail.com', port: 465, secure: true }, outlook: { host: 'smtp.office365.com', port: 587, secure: false }, ovh: { host: 'ssl0.ovh.net', port: 465, secure: true }, pt: { host: 'mail.pt.lu', port: 587, secure: false } }[k]);
    const load = async () => { loadOdoo(); loadMail(); s.value = await GET('/settings'); users.value = await GET('/users'); accounts.value = await GET('/accounting/accounts'); };
    onMounted(load);
    const save = async () => { store.settings = await act(() => PUT('/settings', s.value), 'Paramètres enregistrés'); store.company = store.settings.company.name; };
    const saveUser = async () => {
      const u = editUser.value;
      if (u.id) await act(() => PUT('/users/' + u.id, u), 'Utilisateur modifié'); else await act(() => POST('/users', u), 'Utilisateur créé');
      editUser.value = null; load();
    };
    const saveAcc = async () => { await act(() => POST('/accounting/accounts', newAcc.value), 'Compte enregistré'); newAcc.value = null; load(); };
    return { mail, saveMail, testMail, preset, odoo, odooOpts, odooTest, saveOdoo, testOdoo, importOdoo, datetime, s, users, accounts, tab, save, editUser, saveUser, newAcc, saveAcc, ROLE, store };
  },
  template: `
  <div v-if="s">
    <div class="page-head"><h1>Paramètres</h1><button class="btn primary" v-if="['company','workshop','ai'].includes(tab)" @click="save">Enregistrer</button></div>
    <div class="tabs">
      <button v-for="[k, l] in [['company','Société'],['workshop','Atelier & factures'],['users','Utilisateurs & mécaniciens'],['accounts','Plan comptable'],['mail','E-mails'],['odoo','Import Odoo'],['ai','Agents IA']]" :class="{active: tab===k}" @click="tab = k">{{ l }}</button>
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
    <div class="card" v-if="tab==='mail' && mail">
      <h2>✉️ Envoi des e-mails</h2>
      <p class="muted">Les e-mails (devis, factures, relances, rappels…) partent de votre propre adresse. Renseignez les paramètres SMTP de votre messagerie.</p>
      <div class="btns small" style="margin-bottom:10px"><span class="muted">Préréglages :</span><button class="btn sm" @click="preset('gmail')">Gmail</button><button class="btn sm" @click="preset('outlook')">Outlook / Microsoft 365</button><button class="btn sm" @click="preset('ovh')">OVH</button><button class="btn sm" @click="preset('pt')">POST Luxembourg</button></div>
      <div class="form-grid">
        <label>Serveur SMTP<input v-model="mail.host" placeholder="smtp.exemple.lu"></label>
        <label>Port<input v-model.number="mail.port" type="number"></label>
        <label class="check"><input type="checkbox" v-model="mail.secure"> Connexion SSL (port 465)</label>
        <label>Identifiant<input v-model="mail.user" autocomplete="off"></label>
        <label>Mot de passe {{ mail.has_pass ? '(enregistré — vide = inchangé)' : '' }}<input v-model="mail.pass" type="password" autocomplete="new-password"></label>
        <label>Adresse d'expédition<input v-model="mail.from_email" type="email" placeholder="info@votre-garage.lu"></label>
        <label>Nom de l'expéditeur<input v-model="mail.from_name" placeholder="Garage …"></label>
        <label class="check"><input type="checkbox" v-model="mail.bcc_me"> Me mettre en copie cachée</label>
        <label class="full">Signature<textarea v-model="mail.signature" placeholder="L'équipe du Garage …&#10;+352 …"></textarea></label>
      </div>
      <p class="muted small">Gmail / Microsoft 365 : utilisez un « mot de passe d'application » (sécurité du compte), pas votre mot de passe habituel.</p>
      <div class="btns"><button class="btn primary" @click="saveMail">Enregistrer</button><button class="btn" @click="testMail">🔌 Tester</button><span v-if="mail.configured" class="pos">● Configuré</span></div>
    </div>
    <div class="card" v-if="tab==='odoo' && odoo">
      <h2>🔄 Importer mes données depuis Odoo</h2>
      <p class="muted">Récupère vos clients, fournisseurs, véhicules (avec contrôle technique, pneus…) et articles avec leur stock. Vous pouvez relancer l'import autant de fois que nécessaire : rien n'est dupliqué, les fiches sont mises à jour.</p>
      <div class="form-grid">
        <label class="full" style="grid-column: span 2">Adresse de votre Odoo<input v-model="odoo.form.url" placeholder="https://votre-societe.odoo.com"></label>
        <label>Nom de la base<input v-model="odoo.form.db" placeholder="votre-societe"></label>
        <label>Identifiant (e-mail de connexion)<input v-model="odoo.form.login" type="email"></label>
        <label class="full" style="grid-column: span 2">Clé API {{ odoo.config.has_key ? '(enregistrée — laisser vide pour la garder)' : '' }}<input v-model="odoo.form.api_key" type="password" autocomplete="off"></label>
      </div>
      <p class="muted small">Clé API : dans Odoo, cliquez sur votre photo → <b>Mon profil</b> → onglet <b>Sécurité du compte</b> → <b>Nouvelle clé API</b>. Le nom de la base apparaît dans Odoo sous <b>Paramètres → Activer le mode développeur</b>, ou c'est généralement le début de votre adresse (…<b>.odoo.com</b>).</p>
      <div class="btns"><button class="btn" @click="saveOdoo">Enregistrer</button><button class="btn" @click="testOdoo">🔌 Tester la connexion</button></div>
      <div v-if="odooTest" class="pos" style="margin-top:10px">✅ Connecté : {{ odooTest.partners }} contacts, {{ odooTest.vehicles }} véhicules, {{ odooTest.products }} articles trouvés.</div>
      <h3 style="margin-top:18px">Que faut-il importer ?</h3>
      <div class="btns" style="margin:8px 0 12px">
        <label class="check"><input type="checkbox" v-model="odooOpts.customers"> Clients</label>
        <label class="check"><input type="checkbox" v-model="odooOpts.suppliers"> Fournisseurs</label>
        <label class="check"><input type="checkbox" v-model="odooOpts.vehicles"> Véhicules</label>
        <label class="check"><input type="checkbox" v-model="odooOpts.products"> Articles & stock</label>
      </div>
      <button class="btn primary" :disabled="odoo.job.running || !odoo.config.has_key" @click="importOdoo">{{ odoo.job.running ? '⏳ Import en cours…' : '⬇ Lancer l’import' }}</button>
      <div v-if="odoo.job.running || odoo.job.finished_at" style="margin-top:14px">
        <div><b>{{ odoo.job.step }}</b> <span v-if="odoo.job.running" class="typing"><span></span><span></span><span></span></span></div>
        <div v-if="odoo.job.error" class="error" style="margin-top:6px">{{ odoo.job.error }}</div>
        <table style="margin-top:8px;max-width:420px"><tbody><tr v-for="(v, k) in odoo.job.done"><td>{{ {customers: 'Clients', suppliers: 'Fournisseurs', vehicles: 'Véhicules', products: 'Articles'}[k] }}</td><td class="num">{{ v.created }} créés</td><td class="num">{{ v.updated }} mis à jour</td></tr></tbody></table>
      </div>
      <p v-else-if="odoo.last" class="muted small" style="margin-top:12px">Dernier import : {{ datetime(odoo.last.at) }}</p>
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
