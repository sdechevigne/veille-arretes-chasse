#!/usr/bin/env bash
# Lecture Claude nocturne de la veille, sur la machine Manta : opencode isolé (rotation des sièges Claude par le plugin
# manta-accounts), lire-claude, notification, arrêt du serveur. Lancé par systemd (veille-arretes-lecture.timer).
# Un passage en échec (quelle que soit l'étape) est notifié, puis le script sort avec le code d'échec (visible dans systemd).
set -euo pipefail
ROBOT=$(cd "$(dirname "$0")/.." && pwd)
ETAT=${VEILLE_ETAT:-$HOME/.local/state/veille-arretes}
SECRETS=${VEILLE_SECRETS:-$HOME/.config/veille-arretes/env}
OPENCODE_BIN=${OPENCODE_BIN:-$HOME/.opencode/bin/opencode}
DELAI_PRET=${VEILLE_DELAI_PRET:-180}
[ -r "$SECRETS" ] || { echo "fichier de secrets absent : $SECRETS" >&2; exit 2; }

# Secrets du robot : lecture NOM=valeur ligne à ligne, SANS interprétation par le shell (pas d'eval, pas de « . »), valeur
# prise telle quelle jusqu'à la fin de la ligne (aucun guillemet à ajouter). Appelée seulement avant les étapes du robot
# qui en ont besoin (jamais avant npm ci) ; opencode, lui, est lancé par env -i et n'en reçoit aucun.
charger_secrets() {
  local ligne cle
  while IFS= read -r ligne || [ -n "$ligne" ]; do
    ligne=${ligne%$'\r'}
    case $ligne in '' | '#'*) continue ;; esac
    cle=${ligne%%=*}
    if [[ $ligne == *=* && $cle =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]]; then export "$cle=${ligne#*=}"
    else echo "ligne ignorée dans $SECRETS (format NOM=valeur attendu)" >&2; fi
  done < "$SECRETS"
}

# Sortie du script : arrête opencode ; si le passage a échoué sans avoir été notifié, prévient (texte fixe, aucun secret).
# La notification d'échec n'utilise que node (scripts/notifier-echec.mjs) : elle marche même si npm ci a échoué.
ETAPE="démarrage"; NOTIFIE=0; PID=""
fin() {
  local rc=$?
  trap - EXIT
  if [ -n "$PID" ]; then kill "$PID" 2>/dev/null || true; wait "$PID" 2>/dev/null || true; fi
  if [ "$rc" -ne 0 ] && [ "$NOTIFIE" != 1 ]; then
    echo "passage nocturne en échec (code $rc) à l'étape : $ETAPE" >&2
    (charger_secrets; node "$ROBOT/scripts/notifier-echec.mjs" "Veille arrêtés : passage nocturne en échec : $ETAPE (code $rc)") || true
  fi
  exit "$rc"
}
trap fin EXIT
trap 'exit 143' TERM INT   # arrêt par systemd (délai dépassé) : passe aussi par fin()

# Code à jour (clone de déploiement, avance rapide seulement). Une panne réseau ou un clone divergé ne coupe pas la nuit :
# on lit avec le code déjà présent. Dépendances réinstallées si le verrou a changé.
ETAPE="mise à jour du code"
if ! { git -C "$ROBOT" fetch -q origin main && git -C "$ROBOT" merge -q --ff-only origin/main; }; then
  echo "avertissement : mise à jour du code impossible, passage avec le code déjà présent" >&2
fi
ETAPE="installation des dépendances (npm ci)"
mkdir -p "$ETAT"
verrou=$(sha256sum "$ROBOT/package-lock.json" | cut -d' ' -f1)
if [ "$(cat "$ETAT/verrou" 2>/dev/null)" != "$verrou" ]; then
  (cd "$ROBOT" && npm ci --silent)
  echo "$verrou" > "$ETAT/verrou"
fi

ETAPE="préparation d'opencode"
OC=$ETAT/opencode
mkdir -p "$OC/config/opencode/plugins" "$OC/data/opencode" "$OC/state" "$OC/travail" "$ETAT/passages"
install -m 0644 "$ROBOT/opencode/opencode.jsonc" "$OC/config/opencode/opencode.jsonc"
install -m 0644 "$HOME/.config/opencode/plugins/manta-accounts.ts" "$OC/config/opencode/plugins/manta-accounts.ts"
ln -sfn "$HOME/.local/share/opencode/auth.json" "$OC/data/opencode/auth.json"

PORT=$(node -e "const s=require('net').createServer().listen(0,'127.0.0.1',()=>{console.log(s.address().port);s.close()})")
MDP=$(head -c 32 /dev/urandom | base64 | tr -dc 'A-Za-z0-9')
# curl avec les identifiants d'opencode lus sur l'entrée standard (-K -) : le mot de passe n'apparaît dans aucun argument.
curl_oc() { printf 'user = "opencode:%s"\n' "$MDP" | curl -fsS -K - "$@"; }

ETAPE="démarrage d'opencode"
# Environnement minimal : aucun secret du robot dans le processus opencode.
(cd "$OC/travail" && exec env -i HOME="$HOME" PATH="$PATH" USER="$USER" LANG=C.UTF-8 \
  XDG_CONFIG_HOME="$OC/config" XDG_DATA_HOME="$OC/data" XDG_STATE_HOME="$OC/state" OPENCODE_SERVER_PASSWORD="$MDP" \
  "$OPENCODE_BIN" serve --port "$PORT" --hostname 127.0.0.1) >> "$ETAT/opencode.log" 2>&1 &
PID=$!

# Attente bornée par le temps écoulé (le premier démarrage télécharge le plugin d'authentification Claude).
pret=0; debut=$SECONDS
while [ $((SECONDS - debut)) -lt "$DELAI_PRET" ]; do
  if curl_oc -m 10 -o /dev/null "http://127.0.0.1:$PORT/config/providers"; then pret=1; break; fi
  kill -0 "$PID" 2>/dev/null || { echo "opencode isolé arrêté au démarrage (voir $ETAT/opencode.log)" >&2; exit 1; }
  sleep 1
done
[ "$pret" = 1 ] || { echo "opencode isolé injoignable après $DELAI_PRET s (voir $ETAT/opencode.log)" >&2; exit 1; }
ETAPE="contrôle du fournisseur anthropic"
curl_oc -m 30 "http://127.0.0.1:$PORT/config/providers" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{if(!JSON.parse(s).providers.some(p=>p.id==="anthropic")){console.error("fournisseur anthropic absent (auth.json ?)");process.exit(1)}})'

ETAPE="lecture Claude"
charger_secrets
export VEILLE_OPENCODE_URL="http://127.0.0.1:$PORT" VEILLE_OPENCODE_PASSWORD="$MDP"
SORTIE="$ETAT/passages/$(date -u +%Y%m%dT%H%M%SZ).json"
cd "$ROBOT"
# VEILLE_LIMITE / VEILLE_DEPARTEMENTS : essais ciblés (systemctl --user set-environment), défauts = passage normal.
rc=0
npm run -s veille -- lire-claude --limite "${VEILLE_LIMITE:-40}" ${VEILLE_DEPARTEMENTS:+--departements "$VEILLE_DEPARTEMENTS"} --budget-min 150 --budget-tokens 2000000 > "$SORTIE" || rc=$?
if [ "$rc" -eq 0 ]; then
  # Notification de fin de lecture ; un fichier illisible donne « résultat illisible » (jamais le silence).
  NOTIFIE=1
  a_notifier=$(node -e 'const s=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));console.log(s.enAttente>0||s.sansLecture>0||s.erreurs>0||s.arretQuota||s.arretBudget?"oui":"non")' "$SORTIE" 2>/dev/null || echo oui)
  if [ "$a_notifier" = oui ]; then npm run -s veille -- notifier --fichier "$SORTIE" || true; fi
else
  # lire-claude a planté : le passage est notifié en échec par fin(), le code d'échec est conservé pour systemd.
  echo "lire-claude a échoué (code $rc)" >&2
  ETAPE="lecture Claude (lire-claude a échoué)"
fi
find "$ETAT/passages" -name '*.json' -mtime +30 -delete || true
exit "$rc"
