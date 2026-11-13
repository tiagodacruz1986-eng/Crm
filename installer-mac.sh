#!/bin/bash
# Installe ou met à jour Garage Manager sur un Mac.
# Dans l'application « Terminal », collez cette ligne puis appuyez sur Entrée :
#   bash <(curl -fsSL https://raw.githubusercontent.com/tiagodacruz1986-eng/Crm/main/installer-mac.sh)
# Vos données (dossier « data ») et vos réglages (fichier « .env ») ne sont jamais touchés.
set -u
ZIP_URL="https://github.com/tiagodacruz1986-eng/Crm/archive/refs/heads/main.zip"
DIR="${GARAGE_DIR:-$HOME/GarageManager}"
fail() { echo; echo "ERREUR : $1"; echo "Rien n'a été supprimé. Vous pouvez relancer l'installation quand vous voulez."; exit 1; }
step() { echo; echo "> $1"; }

UPDATE=0; [ -f "$DIR/server.js" ] && UPDATE=1
echo
echo "  Garage Manager — $([ $UPDATE = 1 ] && echo 'mise à jour' || echo 'installation')"
echo "  Dossier du logiciel : $DIR"

step "Vérification de Node.js (le moteur du logiciel)"
if ! command -v node >/dev/null 2>&1 || ! node -e "const [a,b]=process.versions.node.split('.').map(Number);process.exit(a>22||(a===22&&b>=13)?0:1)"; then
  command -v open >/dev/null 2>&1 && open "https://nodejs.org"
  fail "Node.js 22.13 ou plus récent est nécessaire. Téléchargez la version LTS sur https://nodejs.org, installez-la, puis relancez cette commande."
fi
echo "  Node.js $(node -v) est installé."

if [ $UPDATE = 1 ]; then
  PORT_NUM=$(grep -E '^PORT=' "$DIR/.env" 2>/dev/null | tail -n 1 | cut -d= -f2 | tr -d '[:space:]"')
  PORT_NUM=${PORT_NUM:-3000}
  if curl -fs -m 3 "http://127.0.0.1:$PORT_NUM/app-info.json" >/dev/null 2>&1; then
    fail "Garage Manager est ouvert en ce moment. Fermez sa fenêtre Terminal (ou Ctrl+C dedans), puis relancez cette commande."
  fi
fi

step "Téléchargement de la dernière version"
TMP=$(mktemp -d) || fail "Impossible de créer un dossier temporaire."
trap 'rm -rf "$TMP"' EXIT
curl -fsSL -o "$TMP/logiciel.zip" "$ZIP_URL" || fail "Téléchargement impossible. Vérifiez la connexion internet, puis relancez."
unzip -q "$TMP/logiciel.zip" -d "$TMP" || fail "Le fichier téléchargé est illisible. Relancez."
SRC=$(find "$TMP" -maxdepth 2 -name server.js -exec dirname {} \; | head -n 1)
[ -n "$SRC" ] || fail "Le téléchargement ne contient pas le logiciel."

# les composants sont téléchargés À CÔTÉ, avant de toucher au logiciel installé
step "Téléchargement des composants (une à deux minutes)"
(cd "$SRC" && npm install --omit=dev --no-audit --no-fund) && [ -d "$SRC/node_modules/express" ] \
  || fail "Les composants du logiciel n'ont pas pu être téléchargés : rien n'a été modifié. Vérifiez la connexion internet, puis relancez."

if [ -f "$DIR/data/garage.db" ]; then
  step "Sauvegarde de vos données"
  BACKUP="$DIR/sauvegardes/$(date +%Y-%m-%d_%H-%M-%S)"
  mkdir -p "$BACKUP" && cp "$DIR"/data/garage.db* "$BACKUP"/ && [ -s "$BACKUP/garage.db" ] \
    || fail "La sauvegarde a échoué : par sécurité, rien n'a été modifié. Vérifiez que le logiciel est fermé, puis relancez."
  # on garde les 10 dernières sauvegardes faites par cet installateur (les autres dossiers ne sont jamais touchés)
  ls -1d "$DIR"/sauvegardes/[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]_[0-9][0-9]-[0-9][0-9]-[0-9][0-9]/ 2>/dev/null | sort -r | tail -n +11 | while read -r old; do rm -rf "$old"; done
  echo "  Copie de la base enregistrée dans : $BACKUP"
fi

step "Installation des fichiers"
mkdir -p "$DIR/data"
# tout le logiciel, sauf les données, les réglages, les sauvegardes et les composants déjà installés
for item in "$SRC"/* "$SRC"/.[!.]*; do
  [ -e "$item" ] || continue
  case "$(basename "$item")" in data|node_modules|sauvegardes|.env|.git) continue ;; esac
  cp -R "$item" "$DIR"/ || fail "La copie des fichiers a échoué."
done
[ -f "$DIR/.env" ] || cp "$DIR/.env.example" "$DIR/.env"
chmod +x "$DIR"/*.command "$DIR"/installer-mac.sh 2>/dev/null

step "Installation des composants"
rm -rf "$DIR/node_modules.nouveau"
cp -R "$SRC/node_modules" "$DIR/node_modules.nouveau" && rm -rf "$DIR/node_modules" && mv "$DIR/node_modules.nouveau" "$DIR/node_modules" \
  || fail "Les fichiers du logiciel ont été mis à jour, mais ses composants n'ont pas pu être installés : le logiciel risque de ne pas démarrer. Relancez cette commande."

if [ -d "$HOME/Desktop" ]; then
  printf '#!/bin/bash\nexec "%s/demarrer-mac.command"\n' "$DIR" > "$HOME/Desktop/Garage Manager.command" && chmod +x "$HOME/Desktop/Garage Manager.command" && echo "  Raccourci « Garage Manager » créé sur le bureau."
fi

echo
echo "  $([ $UPDATE = 1 ] && echo 'Mise à jour terminée.' || echo 'Installation terminée.')"
echo "  Pour démarrer : double-cliquez sur « Garage Manager » sur le bureau (ou sur demarrer-mac.command dans $DIR)."
echo "  Pour mettre à jour plus tard : relancez la même commande."
