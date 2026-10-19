#!/usr/bin/env bash
# Lecture Claude nocturne de la veille, sur la machine Manta : opencode isolé (rotation des sièges Claude par le plugin
# manta-accounts), lire-claude, notification, arrêt du serveur. Lancé par systemd (veille-arretes-lecture.timer).
set -euo pipefail
ROBOT=$(cd "$(dirname "$0")/.." && pwd)
ETAT=${VEILLE_ETAT:-$HOME/.local/state/veille-arretes}
SECRETS=${VEILLE_SECRETS:-$HOME/.config/veille-arretes/env}
OPENCODE_BIN=${OPENCODE_BIN:-$HOME/.opencode/bin/opencode}
[ -r "$SECRETS" ] || { echo "fichier de secrets absent : $SECRETS" >&2; exit 2; }

# Code à jour (clone de déploiement, avance rapide seulement) ; dépendances réinstallées si le verrou a changé.
git -C "$ROBOT" fetch -q origin main && git -C "$ROBOT" merge -q --ff-only origin/main
verrou=$(sha256sum "$ROBOT/package-lock.json" | cut -d' ' -f1)
[ "$(cat "$ETAT/verrou" 2>/dev/null)" = "$verrou" ] || { (cd "$ROBOT" && npm ci --silent); mkdir -p "$ETAT"; echo "$verrou" > "$ETAT/verrou"; }

OC=$ETAT/opencode
mkdir -p "$OC/config/opencode/plugins" "$OC/data/opencode" "$OC/state" "$OC/travail" "$ETAT/passages"
install -m 0644 "$ROBOT/opencode/opencode.jsonc" "$OC/config/opencode/opencode.jsonc"
install -m 0644 "$HOME/.config/opencode/plugins/manta-accounts.ts" "$OC/config/opencode/plugins/manta-accounts.ts"
ln -sfn "$HOME/.local/share/opencode/auth.json" "$OC/data/opencode/auth.json"

PORT=$(node -e "const s=require('net').createServer().listen(0,'127.0.0.1',()=>{console.log(s.address().port);s.close()})")
MDP=$(head -c 32 /dev/urandom | base64 | tr -dc 'A-Za-z0-9')
# Environnement minimal : aucun secret du robot dans le processus opencode.
(cd "$OC/travail" && exec env -i HOME="$HOME" PATH="$PATH" USER="$USER" LANG=C.UTF-8 \
  XDG_CONFIG_HOME="$OC/config" XDG_DATA_HOME="$OC/data" XDG_STATE_HOME="$OC/state" OPENCODE_SERVER_PASSWORD="$MDP" \
  "$OPENCODE_BIN" serve --port "$PORT" --hostname 127.0.0.1) >> "$ETAT/opencode.log" 2>&1 &
PID=$!
trap 'kill "$PID" 2>/dev/null || true; wait "$PID" 2>/dev/null || true' EXIT

pret=0
for _ in $(seq 60); do
  if curl -fsS -m 10 -o /dev/null -u "opencode:$MDP" "http://127.0.0.1:$PORT/config/providers"; then pret=1; break; fi
  sleep 1
done
[ "$pret" = 1 ] || { echo "opencode isolé injoignable après 60 s (voir $ETAT/opencode.log)" >&2; exit 1; }
curl -fsS -m 30 -u "opencode:$MDP" "http://127.0.0.1:$PORT/config/providers" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{if(!JSON.parse(s).providers.some(p=>p.id==="anthropic")){console.error("fournisseur anthropic absent (auth.json ?)");process.exit(1)}})'

set -a; . "$SECRETS"; set +a
export VEILLE_OPENCODE_URL="http://127.0.0.1:$PORT" VEILLE_OPENCODE_PASSWORD="$MDP"
SORTIE="$ETAT/passages/$(date -u +%Y%m%dT%H%M%SZ).json"
cd "$ROBOT"
# VEILLE_LIMITE / VEILLE_DEPARTEMENTS : essais ciblés (systemctl --user set-environment), défauts = passage normal.
npm run -s veille -- lire-claude --limite "${VEILLE_LIMITE:-40}" ${VEILLE_DEPARTEMENTS:+--departements "$VEILLE_DEPARTEMENTS"} --budget-min 150 --budget-tokens 2000000 > "$SORTIE"
a_notifier=$(node -e 'const s=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));console.log(s.enAttente>0||s.sansLecture>0||s.erreurs>0||s.arretQuota||s.arretBudget?"oui":"non")' "$SORTIE" 2>/dev/null || echo oui)
[ "$a_notifier" = oui ] && npm run -s veille -- notifier --fichier "$SORTIE" || true
find "$ETAT/passages" -name '*.json' -mtime +30 -delete
