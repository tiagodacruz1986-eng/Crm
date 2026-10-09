# 🔧 Garage Manager — logiciel de gestion de garage + bureau virtuel IA

Logiciel complet de gestion de garage automobile (pensé pour le Luxembourg), inspiré d'Odoo et des meilleurs logiciels d'atelier, avec une équipe de **6 agents IA** dans un **bureau virtuel 3D**.

## ✨ Fonctionnalités

| Module | Ce qu'il fait |
|---|---|
| 🏠 **Tableau de bord** | CA du mois/année, impayés et retards, trésorerie, OR en cours, stock bas, mécaniciens présents, rendez-vous du jour, contrôles techniques à venir, graphique 12 mois |
| 🔧 **Atelier (Kanban)** | Ordres de réparation en colonnes (À faire → En cours → Attente pièces → Terminé), glisser-déposer, retards signalés, qui travaille dessus en direct |
| 📅 **Planning** | Agenda hebdomadaire par mécanicien, création en un clic, « Véhicule arrivé → OR » |
| ⏱️ **Pointage mécaniciens** | Kiosque tablette (`/kiosk.html`) avec code PIN : arrivée/départ, démarrer/arrêter sur une fiche de travail, cocher les travaux faits, diagnostic, km, notes. Heures vendues vs heures pointées, productivité |
| 📝 **Devis → OR → Facture → Avoir** | Main-d'œuvre, pièces du stock, forfaits, remises, TVA 17/14/8/3 %, impression PDF avec **QR code de paiement SEPA**, signature « bon pour accord » |
| 🎨 **Mise en page des factures (comme Odoo)** | Paramètres → « Mise en page des documents » : **logo du garage** (glisser-déposer), **6 modèles** prêts (Moderne, Encadré, Audacieux, Rayé, Classique, Atelier) avec aperçus, **couleurs reprises automatiquement du logo** ou palettes, police, format A4/Letter, slogan, mention en en-tête, pied de page, **conditions générales en page 2**, choix des blocs affichés (véhicule avec plaque, QR de paiement, banque, remises, signature, tampon « PAYÉE »). **Aperçu en direct** sur un exemple de facture, devis, OR ou avoir. Le logo apparaît aussi dans les e-mails et sur la page de suivi du client |
| 👥 **Clients & véhicules** | Fiche client, historique complet par véhicule, **décodage VIN**, contrôle technique / entretien, consentement RGPD |
| 📦 **Stock** | Articles, emplacements, seuils mini, marges, inventaire, mouvements, **réapprovisionnement automatique** par fournisseur |
| 🛒 **Achats** | Commandes fournisseurs, réception (entrée en stock), factures fournisseurs et frais généraux, paiements |
| 🏦 **Banque** | Import des relevés **CAMT.053** (toutes les banques luxembourgeoises) ou CSV, dédoublonnage, **rapprochement automatique** avec les factures clients et fournisseurs, affectation en 1 clic (frais, salaires, loyer, TVA…) |
| 📚 **Comptabilité** | Écritures automatiques (ventes, achats, banque, caisse), journal, balance, grand livre, **décompte TVA**, compte de résultat, créances clients, OD manuelles, export CSV pour la fiduciaire |
| 🧠 **Bureau IA « Neural Core »** | Cerveau holographique en 3D (réseau de neurones en particules posé sur une puce, filaments d'énergie) et 6 agents reliés au cerveau : Claire (experte-comptable), Léo (marketing), Sophie (secrétariat), Marco (chef d'atelier), Maître Laurent (avocat), Alex (CIO & stratégie). **Écrivez ou parlez-leur** (micro), ils répondent **à voix haute**, chacun avec sa voix. **Mode conversation vocale** : on parle comme au téléphone. **Historique** : toutes les conversations sont rangées, recherchables (mot, client, plaque…), épinglables et renommables. Le cerveau s'anime quand un agent écoute, réfléchit ou parle. Aussi : **tâches programmées**, rapports, **réunion d'équipe** avec synthèse du CIO |
| ✉️ **E-mails** | Bouton ✉️ sur chaque page et chaque fiche : modèles prêts (devis, facture avec QR code de paiement, relance, véhicule prêt, rappel contrôle technique, confirmation de rendez-vous, bon de commande fournisseur…), aperçu, **rédaction par l'IA**, **envoi programmé**, historique des envois |
| ⏰ **Activités (comme Odoo)** | Sur chaque fiche et chaque module : tâches, appels, relances, commandes… avec échéance, responsable et **répétition** (jour, semaine, mois, an). Page « Activités » (en retard / aujourd'hui / à venir) et cloche dans la barre du haut. Historique de chaque fiche avec notes internes |
| 📡 **Suivi en direct des OR** | Pour chaque ordre de réparation : un **lien mécanicien** (téléphone de l'atelier) pour envoyer photos, vidéos et messages, et un **lien client** avec une **jauge d'avancement en temps réel** (Véhicule reçu → Diagnostic → Accord client → Pièces → Réparation → Contrôle qualité → Prêt). Le client voit les photos et vidéos, répond, et **accepte ou refuse d'un clic les travaux supplémentaires** (ajoutés automatiquement à l'OR). Envoi du lien par e-mail, WhatsApp, SMS ou QR code |
| 📥 **Factures fournisseurs par e-mail + IA** | Transférez les factures à une adresse dédiée (ou déposez PDF / photos) : l'IA lit le document, retrouve ou crée le fournisseur, reconnaît vos articles, propose le compte de charge et la TVA, vérifie le total et signale les doublons. Le **document original reste en pièce jointe** et s'affiche à côté de la facture pour la vérification, comme dans Odoo |
| 📱 **PC, tablette et téléphone** | Interface adaptée à chaque écran : menu à icônes sur tablette, barre de navigation en bas et bouton ＋ sur téléphone, listes en fiches, planning jour par jour, déplacement des OR au doigt. **Installable comme une application** (icône sur l'écran d'accueil). Menu « 📱 Sur téléphone / tablette » : QR code pour ouvrir le logiciel sur le réseau du garage |
| 🧠 **Nova — copilote IA qui écoute** | Bouton lumineux en bas à droite, sur toutes les pages. **Parlez-lui** (micro) ou écrivez : « rappelle-moi demain 9h d'appeler le fournisseur », « mets Muller jeudi 14h pour les pneus », « combien j'ai encaissé cette semaine ? » — elle **agit** (activités, rendez-vous, notes) avec vos vraies données et **répond à voix haute**. Mode **« écoute de la journée »** : tout ce que vous dites est noté dans le journal (dites « Nova, … » pour lui donner un ordre). Chaque soir (18:30 par défaut) elle fait le **résumé de fin de journée** (argent, atelier, mécaniciens, clients, stock, ce que vous avez dit) et **planifie automatiquement les priorités** du lendemain en activités 🧠. Résumé aussi envoyé par e-mail si souhaité |
| 🎨 **Deux thèmes : sombre et clair** | Thème **sombre** « Neon Glass » (verre dépoli, dégradés cyan → violet → rose) et thème **clair** lumineux, plus un mode **automatique** qui suit le réglage du téléphone ou de l'ordinateur. Changement d'un clic (☀️/🌙 en haut, ou menu du compte → Apparence, avec aperçus), aussi sur la page de connexion et le kiosque. Le choix est gardé sur chaque appareil |
| 🟦 **Menu des applications (comme Odoo)** | Après la connexion : grille d'applications (Atelier, Ventes, Contacts, Parc automobile, Inventaire, Achats, Banque, Comptabilité, Présences, Rendez-vous, To-do, Discussion, IA…) sur un fond personnalisable (photo du garage). Dans chaque application, barre du haut avec ses sous-menus ; bouton ▦ pour revenir au menu. Filtrer en tapant le nom. La barre latérale reste disponible (menu du compte) |
| 🔐 **Utilisateurs & droits d'accès (comme Odoo)** | Paramètres → Utilisateurs & accès : **inviter** quelqu'un par lien ou e-mail (il choisit son mot de passe), types Administrateur / Utilisateur interne / Mécanicien (kiosque), et pour chaque application : **Aucun accès, Lecture seule, Utilisateur, Administrateur**. Modèles prêts : Bureau, Chef d'atelier, Comptable / fiduciaire, Magasinier, Lecture seule. Les droits sont vérifiés par le serveur (pas seulement cachés), les menus et le tableau de bord s'adaptent |
| 🕘 **Présences (comme Odoo)** | Gros bouton **Arrivée / Départ** (page Présences ou icône 🕘 de la barre du haut), **kiosque** avec photos de l'équipe, code PIN ou **badge**, message de bienvenue ; tableau de l'équipe en direct ; **rapports** heures prévues / travaillées / supplémentaires / retards, corrections par le responsable, export CSV ; départ automatique si oubli |
| ⚙️ **Configuration (options d'Odoo)** | Paramètres → Configuration : validité des devis, remises sur lignes, **relances de paiement automatiques par niveaux**, **rappel de rendez-vous la veille**, heures et jours travaillés, badges, **date de verrouillage comptable**, périodicité TVA, **stock négatif interdit**, **approbation des achats** au-delà d'un montant, page d'accueil et fond d'écran |
| 🤝 **CRM (comme Odoo)** | Pipeline en colonnes (Nouveau → Qualifié → Devis envoyé → Négociation → Gagné), glisser-déposer, création rapide, priorités ⭐, montant et probabilité, source (site web, téléphone, réseaux…), commercial, activités et historique ; **Gagnée / Perdue** (avec raison), **création du client et du devis en un clic** ; liste, perdues, analyse (pipeline pondéré, taux de réussite, sources) |
| 🌐 **Site web (comme Odoo)** | Page web du garage à l'adresse **/site** : blocs (bannière, services, offre, à propos, avis, galerie, FAQ, horaires, contact) à réordonner, masquer, modifier, photos ; **textes rédigés par l'IA** ; aperçu ordinateur / téléphone ; thème sombre ou clair aux couleurs du logo ; référencement Google ; **publication en un clic**. Le formulaire de contact crée une **opportunité dans le CRM** + une activité « à rappeler » (anti-robots et anti-abus). Les avis clients restent masqués tant que vous n'y avez pas recopié de vrais avis |
| 📣 **Marketing social (comme Odoo)** | Rédiger une publication avec aperçu, **l'IA l'adapte à chaque réseau** et propose des **idées selon la saison** ; programmer (calendrier) ou publier tout de suite. **Facebook et Instagram** : publication automatique après connexion de la page (jeton Meta). **Google Business, LinkedIn, TikTok** : texte prêt à copier + lien pour publier à la main |
| 🔍 **Recherche globale** | `Ctrl + K` : plaque, client, n° de facture, référence pièce |

## 🚀 Installation

### Le plus simple (sans taper de commande)

1. Installez **Node.js** (version LTS) depuis https://nodejs.org
2. Sur GitHub, bouton vert **Code → Download ZIP**, puis décompressez le dossier
3. Double-cliquez sur **`demarrer-windows.bat`** (Windows) ou **`demarrer-mac.command`** (Mac)
4. Le navigateur s'ouvre sur http://localhost:3000 — laissez la fenêtre noire ouverte tant que vous utilisez le logiciel

### En ligne de commande

Prérequis : **Node.js 22 ou plus récent** (https://nodejs.org).

```bash
npm install
cp .env.example .env      # puis mettez votre clé API Claude dans .env
npm start
```

Ouvrez **http://localhost:3000** : au premier lancement, créez le compte du gérant.

- Tablette atelier : **http://localhost:3000/kiosk.html** (ou `http://IP-DU-PC:3000/kiosk.html` depuis le réseau du garage) — téléphones : voir [Installer sur téléphone](#-installer-sur-téléphone)
- Pour découvrir avec des données d'exemple (sur une base vide) : `npm run demo` → connexion `demo@garage.lu` / `demo1234`, PIN mécaniciens `1111`, `2222`, `3333`

Les données sont enregistrées dans le dossier `data/` (base SQLite `garage.db` + photos et pièces jointes). **Sauvegardez tout le dossier `data/` régulièrement**, de préférence logiciel arrêté.

## 🤖 Activer les agents IA

1. Créez une clé sur https://console.anthropic.com
2. Mettez-la dans `.env` : `ANTHROPIC_API_KEY=sk-ant-...`
3. Redémarrez (`npm start`)

Les agents utilisent le modèle Claude `claude-opus-5` (modifiable via `CLAUDE_MODEL`), peuvent consulter les données du garage (lecture seule) et faire des recherches sur le web. Les tâches programmées tournent tant que le logiciel est allumé (fuseau `Europe/Luxembourg`).
Dans **Paramètres → Agents IA**, décrivez votre garage : ce contexte est partagé avec toute l'équipe.

## 📲 Installer sur téléphone

Le logiciel s'installe sur iPhone, Android et tablette **comme une application** : icône sur l'écran d'accueil, plein écran, l'interface s'ouvre même sans réseau (les données, elles, restent sur l'ordinateur du garage ou votre serveur).

Dans le logiciel : menu du compte → **📱 Sur téléphone / tablette** → scannez le QR code avec l'appareil photo du téléphone. La page qui s'ouvre détecte l'appareil et explique les étapes : bouton **Installer l'application** sur Android, *Partager → Sur l'écran d'accueil* sur iPhone / iPad. Le même écran propose aussi le **pointage atelier** pour la tablette des mécaniciens.

Trois façons de rendre le logiciel joignable, de la plus simple à la plus complète :

| | 1. Wi-Fi du garage | 2. Tailscale (privé) | 3. Serveur internet |
|---|---|---|---|
| Fonctionne | au garage | au garage **et en 4G** | partout |
| Vraie application sur Android | raccourci seulement | ✅ | ✅ |
| Liens de suivi pour les clients, site web | ❌ | ❌ (seulement vos appareils) | ✅ |
| Mise en place | rien à faire | 5 minutes | nom de domaine + petit serveur |

### 1. Sur le Wi-Fi du garage (rien à configurer)

Le téléphone et le PC doivent être sur **le même Wi-Fi** : scannez le QR code « Sur le Wi-Fi du garage ». Sans https, l'iPhone ajoute quand même l'icône en plein écran ; Android ne crée qu'un **raccourci** (sans mode hors-ligne).
Si Windows demande l'autorisation du pare-feu au premier lancement, acceptez pour les **réseaux privés**, sinon les appareils ne pourront pas se connecter.

### 2. Tailscale : adresse https privée, au garage et en 4G

[Tailscale](https://tailscale.com) relie vos appareils par un réseau privé chiffré : **rien n'est ouvert sur internet**, seuls les appareils connectés à votre compte voient le logiciel.

1. Créez un compte Tailscale et installez Tailscale sur le PC du garage ([Windows](https://tailscale.com/download/windows) / [Mac](https://tailscale.com/download/mac)). Donnez au PC un nom neutre (ex. `atelier-pc`) : il apparaît dans l'adresse et dans les registres publics des certificats https.
2. Démarrez le logiciel (`demarrer-windows.bat` / `demarrer-mac.command`), puis double-cliquez sur **`acces-telephone-windows.bat`** (ou **`acces-telephone-mac.command`**). Le script active l'adresse `https://atelier-pc.<votre-réseau>.ts.net` et l'ouvre. Si Tailscale demande d'activer HTTPS, acceptez (console Tailscale → *DNS* → *MagicDNS* et *HTTPS Certificates*).
3. Sur chaque téléphone : installez l'app **Tailscale** (App Store / Google Play), connectez-vous avec **le même compte**, ouvrez l'adresse (ou, dans le logiciel ouvert avec cette adresse, scannez le QR code « Adresse sécurisée ») et installez l'application.

Bon à savoir : le PC doit rester allumé (veille désactivée) ; Tailscale doit être connecté sur le téléphone pendant l'utilisation. L'offre gratuite de Tailscale est réservée à un usage personnel : pour un garage, prenez une offre professionnelle (voir [tailscale.com/pricing](https://tailscale.com/pricing)). Pour couper l'accès : `tailscale serve --https=443 off`. N'utilisez pas `tailscale funnel`, qui rendrait le logiciel public.

### 3. Serveur internet avec votre nom de domaine

Nécessaire aussi pour le **site web public** et les **liens de suivi** envoyés aux clients. Sur un petit serveur Linux (VPS, de préférence situé dans l'UE) avec Docker :

1. Chez votre fournisseur de nom de domaine, créez un enregistrement DNS **A** `atelier.votre-garage.lu` → adresse IP du serveur. Les ports **80** et **443** doivent être ouverts.
2. Copiez le dossier du logiciel sur le serveur et créez un fichier `.env` :
   ```
   DOMAIN=atelier.votre-garage.lu
   ANTHROPIC_API_KEY=sk-ant-...
   ```
3. Lancez `docker compose up -d`. [Caddy](https://caddyserver.com) obtient et renouvelle automatiquement le certificat https.
4. Ouvrez `https://atelier.votre-garage.lu`. Pour créer le compte du gérant **depuis internet**, un **code d'installation** est demandé (sécurité) : il s'affiche avec `docker compose logs garage | grep "Code d'installation" | tail -n 1` (il reste le même après un redémarrage, jusqu'à la création du compte).
5. Sauvegarde (les données sont dans le volume Docker `garage-data`) :
   `docker compose stop garage && docker compose cp garage:/app/data ./sauvegarde-$(date +%F) && docker compose start garage`
6. Mise à jour : récupérez la nouvelle version, puis `docker compose up -d --build`.

Protections actives quand le logiciel est joint depuis internet : code d'installation pour le premier compte, **10 essais de mot de passe maximum** par adresse et 20 par compte sur un quart d'heure (un téléphone ou PC déjà connecté à ce compte n'est jamais bloqué), **code PIN toujours demandé** au kiosque de pointage (donnez un PIN à chaque mécanicien), cookies de session sécurisés. Utilisez des mots de passe solides. Si un compte reste bloqué, `docker compose restart garage` remet les compteurs à zéro.

*Variante sans serveur* : garder le logiciel sur le PC du garage et le publier avec un [Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/) nommé sur votre domaine, protégé par **Cloudflare Access**. Le tunnel rapide `trycloudflare.com` ne sert qu'à un essai : l'adresse change à chaque lancement (l'application installée cesse de marcher), le suivi en temps réel n'y fonctionne pas et l'adresse est publique.

## ✉️ Configurer les e-mails

**Paramètres → E-mails** : serveur SMTP de votre messagerie (préréglages Gmail, Outlook/Microsoft 365, OVH, POST Luxembourg), adresse d'expédition et signature, puis **Tester**. Pour Gmail et Microsoft 365, utilisez un « mot de passe d'application ». Sans configuration, le bouton « Ouvrir dans ma messagerie » reste disponible.

## 📥 Factures fournisseurs automatiques

1. Créez une adresse e-mail dédiée, par exemple **factures@votre-garage.lu**, et donnez-la à vos fournisseurs (ou transférez-y les factures reçues).
2. **Paramètres → E-mails → Réception des factures fournisseurs** : serveur IMAP, identifiant, mot de passe (mot de passe d'application pour Gmail / Microsoft 365), puis **Tester** et cochez **Vérification automatique**.
3. Toutes les X minutes, chaque PDF ou photo joint devient une **facture fournisseur en brouillon « 🤖 à vérifier »**, avec l'original en pièce jointe. Vous pouvez aussi glisser-déposer des fichiers dans **Achats**.
4. Ouvrez la facture : le document s'affiche à droite, les lignes à gauche. Corrigez si besoin, cliquez **✔ Vérifiée** puis **Comptabiliser**.

L'encodage IA nécessite la clé API Claude ; sans elle, la facture est créée en brouillon avec le document joint, à compléter à la main.

## 📡 Suivi en direct (liens mécanicien et client)

Dans un ordre de réparation, le panneau **Suivi en direct** crée deux liens secrets :
- **Lien mécanicien** : à ouvrir sur le téléphone de l'atelier (aussi accessible depuis le kiosque, bouton « 📷 Photos & messages »). Le mécanicien y fait avancer les étapes, coche les travaux, envoie photos et vidéos (visibles par le client ou internes) et peut **demander l'accord du client** avec un montant.
- **Lien client** : jauge d'avancement mise à jour en temps réel, photos et vidéos, messages, boutons **J'accepte / Refuser**. Il s'envoie par e-mail, WhatsApp, SMS ou QR code, et peut être désactivé à tout moment.

**Important : pour que le client ouvre le lien depuis chez lui, le logiciel doit être joignable depuis internet.** Sur le réseau Wi-Fi du garage, les liens fonctionnent tout de suite. Pour l'extérieur, installez le logiciel sur un serveur avec votre nom de domaine (voir [Installer sur téléphone → Serveur internet](#3-serveur-internet-avec-votre-nom-de-domaine)) ou publiez-le avec un Cloudflare Tunnel nommé. Le tunnel rapide `trycloudflare.com` ne convient pas : l'adresse change à chaque lancement et la mise à jour en temps réel n'y fonctionne pas.

Indiquez ensuite cette adresse dans **Paramètres → Atelier & factures → Adresse publique** (avec Docker, elle est réglée automatiquement). Utilisez un mot de passe solide pour les comptes du bureau.

## 🧠 Nova, le copilote

- **Parler** : cliquez sur le micro dans la fenêtre de Nova (Chrome, Edge ou Safari ; autorisez le micro). La réponse est lue à voix haute (désactivable).
- **Écoute de la journée** : bouton 📝 dans la fenêtre de Nova. Chaque phrase est notée dans le **journal** (page « Nova — copilote »). Rien n'est envoyé à l'IA avant le résumé du soir.
- **Résumé de fin de journée** : automatique à l'heure choisie (page « Nova — copilote » → réglages), ou bouton « Résumer ma journée » sur le tableau de bord. Les priorités deviennent des activités 🧠 (sans doublons). Sans clé IA, un résumé chiffré et des priorités par règles sont quand même produits.

## 🔄 Importer depuis Odoo

**Paramètres → Import Odoo** : indiquez l'adresse de votre Odoo, le nom de la base, votre e-mail de connexion et une **clé API** (Odoo → votre profil → Sécurité du compte → Nouvelle clé API), puis **Tester la connexion** et **Lancer l'import**.

Sont importés : clients et fournisseurs (avec TVA, adresse), véhicules (plaque, VIN, marque/modèle, kilométrage, 1ère immatriculation, **prochain contrôle technique**, prochain entretien, dimension pneus, propriétaire) et articles (référence, EAN, prix d'achat/vente, TVA, catégorie, fournisseur principal, **quantité en stock**).
L'import peut être relancé : les fiches déjà importées sont mises à jour, jamais dupliquées. Les données restent sur votre ordinateur.

## 🏦 Banque

- **Aujourd'hui** : dans votre banque en ligne (Spuerkeess, BGL BNP Paribas, BIL, POST, Raiffeisen, ING…), téléchargez le relevé au format **CAMT.053 (XML)** et importez-le dans *Banque*. Les virements contenant le numéro de facture sont rapprochés automatiquement ; les autres vous sont proposés.
- **Synchronisation automatique** : nécessite un agrégateur bancaire agréé PSD2 (ex. Ponto / Isabel Group) et un contrat avec lui. Le connecteur est prévu dans `src/bank.js` (`syncAccount`) et s'active dès que vous disposez des identifiants API.

## ⚖️ Important

- Le plan comptable fourni est **inspiré du PCN luxembourgeois** et le décompte TVA est une aide : faites valider le paramétrage et vos déclarations par votre fiduciaire.
- Les réponses de l'avocat et de l'experte-comptable IA sont de l'information générale, pas un avis professionnel engageant.
- Une facture validée ne peut plus être modifiée ni supprimée (obligation légale) : utilisez une note de crédit.

## 🧱 Technique

- Serveur : Node.js + Express, base SQLite intégrée (`node:sqlite`), aucune installation de base de données
- Interface : Vue 3 + Three.js servis en local (fonctionne sans internet, sauf l'IA et le décodage VIN en ligne)
- IA : SDK officiel Anthropic (`@anthropic-ai/sdk`), outils de lecture des données + recherche web
- Tests : `npm test` (parcours complet achat → stock → devis → OR → pointage → facture → banque → comptabilité, et import Odoo)

```
server.js            API + serveur web
src/db.js            schéma, paramètres, numérotation, plan comptable
src/business.js      documents, stock, achats, écritures comptables, rapports
src/bank.js          import CAMT.053/CSV, rapprochement
src/agents.js        les 6 agents + outils d'accès aux données
src/claude.js        appels à l'API Claude, réunion d'équipe
src/scheduler.js     tâches programmées
src/odoo.js          import depuis Odoo (JSON-RPC)
src/mail.js          e-mails, historique des fiches, activités planifiées
src/live.js          suivi en direct des OR (liens, photos/vidéos, étapes, accord client)
src/bills.js         factures fournisseurs : boîte IMAP, encodage IA, pièces jointes
public/              interface (Vue) + kiosque + bureau 3D
```
