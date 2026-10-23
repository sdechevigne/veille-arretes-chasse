#!/usr/bin/env bash
# Lecture Claude nocturne de la veille, sur la machine Manta : opencode V2 isolé (abonnement Claude et rotation des sièges
# par le plugin manta-claude-max), lire-claude, notification, arrêt du serveur. Lancé par systemd (veille-arretes-lecture.timer).
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

# Code à jour (clone de déploiement, avance rapide seulement). Une panne réseau (fetch borné à 60 s) ou un clone divergé ne
# coupe pas la nuit : on lit avec le code déjà présent. Dépendances réinstallées si le verrou a changé, sans script
# d'installation (aucun code de paquet exécuté à l'installation ; tsx / esbuild fonctionnent sans, vérifié sur vm-test).
ETAPE="mise à jour du code"
# L'avance rapide peut réécrire CE script pendant que bash le lit (par décalage d'octets) : la suite s'exécuterait alors avec un
# mélange d'ancienne et de nouvelle logique. Si HEAD a changé, on relance donc une fois le script (nouveau) depuis le début ;
# VEILLE_REEXEC empêche toute boucle. Tout le bloc ci-dessous (relevé de HEAD, mise à jour, comparaison, relance) est UN SEUL
# groupe « { … } » : bash le lit en entier avant d'en exécuter la moindre ligne, donc rien n'est relu dans le fichier modifié.
# Aucun effet de bord n'a eu lieu avant ce bloc.
{
  avant=$(git -C "$ROBOT" rev-parse HEAD 2>/dev/null || true)
  if ! { timeout 60 git -C "$ROBOT" fetch -q origin main && git -C "$ROBOT" merge -q --ff-only origin/main; }; then
    echo "avertissement : mise à jour du code impossible, passage avec le code déjà présent" >&2
  fi
  apres=$(git -C "$ROBOT" rev-parse HEAD 2>/dev/null || true)
  if [ "$avant" != "$apres" ] && [ -z "${VEILLE_REEXEC:-}" ]; then
    echo "code mis à jour ($avant -> $apres) : relance du script" >&2
    VEILLE_REEXEC=1 exec "$0" "$@"
  fi
}
ETAPE="installation des dépendances (npm ci)"
mkdir -p "$ETAT"
verrou=$(sha256sum "$ROBOT/package-lock.json" | cut -d' ' -f1)
if [ "$(cat "$ETAT/verrou" 2>/dev/null)" != "$verrou" ]; then
  (cd "$ROBOT" && npm ci --silent --ignore-scripts)
  echo "$verrou" > "$ETAT/verrou"
fi

ETAPE="préparation d'opencode"
OC=$ETAT/opencode
# Seul plugin Manta de l'instance : le dossier manta-claude-max de l'opencode principal (fournisseur anthropic sur
# l'abonnement, identité Claude Code, siège Manta par conversation), recopié en entier à chaque passage. Il trouve seul,
# par HOME, le jeton de manta-server (~/.manta/auth.json), les sièges (~/.manta-secrets/accounts) et la connexion Claude
# (~/.claude/.credentials.json) : rien d'autre à transmettre. Le dossier des plugins est refait à neuf (aucun reliquat,
# ni manta ni manta-optimizer) ; l'ancien lien vers auth.json d'opencode (V1) ne sert plus.
PLUGIN=$HOME/.config/opencode/plugins/manta-claude-max
[ -f "$PLUGIN/index.ts" ] || { echo "plugin manta-claude-max introuvable : $PLUGIN (mise à jour de Manta ?)" >&2; exit 1; }
rm -rf "$OC/config/opencode/plugins"
mkdir -p "$OC/config/opencode/plugins" "$OC/data/opencode" "$OC/state" "$OC/travail" "$ETAT/passages"
rm -f "$OC/data/opencode/auth.json"
install -m 0644 "$ROBOT/opencode/opencode.jsonc" "$OC/config/opencode/opencode.jsonc"
cp -R "$PLUGIN" "$OC/config/opencode/plugins/manta-claude-max"

PORT=$(node -e "const s=require('net').createServer().listen(0,'127.0.0.1',()=>{console.log(s.address().port);s.close()})")
MDP=$(head -c 32 /dev/urandom | base64 | tr -dc 'A-Za-z0-9')
# curl avec les identifiants d'opencode lus sur l'entrée standard (-K -) : le mot de passe n'apparaît dans aucun argument.
curl_oc() { printf 'user = "opencode:%s"\n' "$MDP" | curl -fsS -K - "$@"; }

ETAPE="démarrage d'opencode"
# Version de la CLI Claude annoncée par le plugin manta-claude-max : source unique = valeur effective de l'unité opencode-serve
# (l'opencode principal), sinon le plugin envoie sa valeur intégrée, refusée par les modèles récents. Seule cette variable est
# extraite de l'environnement de l'unité (qui porte aussi des secrets) ; absente → avertissement et lancement sans.
VERSION_CLI=$(systemctl --user show opencode-serve -p Environment --value 2>/dev/null | tr ' ' '\n' | sed -n 's/^ANTHROPIC_CLI_VERSION=//p' | tail -n1 || true)
if [[ $VERSION_CLI =~ ^[0-9]+(\.[0-9]+)*$ ]]; then VERSION_ENV=(ANTHROPIC_CLI_VERSION="$VERSION_CLI")
else VERSION_ENV=(); echo "avertissement : ANTHROPIC_CLI_VERSION absente de l'unité opencode-serve, opencode isolé lancé sans" >&2; fi
# Environnement minimal : aucun secret du robot dans le processus opencode ; mises à jour automatiques coupées (comme l'unité
# opencode-serve), en plus de « update »: « disable » dans opencode.jsonc.
(cd "$OC/travail" && exec env -i HOME="$HOME" PATH="$PATH" USER="$USER" LANG=C.UTF-8 OPENCODE_DISABLE_AUTOUPDATE=1 "${VERSION_ENV[@]}" \
  XDG_CONFIG_HOME="$OC/config" XDG_DATA_HOME="$OC/data" XDG_STATE_HOME="$OC/state" OPENCODE_SERVER_PASSWORD="$MDP" \
  "$OPENCODE_BIN" serve --port "$PORT" --hostname 127.0.0.1) >> "$ETAT/opencode.log" 2>&1 &
PID=$!

# Attente bornée par le temps écoulé : serveur joignable PUIS fournisseur anthropic activé par le plugin (le registre des
# fournisseurs se construit quelques secondes après l'ouverture du port : liste d'abord vide).
anthropic_actif() { node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{let ok=false;try{ok=JSON.parse(s).data.some(p=>p.id==="anthropic"&&p.activation==="enabled")}catch{}process.exit(ok?0:1)})'; }
pret=0; joint=0; debut=$SECONDS
while [ $((SECONDS - debut)) -lt "$DELAI_PRET" ]; do
  if fournisseurs=$(curl_oc -m 10 "http://127.0.0.1:$PORT/api/provider"); then
    joint=1; ETAPE="contrôle du fournisseur anthropic"
    if printf '%s' "$fournisseurs" | anthropic_actif; then pret=1; break; fi
  fi
  kill -0 "$PID" 2>/dev/null || { echo "opencode isolé arrêté au démarrage (voir $ETAT/opencode.log)" >&2; exit 1; }
  sleep 1
done
if [ "$pret" != 1 ]; then
  if [ "$joint" = 1 ]; then echo "fournisseur anthropic absent après $DELAI_PRET s (plugin manta-claude-max inopérant ? voir $ETAT/opencode.log)" >&2
  else echo "opencode isolé injoignable après $DELAI_PRET s (voir $ETAT/opencode.log)" >&2; fi
  exit 1
fi

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
  a_notifier=$(node -e 'const s=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));console.log(s.enAttente>0||s.sansLecture>0||s.erreurs>0||s.attenteImages>0||s.arretQuota||s.arretBudget?"oui":"non")' "$SORTIE" 2>/dev/null || echo oui)
  if [ "$a_notifier" = oui ]; then npm run -s veille -- notifier --fichier "$SORTIE" || true; fi
else
  # lire-claude a planté : le passage est notifié en échec par fin(), le code d'échec est conservé pour systemd.
  echo "lire-claude a échoué (code $rc)" >&2
  ETAPE="lecture Claude (lire-claude a échoué)"
fi
find "$ETAT/passages" -name '*.json' -mtime +30 -delete || true
exit "$rc"
