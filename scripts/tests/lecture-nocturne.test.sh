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

# Faux opencode V2 : mêmes règles d'authentification (Basic opencode:<mdp>), mode lu dans $HOME/fake-oc-mode (env -i : pas
# de variable). Consigne le contenu de son dossier de plugins et la présence d'un auth.json dans ses données.
cat > "$RACINE/fake-opencode" <<'JS'
#!/usr/bin/env node
import { createServer } from 'node:http'
import { existsSync, lstatSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
const mode = (() => { try { return readFileSync(`${process.env.HOME}/fake-oc-mode`, 'utf8').trim() } catch { return 'normal' } })()
writeFileSync(`${process.env.HOME}/fake-oc-env`, Object.keys(process.env).sort().join(' '))
writeFileSync(`${process.env.HOME}/fake-oc-version`, process.env.ANTHROPIC_CLI_VERSION ?? '')
const plugins = `${process.env.XDG_CONFIG_HOME}/opencode/plugins`
writeFileSync(`${process.env.HOME}/fake-oc-plugins`, (existsSync(plugins) ? readdirSync(plugins, { recursive: true }).sort() : []).join('\n') + '\n')
const auth = `${process.env.XDG_DATA_HOME}/opencode/auth.json`
writeFileSync(`${process.env.HOME}/fake-oc-auth`, (() => { try { lstatSync(auth); return 'present' } catch { return 'absent' } })())
if (mode === 'meurt') process.exit(1)
if (mode === 'muet') setInterval(() => {}, 1000)
else {
  const port = +process.argv[process.argv.indexOf('--port') + 1]
  const attendu = 'Basic ' + Buffer.from(`opencode:${process.env.OPENCODE_SERVER_PASSWORD}`).toString('base64')
  let n = 0
  createServer((req, res) => {
    if (req.headers.authorization !== attendu) { res.statusCode = 401; return res.end() }
    // Ancienne route V1 : la V2 y sert l'application web (HTML, code 200).
    if (req.url !== '/api/provider') { res.setHeader('content-type', 'text/html'); return res.end('<!doctype html>') }
    res.setHeader('content-type', 'application/json')
    // « tardif » : registre des fournisseurs encore vide aux premières requêtes (démarrage réel de la V2).
    const pret = mode !== 'sans-anthropic' && !(mode === 'tardif' && ++n <= 2)
    const data = pret ? [{ id: 'anthropic', activation: 'enabled' }, { id: 'opencode', activation: 'enabled' }] : mode === 'sans-anthropic' ? [{ id: 'opencode', activation: 'enabled' }] : []
    res.end(JSON.stringify({ location: { directory: process.cwd() }, data }))
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

# Faux systemctl : environnement de l'unité opencode-serve (FAKE_SYSTEMCTL : normal / sans-version / echec), avec un secret
# voisin qui ne doit jamais atteindre opencode ni la sortie du script.
cat > "$RACINE/bin/systemctl" <<'SH'
#!/usr/bin/env bash
echo "$*" >> "$APPELS.systemctl"
case "${FAKE_SYSTEMCTL:-normal}" in
  normal) echo "OPENCODE_PASSWORD=secret-voisin ANTHROPIC_CLI_VERSION=2.1.283 PATH=/usr/bin" ;;
  sans-version) echo "OPENCODE_PASSWORD=secret-voisin PATH=/usr/bin" ;;
  echec) exit 1 ;;
esac
SH
chmod +x "$RACINE/bin/systemctl"

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
  # Plugins de l'opencode principal (dossiers V2) : seul manta-claude-max doit être copié.
  mkdir -p "$D/home/.config/opencode/plugins/manta-claude-max/lib" "$D/home/.config/opencode/plugins/manta" "$D/home/.config/opencode/plugins/manta-optimizer"
  echo x > "$D/home/.config/opencode/plugins/manta-claude-max/index.ts"; echo x > "$D/home/.config/opencode/plugins/manta-claude-max/lib/seats.ts"
  echo x > "$D/home/.config/opencode/plugins/manta/index.ts"; echo '{}' > "$D/home/.local/share/opencode/auth.json"
  # Reliquats d'un passage V1 dans l'état : ancien plugin manta-accounts.ts et lien auth.json, à retirer.
  mkdir -p "$D/etat/opencode/config/opencode/plugins" "$D/etat/opencode/data/opencode"
  echo x > "$D/etat/opencode/config/opencode/plugins/manta-accounts.ts"; ln -s "$D/home/.local/share/opencode/auth.json" "$D/etat/opencode/data/opencode/auth.json"
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
verifie "version Claude lue dans l'environnement de l'unité opencode-serve" 'grep -q -- "--user show opencode-serve -p Environment --value" "$RACINE/appels.systemctl"'
verifie "version Claude transmise à opencode" '[ "$(cat "$D/home/fake-oc-version")" = 2.1.283 ]'
verifie "plugins d'opencode : manta-claude-max seul, copié en entier" '[ "$(cat "$D/home/fake-oc-plugins")" = "$(printf "manta-claude-max\nmanta-claude-max/index.ts\nmanta-claude-max/lib\nmanta-claude-max/lib/seats.ts\n")" ]'
verifie "mises à jour automatiques d'opencode coupées" 'grep -qw OPENCODE_DISABLE_AUTOUPDATE "$D/home/fake-oc-env"'
verifie "lien auth.json d'opencode retiré" '[ "$(cat "$D/home/fake-oc-auth")" = absent ]'
verifie "contrôle du fournisseur par la route V2" 'grep -q "/api/provider" "$RACINE/appels.curl" && ! grep -q "/config/providers" "$RACINE/appels.curl"'
verifie "secret voisin de l'unité absent d'opencode et de la sortie" '! grep -q "OPENCODE_PASSWORD" "$D/home/fake-oc-env" && ! grep -q "secret-voisin" "$D/err" "$D/out"'

echo "# 1 bis. version Claude absente de l'unité (ou systemctl en échec) : avertissement, lancement sans"
for mode in sans-version echec; do
  preparer "version-$mode"; lancer "version-$mode" FAKE_LIRE=calme FAKE_SYSTEMCTL=$mode
  verifie "$mode : code 0" '[ "$RC" = 0 ]'
  verifie "$mode : avertissement" 'grep -q "ANTHROPIC_CLI_VERSION absente" "$D/err"'
  verifie "$mode : opencode lancé sans version" '[ -e "$D/home/fake-oc-version" ] && [ ! -s "$D/home/fake-oc-version" ]'
done

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

echo "# 5 ter. origin a un commit plus récent qui modifie le script : relance une fois, la NOUVELLE logique s'exécute, pas de boucle"
preparer relance
sed -i 's|^set -euo pipefail$|set -euo pipefail\necho "nouvelle logique (REEXEC=${VEILLE_REEXEC:-})" >> "$APPELS.marqueur"|' "$D/origin/scripts/lecture-nocturne.sh"
# Lignes insérées AU-DESSUS du bloc de mise à jour (décalage des octets) : le nouveau script ne doit pas être lu à l'ancien offset.
sed -i '/^# Code à jour/i # décalage 1 : ligne ajoutée pour déplacer les octets du fichier, bien au-dessus du bloc de mise à jour\n# décalage 2 : encore une ligne de commentaire plus longue que la précédente pour être certain de désaligner la lecture\nENTETE_AJOUTEE=1' "$D/origin/scripts/lecture-nocturne.sh"
git -C "$D/origin" -c user.name=t -c user.email=t@t commit -q -am "script modifié"
lancer relance FAKE_LIRE=calme
verifie "code 0" '[ "$RC" = 0 ]'
verifie "nouvelle logique exécutée une seule fois, après relance" '[ "$(cat "$RACINE/appels.marqueur" 2>/dev/null)" = "nouvelle logique (REEXEC=1)" ]'
verifie "relance signalée" 'grep -q "relance du script" "$D/err"'
verifie "lecture faite une seule fois" '[ "$(grep -c "^lire-claude" "$RACINE/appels")" = 1 ]'

echo "# 6. fournisseur anthropic jamais activé (plugin inopérant) : échec au bout du délai, message clair"
preparer sansanth; echo sans-anthropic > "$D/home/fake-oc-mode"; lancer sansanth VEILLE_DELAI_PRET=3
verifie "code 1" '[ "$RC" = 1 ]'
verifie "message clair" 'grep -q "fournisseur anthropic absent" "$D/err"'
verifie "webhook : contrôle du fournisseur" 'dernier_webhook | grep -q "en échec : contrôle du fournisseur anthropic"'
verifie "lire-claude non lancé" '! grep -q "^lire-claude" "$RACINE/appels" 2>/dev/null'

echo "# 6 bis. fournisseur anthropic activé après quelques secondes (registre en construction) : passage normal"
preparer tardif; echo tardif > "$D/home/fake-oc-mode"; lancer tardif FAKE_LIRE=calme
verifie "code 0" '[ "$RC" = 0 ]'
verifie "lecture faite" 'grep -q "^lire-claude" "$RACINE/appels"'

echo "# 6 ter. plugin manta-claude-max absent de l'opencode principal : échec clair avant tout lancement"
preparer sansplugin; rm -rf "$D/home/.config/opencode/plugins/manta-claude-max"; lancer sansplugin
verifie "code 1" '[ "$RC" = 1 ]'
verifie "message clair" 'grep -q "plugin manta-claude-max introuvable" "$D/err"'
verifie "webhook : préparation d'opencode" 'dernier_webhook | grep -q "en échec : préparation d'"'"'opencode"'
verifie "opencode non lancé" '[ ! -e "$D/home/fake-oc-env" ]'

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
