#!/bin/bash
# Rend le logiciel joignable en https depuis VOS appareils seulement (réseau privé Tailscale),
# au garage comme en 4G. Rien n'est ouvert sur internet.
cd "$(dirname "$0")"
pause() { read -r -p "Appuyez sur Entrée pour fermer…"; }

TS=""
for c in tailscale /usr/local/bin/tailscale /Applications/Tailscale.app/Contents/MacOS/Tailscale; do
  if command -v "$c" >/dev/null 2>&1; then TS="$(command -v "$c")"; break; fi
done
if [ -z "$TS" ]; then
  echo "Tailscale n'est pas installé sur ce Mac."
  echo "  1. Installez-le : https://tailscale.com/download/mac"
  echo "  2. Connectez-vous (icône Tailscale dans la barre des menus)"
  echo "  3. Relancez ce fichier."
  open https://tailscale.com/download/mac
  pause; exit 1
fi

if ! curl -fs -m 3 http://localhost:3000/app-info.json >/dev/null; then
  echo "Le logiciel ne répond pas sur http://localhost:3000"
  echo "Lancez d'abord demarrer-mac.command, laissez la fenêtre ouverte, puis relancez ce fichier."
  pause; exit 1
fi

echo "Activation de l'adresse sécurisée https…"
echo "Si un lien s'affiche, ouvrez-le pour accepter l'activation de HTTPS, puis revenez ici."
if ! "$TS" serve --bg 3000; then
  echo
  echo "Tailscale n'a pas pu activer l'adresse https."
  echo "Vérifiez que Tailscale est connecté, puis sur https://login.tailscale.com/admin/dns"
  echo "activez « MagicDNS » et « HTTPS Certificates ». Relancez ensuite ce fichier."
  pause; exit 1
fi

JSON="$("$TS" status --json)"
NAME="$(osascript -l JavaScript -e 'function run(a) { return JSON.parse(a[0]).Self.DNSName.replace(/\.$/, "") }' "$JSON" 2>/dev/null)"
# Secours : le premier « DNSName » du JSON est celui de cet ordinateur (« Self » vient avant les autres appareils)
[ -n "$NAME" ] || NAME="$(printf '%s\n' "$JSON" | sed -n 's/.*"DNSName": *"\([^"]*\)".*/\1/p' | head -1 | sed 's/\.$//')"
if [ -z "$NAME" ]; then
  echo "L'adresse https n'a pas pu être lue. Pour l'afficher : \"$TS\" serve status"
  pause; exit 1
fi
URL="https://$NAME"

echo
echo "=============================================================="
echo "  Adresse sécurisée : $URL"
echo "=============================================================="
echo
echo "Sur chaque téléphone :"
echo "  1. Installez l'application Tailscale (App Store / Google Play)"
echo "  2. Connectez-vous avec le MÊME compte que sur ce Mac"
echo "  3. Ouvrez l'adresse ci-dessus, ou scannez le QR code :"
echo "     logiciel → menu du compte → « Sur téléphone / tablette »"
echo
echo "Ce réglage reste actif après un redémarrage du Mac."
echo "Pour l'arrêter : \"$TS\" serve --https=443 off"
open "$URL"
pause
