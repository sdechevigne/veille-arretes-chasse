# veille-arretes-chasse

Veille automatique des arrêtés préfectoraux de chasse pour Mes Chasses.

## Fonctionnement

1. **Collecte** : parcours des pages officielles (préfectures, recueils des actes administratifs, fédérations de chasseurs) pour repérer les documents publiés.
2. **Empreinte** : chaque document téléchargé reçoit une empreinte SHA-256 ; un document déjà connu n'est pas retraité.
3. **Archive** : l'original est conservé dans un stockage objet (R2) sous une clé stable.
4. **Lecture mécanique** : extraction du texte (natif ou OCR), détection du type d'acte, de la saison, du numéro et de la date.
5. **File à lire** : les documents pertinents sont déposés dans une file de relecture ; les autres sont ignorés avec leur motif.
6. **Lecture Claude** : chaque document de la file est lu par Claude, via un opencode V2 local isolé de la machine Manta (abonnement Claude et rotation des sièges par le plugin `manta-claude-max`) lancé la nuit par `scripts/lecture-nocturne.sh`, à partir d'un dossier minimal ; la proposition est contrôlée puis décidée en base (publiée, publiée avec note ou en attente de vérification). Contrôle des preuves aiguillé selon la page en échec : texte natif → une relance Opus au plus par document ; page scannée (OCR) → relecture Sonnet sur l'image de la page (une seconde seulement si la première diffère de la lecture texte) ; pages OCR signalées illisibles par Claude relues de même. Arrêt propre au quota de l'abonnement ou au budget de tokens du passage.
7. **Notification** : un webhook Manta signé (HMAC-SHA256) signale les propositions à vérifier et l'arrêt au quota ou au budget de tokens ; le lundi, un bilan hebdomadaire.

## Commandes

```bash
npm ci
npm run veille       # lance le robot (src/cli.ts)
npm test             # tests unitaires (Vitest)
npm run typecheck    # vérification des types
```

Commandes du robot (`npm run -s veille -- <commande>` ; `-s` retire l'en-tête de npm quand on lit le JSON produit) :

- `collecter [--departements 24,50] [--sans-proxy] [--sortie-france] [--budget-min N]` : collecte des documents. Sans proxy, les sources `.gouv.fr` sont écartées ; `--sortie-france` (posé par le workflow une fois la sortie hide.me vérifiée en France) les rétablit en trafic direct ; `--sans-proxy` explicite reste prioritaire.
- `lire [--limite N] [--budget-min N]` : lecture mécanique (texte, type, saison) ; dépose aussi dans R2 le PNG des pages scannées retenues (`<sha256>.page-<n>.png`), relu par le contrôle C1 de `lire-claude` (la machine de lecture Claude n'a pas poppler).
- `images-pages [--limite N] [--budget-min N]` : rattrapage des images manquantes des documents déjà `a_lire` (`--limite` compte les documents traités), lancé **chaque jour** par le workflow (job `images`, budget 40 min), indépendamment du rythme de collecte : un rattrapage coupé par son budget reprend le lendemain ; JSON `{ documents, images, erreurs, sortis }`, code 0 même si un document échoue : une panne passagère (R2, délai, pdftoppm impossible à lancer ou tué, disque plein) compte dans `erreurs` et le document est repris le lendemain ; un rendu impossible (pdftoppm a tourné et sort avec un code non nul : page hors du PDF, PDF corrompu) le sort de la file (`en_attente`, motif « image de la page N impossible à produire : … », à traiter à la main), compté dans `sortis`.
- `lire-claude [--limite N] [--budget-min N] [--budget-tokens N] [--departements 24,50]` : lecture Claude de la file ; statistiques JSON seules sur la sortie standard (journal sur la sortie d'erreur), tokens détaillés (`input`, `output`, `cache_creation`, `cache_read`), code 0 même à l'arrêt au quota (`arretQuota`) ou au budget de tokens (`arretBudget` : tous compteurs confondus, vérifié avant chaque document ; `scripts/lecture-nocturne.sh` passe 2 000 000).
- `dossier --id <uuid>` : affiche le dossier qui serait envoyé à Claude pour un document (mode, estimation de tokens, texte), sans appel Claude.
- `notifier --fichier lecture-claude.json` : notification Manta des propositions à vérifier (ignorée sans webhook configuré) ; appelée par `scripts/lecture-nocturne.sh` après `lire-claude`, plus par le workflow.
- `sante` : sources en panne et documents des 7 derniers jours.
- `bilan [--notifier] [--etat etat/dernier-bilan.json]` : bilan des 7 derniers jours (documents, propositions par décision, tokens consommés), en comptes uniquement ; `--etat` écrit le fichier commité chaque lundi. La couverture des départements sans arrêté annuel en campagne n'est pas encore calculée.
- `amorcer [--fichier arretes.json]` : SQL d'amorçage des sources.

## Secrets attendus (variables d'environnement, valeurs jamais commitées)

- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `R2_ACCOUNT_ID`
- `R2_ACCESS_KEY_ID`
- `R2_SECRET_ACCESS_KEY`
- `R2_VEILLE_BUCKET`
- `VEILLE_PROXY_URL` (optionnel, secours) : proxy HTTP français, lu seulement quand la sortie hide.me n'est pas active (lancement manuel sans compte hide.me). Il ne conditionne plus le cron.
- `HIDEME_USER`, `HIDEME_PASSWORD` : compte hide.me (formule gratuite, serveur `free-fr.hideservers.net`), utilisés par le workflow pour sortir par la France. Sans `HIDEME_USER`, le cron est suspendu ; le lancement manuel reste possible.
- `VEILLE_OPENCODE_URL`, `VEILLE_OPENCODE_PASSWORD` (mot de passe facultatif) : adresse et accès de l'opencode local utilisé par `lire-claude` ; posés par `scripts/lecture-nocturne.sh`, jamais à la main. Sans URL, `lire-claude` s'arrête (code 2).
- `MANTA_WEBHOOK_URL`, `MANTA_WEBHOOK_SECRET` (optionnels) : webhook de notification et sa clé de signature ; absents, les notifications sont ignorées. Sur la machine Manta, le fichier de secrets porte l'adresse locale `http://127.0.0.1:8787/hook/<jeton>` (la machine se notifie elle-même, sans passer par Internet) ; GitHub garde l'adresse publique, pour le bilan hebdomadaire.

## Lecture nocturne sur la machine Manta

Chaque nuit à 02:30 (Paris), `scripts/lecture-nocturne.sh` lit la file avec Claude : il met le code à jour (`git fetch`, borné à 60 s, + avance rapide seulement ; si le réseau ou le clone l'empêche, il continue avec le code présent et le signale sur la sortie d'erreur), réinstalle les dépendances si le verrou a changé (`npm ci --ignore-scripts` : aucun script d'installation de paquet n'est exécuté), lance un opencode V2 isolé (port libre, mot de passe aléatoire transmis à `curl` par `-K -` et non en argument, dossier de travail vide, environnement minimal sans aucun secret du robot, configuration `opencode/opencode.jsonc` ; seule la version de la CLI Claude `ANTHROPIC_CLI_VERSION` est reprise de l'environnement effectif de l'unité `opencode-serve`, sans quoi le plugin `manta-claude-max` annonce sa version intégrée, refusée par les modèles récents — absente, avertissement et lancement sans), exécute `lire-claude` puis `notifier` si besoin (propositions à vérifier, documents sans lecture, en erreur ou en attente d'images de pages, arrêt au quota ou au budget), et arrête opencode. Un document dont une page scannée (OCR ou OCR en échec) n'a pas encore son image n'est pas envoyé à Claude (vérification avant tout appel, sauf ponctuel et raccourci projet → signé, qui ne relisent jamais d'image) : il reste à lire, sans décision ni erreur, et il est repris le lendemain, une fois l'image produite par `images-pages`. Un payload refusé par la validation du robot (par exemple « signé » sans date de signature, aucune période datée) est déterministe : le document passe `en_attente` avec le motif (à traiter à la main, compté dans `sansLecture`) et n'est plus relu ; seules les pannes passagères (réseau, délai, CLI) sont rejouées. Code de sortie 0 même au quota ou au budget.

Échec d'un passage (code non nul : mise à jour du code, `npm ci`, plugin `manta-claude-max` introuvable, démarrage d'opencode, fournisseur `anthropic` jamais activé, plantage de `lire-claude`, arrêt par délai de systemd) : une notification « passage nocturne en échec : <étape> » part par `scripts/notifier-echec.mjs` (node seul, sans dépendance, donc même si `npm ci` a échoué), puis le script sort avec le code d'échec pour que systemd l'enregistre. Sans fichier de secrets lisible (code 2), aucune notification n'est possible : seul le journal systemd le dit.

Emplacements (machine, hors dépôt) :

- clone de déploiement : `~/.local/share/veille-arretes/robot` (`git clone https://github.com/sdechevigne/veille-arretes-chasse …`, puis `npm ci`) ;
- secrets du robot : `~/.config/veille-arretes/env` (mode `0600`, lignes `NOM=valeur` : `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `R2_*`, `MANTA_WEBHOOK_*`). Le script lit le fichier ligne à ligne **sans le faire interpréter par le shell** : la valeur est prise telle quelle jusqu'à la fin de la ligne, donc **sans guillemets ni échappement** (écrire avec `printf '%s=%s\n' NOM "$valeur"`) ; les lignes vides et `#…` sont ignorées, une ligne qui n'est pas `NOM=valeur` est signalée et ignorée. La lecture Claude ne fait que lire R2, le jeton R2 de cette machine est en lecture seule ;
- état : `~/.local/state/veille-arretes/` (un fichier `passages/<horodatage>.json` par passage, gardé 30 jours ; `opencode.log` ; dossier `opencode/` de l'instance isolée) ;
- le seul plugin de l'instance est le dossier `manta-claude-max` de l'opencode principal (`~/.config/opencode/plugins/manta-claude-max/`, livré par les mises à jour de Manta), recopié en entier à chaque passage (dossier des plugins refait à neuf : ni `manta` ni `manta-optimizer`) : fournisseur `anthropic` sur l'abonnement Claude sans clé, identité Claude Code, et siège Manta par conversation (visible dans `~/.manta/seat-assignments.json`). Il trouve seul, par `HOME`, le jeton de manta-server (`~/.manta/auth.json`), les sièges (`~/.manta-secrets/accounts/`) et la connexion Claude (`~/.claude/.credentials.json`) ; aucun autre fichier ni variable n'est transmis.
- échanges avec opencode V2 (`src/lecteur-opencode.ts`) : une session par lecture (agent `lecteur`, modèle `claude-sonnet-5-5` ou `claude-opus-5-5`, tout refusé : aucun outil envoyé au modèle), consigne et schéma posés comme instruction de la session, texte + images en pièces `data:image/png` (pages annoncées dans le texte, les noms des pièces n'arrivant pas au modèle), envoi asynchrone puis attente du retour au repos et lecture des messages ; session interrompue si besoin puis supprimée. L'agent n'a pas de limite d'étapes (`steps`) : à la dernière étape, opencode ajoute un message assistant que les modèles récents refusent.

Variables facultatives du script : `VEILLE_ETAT`, `VEILLE_SECRETS`, `OPENCODE_BIN` (emplacements), `VEILLE_DELAI_PRET` (attente du démarrage d'opencode, 180 s par défaut), `VEILLE_LIMITE` (40 par défaut) et `VEILLE_DEPARTEMENTS` (essais ciblés, via `systemctl --user set-environment`).

Déploiement :

```bash
mkdir -p ~/.config/systemd/user
install -m 0644 systemd/veille-arretes-lecture.{service,timer} ~/.config/systemd/user/
systemctl --user daemon-reload && systemctl --user enable --now veille-arretes-lecture.timer
systemctl --user list-timers | grep veille    # prochaine exécution : 02:30 Paris
```

Exploitation :

```bash
systemctl --user start veille-arretes-lecture.service      # essai manuel (un vrai passage)
journalctl --user -u veille-arretes-lecture -n 50           # sortie du dernier passage
systemctl --user disable --now veille-arretes-lecture.timer # arrêt d'urgence
bash scripts/tests/lecture-nocturne.test.sh                 # essai du script avec des doublures (à lancer via vmtest)
```

Au démarrage, opencode V2 ouvre son port puis construit le registre des fournisseurs : le script attend que `anthropic` y soit activé par le plugin (jusqu'à 180 s, mesurés sur le temps écoulé).

## Accès aux sites des préfectures

Les préfectures (`*.gouv.fr`) refusent les adresses de serveurs hors de France.

Le workflow ouvre une connexion hide.me vers la France (client Linux officiel `eventure/hide.client.linux`, serveur gratuit `free-fr.hideservers.net`) avant la collecte et la referme juste après (lecture mécanique, images et santé n'utilisent que R2 et Supabase, hors VPN). Recette et pièges : `docs/superpowers/specs/2026-10-14-veille-arretes-chasse-acces-prefectures.md` §2 du dépôt meschasses. Points d'attention :

- le client exige un terminal pour demander son jeton (lancé dans `script -qec`, délai maximal de 90 s) ;
- les identifiants passent par un fichier de configuration (jamais en argument de commande) ;
- l'étape « Connexion France » attend « Link: Up » dans le journal hide.me, puis vérifie le pays de sortie par Cloudflare (`https://www.cloudflare.com/cdn-cgi/trace`, ligne `loc=FR`), puis par `https://ipinfo.io/country` si Cloudflare ne répond pas `FR` ; la collecte reçoit alors `--sortie-france` ;
- une étape hide.me en échec (client, jeton ou sortie non française, avec diagnostic réseau et fin du journal filtrée) ne coupe pas le job : la collecte tourne sans `--sortie-france` (sources `.gouv.fr` écartées) et la suite du job continue ;
- tout le trafic de la machine (Supabase, R2) passe par le VPN pendant la collecte ; la machine GitHub est jetable, rien à restaurer ;
- lancement manuel avec l'option `sans_proxy` : pas de connexion hide.me, sources `.gouv.fr` écartées (fédérations seulement) ; sans compte hide.me, `VEILLE_PROXY_URL` sert de secours.

Si les préfectures bloquent `free-fr`, les sources `prefecture_*` apparaîtront en erreur réseau : appliquer les plans de secours du document de référence (§3).

## Spécification

Voir le dépôt meschasses : `docs/superpowers/specs/2026-10-14-veille-arretes-chasse-design.md`.

## Réactivation du planning

GitHub suspend le planning (cron) d'un dépôt public après 60 jours sans commit. Le job « bilan » du lundi commite `etat/dernier-bilan.json` (comptes seulement) pour l'éviter. Si le planning a malgré tout été suspendu :

```bash
gh workflow enable veille-arretes.yml --repo sdechevigne/veille-arretes-chasse
```
