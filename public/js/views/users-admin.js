// Paramètres → Utilisateurs & accès : comptes, invitations et droits par application (comme Odoo).
import { ref, computed, onMounted } from 'vue';
import { GET, POST, PUT, act, toast, store, datetime } from '../api.js';

const TYPES = {
  admin: { label: 'Administrateur', desc: 'Accès complet, y compris les paramètres et les utilisateurs', icon: 'shield-check' },
  office: { label: 'Utilisateur interne', desc: 'Accès au logiciel selon les droits choisis application par application', icon: 'circle-user' },
  mechanic: { label: 'Mécanicien (kiosque)', desc: 'Pointe au kiosque atelier avec son code PIN, pas d\'accès au logiciel', icon: 'wrench' },
};
const COLORS = ['#3b82f6', '#22c55e', '#ef4444', '#f59e0b', '#8b5cf6', '#ec4899', '#14b8a6', '#f97316', '#64748b'];

export const UsersAdmin = {
  setup() {
    const users = ref([]);
    const meta = ref(null);
    const edit = ref(null);
    const invite = ref(null);
    const filter = ref('active');
    const load = async () => { [users.value, meta.value] = await Promise.all([GET('/users'), meta.value || GET('/access/meta')]); };
    onMounted(load);
    const list = computed(() => users.value.filter((u) => (filter.value === 'active' ? u.active : !u.active)));
    const summary = (u) => {
      if (u.role === 'admin') return 'Tous les droits';
      if (u.role === 'mechanic') return 'Kiosque de pointage';
      const apps = (meta.value?.apps || []).filter((a) => u.permissions?.[a.key] && u.permissions[a.key] !== 'none');
      return apps.length ? apps.map((a) => a.name + (u.permissions[a.key] === 'read' ? ' (lecture)' : u.permissions[a.key] === 'manager' ? ' (admin)' : '')).join(', ') : 'Aucune application';
    };
    const status = (u) => (!u.active ? ['Désactivé', 'gray'] : u.invited ? ['Invitation envoyée', 'orange'] : u.role !== 'mechanic' && !u.has_password ? ['Pas de mot de passe', 'red'] : ['Actif', 'green']);

    const create = (role = 'office') => {
      edit.value = { role, color: COLORS[users.value.length % COLORS.length], active: 1, permissions: { ...meta.value.presets.bureau.perms }, invite: true, send_invite: false, name: '', email: '', job_title: '' };
    };
    const open = (u) => { edit.value = { ...u, permissions: { ...(u.permissions || meta.value.presets.bureau.perms) }, pin: '', password: '' }; };
    const applyPreset = (k) => { edit.value.permissions = { ...meta.value.presets[k].perms }; toast(`Modèle « ${meta.value.presets[k].name} » appliqué`); };
    const setAll = (lvl) => { for (const a of meta.value.apps) edit.value.permissions[a.key] = lvl; };
    const save = async () => {
      const e = edit.value;
      const body = { name: e.name, email: e.email || null, role: e.role, color: e.color, job_title: e.job_title || null, hourly_cost: e.hourly_cost || 0, badge: e.badge || null, permissions: e.permissions, active: e.active ? 1 : 0 };
      if (e.pin) body.pin = e.pin;
      if (e.password) body.password = e.password;
      if (e.id) {
        await act(() => PUT('/users/' + e.id, body), 'Utilisateur enregistré');
        edit.value = null;
      } else {
        const r = await act(() => POST('/users', { ...body, invite: e.invite && !e.password, send_invite: e.send_invite }), 'Utilisateur créé');
        edit.value = null;
        if (r.invite?.url) invite.value = { ...r.invite, name: body.name, email: body.email };
        else if (r.invite?.error) toast('Invitation : ' + r.invite.error, 'error');
      }
      load();
    };
    const sendInvite = async (u, send) => {
      const r = await act(() => POST(`/users/${u.id}/invite`, { send }), send ? 'Invitation envoyée par e-mail' : null);
      invite.value = { ...r, name: u.name, email: u.email };
      load();
    };
    const copy = (t) => { navigator.clipboard?.writeText(t); toast('Lien copié'); };
    const levelLabel = (l) => meta.value?.labels[l];
    return { users, list, filter, meta, edit, invite, create, open, save, applyPreset, setAll, sendInvite, copy, summary, status, levelLabel, TYPES, COLORS, datetime, store };
  },
  template: `
  <div v-if="meta">
    <div class="card">
      <div class="card-head">
        <div><h2 style="margin:0">Utilisateurs & droits d'accès</h2><div class="muted small">Partagez l'accès au logiciel et choisissez, application par application, ce que chacun peut voir ou modifier.</div></div>
        <div class="btns"><button class="btn" @click="create('mechanic')"><Icon name="wrench"/> Mécanicien</button><button class="btn primary" @click="create('office')"><Icon name="user-plus"/> Inviter un utilisateur</button></div>
      </div>
      <div class="seg" style="margin-bottom:12px"><button :class="{ on: filter === 'active' }" @click="filter = 'active'">Actifs</button><button :class="{ on: filter === 'archived' }" @click="filter = 'archived'">Désactivés</button></div>
      <table>
        <thead><tr><th>Nom</th><th>Type</th><th>Accès</th><th>Dernière connexion</th><th>Statut</th></tr></thead>
        <tbody><tr v-for="u in list" :key="u.id" class="click" @click="open(u)">
          <td><span class="avatar" :style="{ background: u.color }">{{ u.name[0] }}</span> <b>{{ u.name }}</b><div class="muted small">{{ u.job_title || u.email }}</div></td>
          <td>{{ TYPES[u.role]?.label }}</td>
          <td class="small" style="max-width:360px">{{ summary(u) }}</td>
          <td class="small muted">{{ u.last_login ? datetime(u.last_login.replace(' ', 'T') + 'Z') : '—' }}</td>
          <td><Badge :label="status(u)[0]" :color="status(u)[1]"/></td>
        </tr></tbody>
      </table>
    </div>

    <Modal v-if="edit" :title="edit.id ? edit.name : 'Nouvel utilisateur'" wide @close="edit = null">
      <div class="user-types">
        <button v-for="(t, k) in TYPES" :key="k" class="user-type" :class="{ on: edit.role === k }" :disabled="edit.id === store.user.id && k !== 'admin'" @click="edit.role = k">
          <Icon :name="t.icon"/><b>{{ t.label }}</b><small>{{ t.desc }}</small>
        </button>
      </div>
      <div class="form-grid">
        <label>Nom<input v-model="edit.name" placeholder="Prénom Nom"></label>
        <label>Fonction<input v-model="edit.job_title" placeholder="Ex. : Réceptionnaire, Mécanicien poids lourds…"></label>
        <label v-if="edit.role !== 'mechanic'">E-mail (identifiant)<input v-model="edit.email" type="email" placeholder="prenom@garage.lu"></label>
        <label>Couleur<div class="color-dots"><button v-for="c in COLORS" :key="c" :style="{ background: c }" :class="{ on: edit.color === c }" @click="edit.color = c"></button></div></label>
      </div>

      <template v-if="edit.role === 'office'">
        <h3 class="sec-title">Droits d'accès</h3>
        <div class="btns small" style="margin-bottom:10px;align-items:center"><span class="muted">Modèles :</span>
          <button v-for="(p, k) in meta.presets" :key="k" class="btn sm" @click="applyPreset(k)">{{ p.name }}</button>
        </div>
        <div class="perm-grid">
          <div v-for="a in meta.apps" :key="a.key" class="perm-row">
            <div><b>{{ a.name }}</b><div class="muted small">{{ a.desc }}</div></div>
            <div class="seg perm-seg"><button v-for="l in meta.levels" :key="l" :class="['lvl-' + l, { on: edit.permissions[a.key] === l }]" @click="edit.permissions[a.key] = l">{{ levelLabel(l) }}</button></div>
          </div>
        </div>
        <p class="muted small">Lecture seule : voir sans modifier. Utilisateur : créer et modifier. Administrateur : aussi supprimer et corriger (pointages, écritures…). Travailler dans les Ventes ou l'Atelier donne automatiquement la lecture des clients, véhicules et articles.</p>
      </template>

      <h3 class="sec-title">{{ edit.role === 'mechanic' ? 'Kiosque de pointage' : 'Pointage et connexion' }}</h3>
      <div class="form-grid">
        <label>Code PIN kiosque {{ edit.has_pin ? '(enregistré — vide = inchangé)' : '' }}<input v-model="edit.pin" inputmode="numeric" maxlength="6" placeholder="4 à 6 chiffres" autocomplete="off"></label>
        <label>Badge (code-barres de la carte)<input v-model="edit.badge" placeholder="Scannez ou tapez le code" autocomplete="off"></label>
        <label>Coût horaire (€)<input type="number" v-model.number="edit.hourly_cost"></label>
        <label v-if="edit.role !== 'mechanic' && edit.id">Nouveau mot de passe<input v-model="edit.password" type="password" autocomplete="new-password" placeholder="8 caractères min. — vide = inchangé"></label>
      </div>
      <template v-if="edit.role !== 'mechanic' && !edit.id">
        <label class="check"><input type="checkbox" v-model="edit.invite"> Créer un lien d'invitation : la personne choisit elle-même son mot de passe</label>
        <label class="check" v-if="edit.invite"><input type="checkbox" v-model="edit.send_invite"> Envoyer l'invitation par e-mail</label>
        <label v-if="!edit.invite">Mot de passe<input v-model="edit.password" type="password" autocomplete="new-password" placeholder="8 caractères minimum"></label>
      </template>
      <div v-if="edit.id && edit.role !== 'mechanic'" class="btns" style="margin-top:6px">
        <button class="btn sm" @click="sendInvite(edit, false)"><Icon name="link"/> {{ edit.has_password ? 'Lien de réinitialisation du mot de passe' : 'Lien d\\'invitation' }}</button>
        <button class="btn sm" @click="sendInvite(edit, true)"><Icon name="mail"/> Envoyer par e-mail</button>
      </div>
      <label v-if="edit.id && edit.id !== store.user.id" class="check" style="margin-top:10px"><input type="checkbox" :checked="!!edit.active" @change="edit.active = $event.target.checked ? 1 : 0"> Compte actif (décocher pour bloquer l'accès sans perdre l'historique)</label>
      <template #foot><button class="btn" @click="edit = null">Annuler</button><button class="btn primary" :disabled="!edit.name" @click="save">Enregistrer</button></template>
    </Modal>

    <Modal v-if="invite" title="Invitation prête" @close="invite = null">
      <p>Envoyez ce lien à <b>{{ invite.name }}</b>{{ invite.email ? ' (' + invite.email + ')' : '' }} : il ou elle choisira son mot de passe. Valable jusqu'au {{ datetime(invite.expires) }}.</p>
      <div class="invite-link"><input :value="invite.url" readonly @focus="$event.target.select()"><button class="btn primary" @click="copy(invite.url)"><Icon name="copy"/> Copier</button></div>
      <p v-if="invite.sent" class="pos">✉️ Invitation envoyée par e-mail.</p>
      <p class="muted small">Par WhatsApp : <a :href="'https://wa.me/?text=' + encodeURIComponent('Voici ton accès au logiciel du garage : ' + invite.url)" target="_blank" rel="noopener">partager le lien</a>.</p>
    </Modal>
  </div>`,
};
