# veille-arretes-chasse

Veille automatique des arrêtés préfectoraux de chasse pour Mes Chasses.

## Fonctionnement

1. **Collecte** : parcours des pages officielles (préfectures, recueils des actes administratifs, fédérations de chasseurs) pour repérer les documents publiés.
2. **Empreinte** : chaque document téléchargé reçoit une empreinte SHA-256 ; un document déjà connu n'est pas retraité.
3. **Archive** : l'original est conservé dans un stockage objet (R2) sous une clé stable.
4. **Lecture mécanique** : extraction du texte (natif ou OCR), détection du type d'acte, de la saison, du numéro et de la date.
5. **File à lire** : les documents pertinents sont déposés dans une file de relecture ; les autres sont ignorés avec leur motif.
6. **Lecture Claude** : chaque document de la file est lu par Claude (Claude Code CLI, abonnement) à partir d'un dossier minimal ; la proposition est contrôlée puis décidée en base (publiée, publiée avec note ou en attente de vérification). Arrêt propre au quota de l'abonnement.
7. **Notification** : un webhook Manta signé (HMAC-SHA256) signale les propositions à vérifier et l'arrêt au quota ; le lundi, un bilan hebdomadaire.

## Commandes

```bash
npm ci
npm run veille       # lance le robot (src/cli.ts)
npm test             # tests unitaires (Vitest)
npm run typecheck    # vérification des types
```

Commandes du robot (`npm run -s veille -- <commande>` ; `-s` retire l'en-tête de npm quand on lit le JSON produit) :

- `collecter [--departements 24,50] [--sans-proxy] [--budget-min N]` : collecte des documents.
- `lire [--limite N] [--budget-min N]` : lecture mécanique (texte, type, saison).
- `lire-claude [--limite N] [--budget-min N] [--departements 24,50]` : lecture Claude de la file ; statistiques JSON seules sur la sortie standard (journal sur la sortie d'erreur), code 0 même à l'arrêt au quota (`arretQuota`).
- `dossier --id <uuid>` : affiche le dossier qui serait envoyé à Claude pour un document (mode, estimation de tokens, texte), sans appel Claude.
- `notifier --fichier lecture-claude.json` : notification Manta des propositions à vérifier (ignorée sans webhook configuré).
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
- `VEILLE_PROXY_URL` : proxy HTTP français. Tant qu'il est absent, la collecte planifiée (cron) est suspendue ; le lancement manuel reste possible.
- `HIDEME_USER`, `HIDEME_PASSWORD` : compte hide.me (formule gratuite, serveur `free-fr.hideservers.net`), réservés à l'intégration hide.me à venir ; pas encore utilisés par le workflow.
- `CLAUDE_CODE_OAUTH_TOKEN` (optionnel) : jeton de l'abonnement Claude ; absent, l'étape « Lecture Claude » est sautée.
- `MANTA_WEBHOOK_URL`, `MANTA_WEBHOOK_SECRET` (optionnels) : webhook de notification et sa clé de signature ; absents, les notifications sont ignorées.

## Accès aux sites des préfectures

Les préfectures (`*.gouv.fr`) refusent les adresses de serveurs hors de France.

État actuel : le workflow n'ouvre **aucune** connexion vers la France. La collecte passe par `VEILLE_PROXY_URL` quand ce secret est posé ; sans lui, le cron est suspendu, et un lancement manuel (option `sans_proxy` ou secret absent) écarte les sources `.gouv.fr` au lieu de les compter en panne.

À venir (tâche dédiée, pas encore dans le YAML) : connexion hide.me vers la France (client Linux officiel `eventure/hide.client.linux`) avant la collecte, refermée ensuite. Essai concluant depuis GitHub Actions le 2026-10-14 (5 préfectures sur 5) ; points relevés : le client exige un terminal pour demander son jeton (lancé dans `script -qec`), identifiants passés par fichier de configuration (jamais en argument), délai maximal de 90 s pour la demande de jeton.

## Spécification

Voir le dépôt meschasses : `docs/superpowers/specs/2026-10-14-veille-arretes-chasse-design.md`.

## Réactivation du planning

GitHub suspend le planning (cron) d'un dépôt public après 60 jours sans commit. Le job « bilan » du lundi commite `etat/dernier-bilan.json` (comptes seulement) pour l'éviter. Si le planning a malgré tout été suspendu :

```bash
gh workflow enable veille-arretes.yml --repo sdechevigne/veille-arretes-chasse
```
