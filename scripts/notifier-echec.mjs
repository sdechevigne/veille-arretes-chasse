// Notification d'échec du passage nocturne, SANS dépendance (node seul) : elle doit marcher même quand `npm ci` a échoué.
// Usage : MANTA_WEBHOOK_URL=… MANTA_WEBHOOK_SECRET=… node scripts/notifier-echec.mjs "<texte>"
// Même contrat que src/manta.ts (corps JSON signé HMAC-SHA256 hex dans X-Manta-Signature). Code 0 toujours : non critique.
import { createHmac } from 'node:crypto'

const url = process.env.MANTA_WEBHOOK_URL?.trim()
const secret = process.env.MANTA_WEBHOOK_SECRET?.trim()
const texte = process.argv[2]
if (!texte) { console.error('texte attendu'); process.exit(2) }
if (!url || !secret) { console.error('webhook Manta non configuré : notification ignorée'); process.exit(0) }

const corps = JSON.stringify({ type: 'propositions', texte, donnees: null })
try {
  const r = await fetch(url, {
    method: 'POST', body: corps, signal: AbortSignal.timeout(30_000),
    headers: { 'Content-Type': 'application/json', 'X-Manta-Signature': `sha256=${createHmac('sha256', secret).update(corps).digest('hex')}` },
  })
  if (!r.ok) console.error(`notification Manta refusée : HTTP ${r.status}`)
} catch (e) {
  // Ni l'adresse ni la clé dans le journal : seulement le type d'erreur.
  console.error(`notification Manta impossible : ${e?.cause?.code ?? e?.name ?? 'erreur'}`)
}
