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

/** Texte de la notification de fin de lecture Claude (publiées = publiées sans et avec note).
 *  Les documents sans lecture automatique (en attente d'un opérateur) sont ajoutés quand il y en a. */
export function textePropositions(s: { enAttente: number; publie: number; publieNote: number; sansLecture?: number; erreurs?: number; arretQuota: boolean; arretPrecoce?: boolean; restantsALire?: number }): string {
  const sansLecture = s.sansLecture ? `, ${s.sansLecture} document(s) sans lecture automatique à traiter à la main` : ''
  const erreurs = s.erreurs ? `, ${s.erreurs} document(s) en erreur de lecture` : ''
  const quota = s.arretQuota ? ` [quota Claude atteint${s.restantsALire !== undefined ? `, reste ${s.restantsALire} documents` : ''}]` : ''
  const precoce = s.arretPrecoce ? ' [budget de temps épuisé, lecture interrompue]' : ''
  return `Veille arrêtés : ${s.enAttente} proposition(s) à vérifier, ${s.publie + s.publieNote} publiée(s)${sansLecture}${erreurs}${quota}${precoce}`
}

export const TEXTE_LECTURE_ILLISIBLE = 'Veille arrêtés : lecture Claude : résultat illisible'

/** Corps de la notification de fin de lecture Claude, depuis le JSON brut de `lire-claude`.
 *  Fichier tronqué ou illisible (passage interrompu) : notification courte plutôt que le silence. */
export function corpsNotificationLecture(brut: string): CorpsNotification {
  let stats: any
  try { stats = JSON.parse(brut) } catch { stats = null }
  if (!stats || typeof stats !== 'object' || Array.isArray(stats)) return { type: 'propositions', texte: TEXTE_LECTURE_ILLISIBLE, donnees: null }
  return { type: 'propositions', texte: textePropositions(stats), donnees: stats }
}
