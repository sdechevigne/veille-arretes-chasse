# veille-arretes-chasse

Veille automatique des arrêtés préfectoraux de chasse pour Mes Chasses.

## Fonctionnement

1. **Collecte** : parcours des pages officielles (préfectures, recueils des actes administratifs, fédérations de chasseurs) pour repérer les documents publiés.
2. **Empreinte** : chaque document téléchargé reçoit une empreinte SHA-256 ; un document déjà connu n'est pas retraité.
3. **Archive** : l'original est conservé dans un stockage objet (R2) sous une clé stable.
4. **Lecture mécanique** : extraction du texte (natif ou OCR), détection du type d'acte, de la saison, du numéro et de la date.
5. **File à lire** : les documents pertinents sont déposés dans une file de relecture ; les autres sont ignorés avec leur motif.

## Commandes

```bash
npm ci
npm run veille       # lance le robot (src/cli.ts)
npm test             # tests unitaires (Vitest)
npm run typecheck    # vérification des types
```

## Secrets attendus (variables d'environnement, valeurs jamais commitées)

- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `R2_ACCOUNT_ID`
- `R2_ACCESS_KEY_ID`
- `R2_SECRET_ACCESS_KEY`
- `R2_VEILLE_BUCKET`
- `HIDEME_USER`, `HIDEME_PASSWORD` : compte hide.me (formule gratuite) pour sortir par une adresse française (serveur `free-fr.hideservers.net`) ; les sites des préfectures refusent les adresses hors de France.
- `VEILLE_PROXY_URL` (optionnel, secours : proxy HTTP français)

## Accès aux sites des préfectures

Les préfectures (`*.gouv.fr`) refusent les adresses de serveurs hors de France. Le workflow ouvre une connexion hide.me vers la France (client Linux officiel `eventure/hide.client.linux`) avant la collecte, puis la referme. Points clés : le client exige un terminal pour demander son jeton (lancé dans `script -qec`), identifiants passés par fichier de configuration (jamais en argument), délai maximal de 90 s pour la demande de jeton. Validé depuis GitHub Actions le 2026-10-14 (5 préfectures sur 5).

## Spécification

Voir le dépôt meschasses : `docs/superpowers/specs/2026-10-14-veille-arretes-chasse-design.md`.
