#!/bin/sh
# Démarrage du conteneur Docker.
# Un disque de données monté par l'hébergeur (Render, NAS…) appartient souvent à l'administrateur (root) :
# on le confie d'abord à l'utilisateur « node », puis le logiciel démarre SANS les droits administrateur.
set -e
DIR="${DATA_DIR:-/app/data}"
if [ "$(id -u)" = "0" ]; then
  mkdir -p "$DIR"
  [ "$(stat -c %U "$DIR")" = node ] || chown -R node:node "$DIR"
  exec su node -s /bin/sh -c 'exec "$0" "$@"' "$@"
fi
exec "$@"
