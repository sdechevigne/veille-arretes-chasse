// Notification Manta par webhook signé (HMAC-SHA256 du corps brut). Non critique : un échec est journalisé, jamais levé.
import { createHmac } from 'node:crypto'
import { expurger } from './http.ts'

export interface CorpsNotification { type: 'propositions' | 'bilan'; texte: string; donnees: unknown }

export async function notifierManta(cfg: { url: string; secret: string }, corps: CorpsNotification, fetchImpl: typeof fetch = fetch): Promise<void> {
  const brut = JSON.stringify(corps)
  const signature = createHmac('sha256', cfg.secret).update(brut).digest('hex')
  try {
    const r = await fetchImpl(cfg.url, {
      method: 'POST', body: brut, signal: AbortSignal.timeout(30_000),
      headers: { 'Content-Type': 'application/json', 'X-Manta-Signature': `sha256=${signature}` },
    })
    if (!r.ok) console.error(`notification Manta refusée : HTTP ${r.status}`)
  } catch (e) {
    console.error(expurger(`notification Manta impossible : ${(e as Error).message}`, undefined, cfg.url, cfg.secret))
  }
}

/** Texte de la notification de fin de lecture Claude (publiées = publiées sans et avec note). */
export function textePropositions(s: { enAttente: number; publie: number; publieNote: number; arretQuota: boolean; restantsALire?: number }): string {
  const quota = s.arretQuota ? ` [quota Claude atteint${s.restantsALire !== undefined ? `, reste ${s.restantsALire} documents` : ''}]` : ''
  return `Veille arrêtés : ${s.enAttente} proposition(s) à vérifier, ${s.publie + s.publieNote} publiée(s)${quota}`
}
