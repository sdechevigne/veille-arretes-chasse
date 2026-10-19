#!/usr/bin/env bash
# Essai du script lecture-nocturne.sh avec des doublures (faux opencode, faux npm, webhook local, dépôt git temporaire) :
# aucune vraie lecture, aucun appel Claude, rien hors du dossier temporaire. Lancer : bash scripts/tests/lecture-nocturne.test.sh
set -uo pipefail
SRC=$(cd "$(dirname "$0")/../.." && pwd)
RACINE=$(mktemp -d); trap 'kill $(cat "$RACINE/webhook.pid" 2>/dev/null) 2>/dev/null; rm -rf "$RACINE"' EXIT
ECHECS=0
ok() { echo "ok   - $1"; }
ko() { echo "ECHEC - $1"; ECHECS=$((ECHECS + 1)); }
verifie() { if eval "$2"; then ok "$1"; else ko "$1"; fi; }

# Webhook local : enregistre chaque corps reçu (une ligne JSON).
cat > "$RACINE/webhook.mjs" <<'JS'
import { createServer } from 'node:http'
import { appendFileSync, writeFileSync } from 'node:fs'
const [journal, fichierPort] = process.argv.slice(2)
const s = createServer((req, res) => { let c = ''; req.on('data', d => c += d).on('end', () => { appendFileSync(journal, c + '\n'); res.end('ok') }) })
s.listen(0, '127.0.0.1', () => writeFileSync(fichierPort, String(s.address().port)))
JS
node "$RACINE/webhook.mjs" "$RACINE/webhook.log" "$RACINE/webhook.port" & echo $! > "$RACINE/webhook.pid"
for _ in $(seq 50); do [ -s "$RACINE/webhook.port" ] && break; sleep 0.1; done
URL="http://127.0.0.1:$(cat "$RACINE/webhook.port")/hook"

# Faux opencode : mêmes règles d'authentification (Basic opencode:<mdp>), mode lu dans $HOME/fake-oc-mode (env -i : pas de variable).
cat > "$RACINE/fake-opencode" <<'JS'
#!/usr/bin/env node
import { createServer } from 'node:http'
import { readFileSync, writeFileSync } from 'node:fs'
const mode = (() => { try { return readFileSync(`${process.env.HOME}/fake-oc-mode`, 'utf8').trim() } catch { return 'normal' } })()
writeFileSync(`${process.env.HOME}/fake-oc-env`, Object.keys(process.env).sort().join(' '))
if (mode === 'meurt') process.exit(1)
if (mode === 'muet') setInterval(() => {}, 1000)
else {
  const port = +process.argv[process.argv.indexOf('--port') + 1]
  const attendu = 'Basic ' + Buffer.from(`opencode:${process.env.OPENCODE_SERVER_PASSWORD}`).toString('base64')
  createServer((req, res) => {
    if (req.headers.authorization !== attendu) { res.statusCode = 401; return res.end() }
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({ providers: [{ id: mode === 'sans-anthropic' ? 'opencode' : 'anthropic' }] }))
  }).listen(port, '127.0.0.1')
}
JS
chmod +x "$RACINE/fake-opencode"

# Faux npm : `ci` et `run … lire-claude|notifier`, comportements pilotés par FAKE_NPM_CI / FAKE_LIRE.
mkdir -p "$RACINE/bin"
cat > "$RACINE/bin/npm" <<'SH'
#!/usr/bin/env bash
case "$1" in
  ci) echo "ci $*" >> "$APPELS"; [ "${FAKE_NPM_CI:-}" = echec ] && exit 1; exit 0 ;;
  run)
    cmd=$5
    echo "$cmd $*" >> "$APPELS"
    if [ "$cmd" = lire-claude ]; then
      printf '%s' "$MANTA_WEBHOOK_SECRET" > "$APPELS.secret"
      [ -z "${VEILLE_OPENCODE_PASSWORD:-}" ] && echo "mot de passe opencode absent" >> "$APPELS.erreurs"
      case "${FAKE_LIRE:-calme}" in
        echec) echo "plantage" >&2; exit 1 ;;
        calme) echo '{"enAttente":0,"sansLecture":0,"erreurs":0,"arretQuota":false,"arretBudget":false}' ;;
        actif) echo '{"enAttente":2,"sansLecture":0,"erreurs":0,"arretQuota":false,"arretBudget":false}' ;;
        images) echo '{"enAttente":0,"sansLecture":0,"erreurs":0,"attenteImages":1,"arretQuota":false,"arretBudget":false}' ;;
      esac
    fi ;;
esac
SH
chmod +x "$RACINE/bin/npm"

# Faux curl : consigne ses arguments (pour vérifier qu'aucun identifiant n'y figure) puis appelle le vrai.
cat > "$RACINE/bin/curl" <<'SH'
#!/usr/bin/env bash
echo "$*" >> "$APPELS.curl"
exec /usr/bin/curl "$@"
SH
chmod +x "$RACINE/bin/curl"

# Scénario : prépare un dépôt « origin », un clone de déploiement (le script y est lancé), un HOME et un état neufs.
preparer() {
  local n=$1; D="$RACINE/$n"; mkdir -p "$D/home/.config/opencode/plugins" "$D/home/.local/share/opencode" "$D/etat"
  git init -q -b main "$D/origin" && mkdir -p "$D/origin/scripts" "$D/origin/opencode"
  cp "$SRC/scripts/lecture-nocturne.sh" "$SRC/scripts/notifier-echec.mjs" "$D/origin/scripts/"; cp "$SRC/opencode/opencode.jsonc" "$D/origin/opencode/"
  echo '{}' > "$D/origin/package-lock.json"
  git -C "$D/origin" add . && git -C "$D/origin" -c user.name=t -c user.email=t@t commit -q -m init
  git clone -q "$D/origin" "$D/robot"
  echo x > "$D/home/.config/opencode/plugins/manta-accounts.ts"; echo '{}' > "$D/home/.local/share/opencode/auth.json"
  # Valeur de secret avec métacaractères shell : doit être lue telle quelle.
  printf 'MANTA_WEBHOOK_URL=%s\nMANTA_WEBHOOK_SECRET=a$b"c d;e`f` \\g\n# commentaire\nligne invalide\n' "$URL" > "$D/secrets"
  : > "$RACINE/webhook.log"; rm -f "$RACINE/appels"*
}
lancer() {  # lancer <scénario> [VAR=val ...] ; code de sortie dans RC, sortie d'erreur dans $D/err
  local n=$1; shift
  env HOME="$D/home" PATH="$RACINE/bin:$PATH" USER=essai VEILLE_ETAT="$D/etat" VEILLE_SECRETS="${SECRETS_ESSAI:-$D/secrets}" \
    OPENCODE_BIN="$RACINE/fake-opencode" APPELS="$RACINE/appels" "$@" bash "$D/robot/scripts/lecture-nocturne.sh" > "$D/out" 2> "$D/err"
  RC=$?
}
dernier_webhook() { tail -n1 "$RACINE/webhook.log"; }

echo "# 1. passage calme : rien à notifier, code 0, secrets absents d'opencode, valeur à métacaractères préservée"
preparer calme; lancer calme FAKE_LIRE=calme
verifie "code 0" '[ "$RC" = 0 ]'
verifie "aucune notification" '[ ! -s "$RACINE/webhook.log" ]'
verifie "notifier non appelé" '! grep -q "^notifier" "$RACINE/appels" 2>/dev/null'
verifie "secret à métacaractères lu tel quel" '[ "$(cat "$RACINE/appels.secret")" = '"'"'a$b"c d;e`f` \g'"'"' ]'
verifie "environnement d'opencode sans secret ni MANTA" '! grep -qE "MANTA|SUPABASE|R2_" "$D/home/fake-oc-env"'
verifie "mot de passe transmis à lire-claude" '[ ! -e "$RACINE/appels.erreurs" ]'
verifie "ligne invalide signalée" 'grep -q "ligne ignorée" "$D/err"'
verifie "curl appelé, sans identifiants dans les arguments" '[ -s "$RACINE/appels.curl" ] && ! grep -qE "opencode:|[Pp]assword" "$RACINE/appels.curl"'
verifie "fichier de passage écrit" 'ls "$D"/etat/passages/*.json >/dev/null 2>&1'
verifie "npm ci sans scripts d'installation" 'grep -q "^ci ci --silent --ignore-scripts" "$RACINE/appels"'

echo "# 2. passage avec propositions : notifier appelé, code 0"
preparer actif; lancer actif FAKE_LIRE=actif
verifie "code 0" '[ "$RC" = 0 ]'
verifie "notifier appelé sur le fichier du passage" 'grep -q "^notifier .*--fichier .*passages/.*\.json" "$RACINE/appels"'

echo "# 2 bis. documents en attente d'images : notifier appelé"
preparer images; lancer images FAKE_LIRE=images
verifie "code 0" '[ "$RC" = 0 ]'
verifie "notifier appelé" 'grep -q "^notifier .*--fichier" "$RACINE/appels"'

echo "# 3. lire-claude plante : notification d'échec, code d'échec conservé"
preparer plantage; lancer plantage FAKE_LIRE=echec
verifie "code 1" '[ "$RC" = 1 ]'
verifie "webhook : passage en échec, étape lecture Claude" 'dernier_webhook | grep -q "passage nocturne en échec : lecture Claude (lire-claude a échoué) (code 1)"'
verifie "une seule notification" '[ "$(wc -l < "$RACINE/webhook.log")" = 1 ]'

echo "# 4. npm ci échoue : notification d'échec sans node_modules"
preparer npmci; lancer npmci FAKE_NPM_CI=echec
verifie "code 1" '[ "$RC" = 1 ]'
verifie "webhook : étape npm ci" 'dernier_webhook | grep -q "en échec : installation des dépendances (npm ci) (code 1)"'

echo "# 5. git fetch impossible : avertissement, la nuit continue"
preparer fetch; rm -rf "$D/origin"; lancer fetch FAKE_LIRE=calme
verifie "code 0" '[ "$RC" = 0 ]'
verifie "avertissement" 'grep -q "mise à jour du code impossible" "$D/err"'
verifie "lecture faite" 'grep -q "^lire-claude" "$RACINE/appels"'

echo "# 5 bis. git fetch bloqué : coupé par timeout 60, la nuit continue"
preparer fetchbloque
cat > "$RACINE/bin/timeout" <<'SH'
#!/usr/bin/env bash
echo "$1" > "$APPELS.timeout"; exit 124
SH
chmod +x "$RACINE/bin/timeout"; lancer fetchbloque FAKE_LIRE=calme; rm -f "$RACINE/bin/timeout"
verifie "code 0" '[ "$RC" = 0 ]'
verifie "fetch borné à 60 s" '[ "$(cat "$RACINE/appels.timeout" 2>/dev/null)" = 60 ]'
verifie "avertissement" 'grep -q "mise à jour du code impossible" "$D/err"'
verifie "lecture faite" 'grep -q "^lire-claude" "$RACINE/appels"'

echo "# 6. fournisseur anthropic absent"
preparer sansanth; echo sans-anthropic > "$D/home/fake-oc-mode"; lancer sansanth
verifie "code 1" '[ "$RC" = 1 ]'
verifie "webhook : contrôle du fournisseur" 'dernier_webhook | grep -q "en échec : contrôle du fournisseur anthropic"'
verifie "lire-claude non lancé" '! grep -q "^lire-claude" "$RACINE/appels" 2>/dev/null'

echo "# 7. opencode meurt au démarrage (sortie rapide, sans attendre le délai)"
preparer meurt; echo meurt > "$D/home/fake-oc-mode"; lancer meurt VEILLE_DELAI_PRET=60
verifie "code 1" '[ "$RC" = 1 ]'
verifie "message d'arrêt au démarrage" 'grep -q "arrêté au démarrage" "$D/err"'
verifie "webhook : démarrage d'opencode" 'dernier_webhook | grep -q "en échec : démarrage d'"'"'opencode"'

echo "# 8. opencode muet : délai borné par le temps écoulé, message cohérent"
preparer muet; echo muet > "$D/home/fake-oc-mode"; SECONDS=0; lancer muet VEILLE_DELAI_PRET=4
verifie "code 1" '[ "$RC" = 1 ]'
verifie "message avec le délai réel" 'grep -q "injoignable après 4 s" "$D/err"'
verifie "durée proche du délai (4 à 8 s)" '[ "$SECONDS" -ge 4 ] && [ "$SECONDS" -le 8 ]'
verifie "serveur arrêté à la sortie" '! pgrep -f "$RACINE/fake-opencode" >/dev/null'

echo "# 9. fichier de secrets absent : code 2, pas de notification possible"
preparer sanssecrets; SECRETS_ESSAI="$D/absent" lancer sanssecrets
verifie "code 2" '[ "$RC" = 2 ]'
verifie "aucune notification" '[ ! -s "$RACINE/webhook.log" ]'

echo; [ "$ECHECS" = 0 ] && echo "TOUT OK" || { echo "$ECHECS vérification(s) en échec"; exit 1; }
