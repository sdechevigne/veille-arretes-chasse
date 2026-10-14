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
- `VEILLE_PROXY_URL` (optionnel)

## Spécification

Voir le dépôt meschasses : `docs/superpowers/specs/2026-10-14-veille-arretes-chasse-design.md`.
