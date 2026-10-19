// Bilan hebdomadaire : synthèse des 7 derniers jours, en comptes uniquement (le fichier est commité dans un dépôt public).
import type { UsageClaude } from './lecteur.ts'

export interface EntreeBilan {
  maintenant: Date
  sourcesEnPanne: number
  documents: { statut_traitement: string; type_detecte: string | null }[]
  propositions: { decision: string; lecture: { usage?: Partial<UsageClaude> } | null }[]
}
export interface SyntheseBilan {
  genereLe: string; periodeJours: number; sourcesEnPanne: number
  documents7j: { total: number; parStatut: Record<string, number>; parType: Record<string, number> }
  propositions7j: { total: number; parDecision: Record<string, number> }
  tokens7j: UsageClaude
  deferes: string[]
}

const compter = <T>(lignes: T[], cle: (l: T) => string): Record<string, number> => {
  const r: Record<string, number> = {}
  for (const l of lignes) r[cle(l)] = (r[cle(l)] ?? 0) + 1
  return r
}

export function syntheseBilan(e: EntreeBilan): SyntheseBilan {
  const tokens7j: UsageClaude = { input: 0, output: 0, cache_creation: 0, cache_read: 0 }
  for (const p of e.propositions) for (const k of Object.keys(tokens7j) as (keyof UsageClaude)[]) tokens7j[k] += Number(p.lecture?.usage?.[k] ?? 0) || 0
  return {
    genereLe: e.maintenant.toISOString(), periodeJours: 7, sourcesEnPanne: e.sourcesEnPanne,
    documents7j: { total: e.documents.length, parStatut: compter(e.documents, d => d.statut_traitement), parType: compter(e.documents, d => d.type_detecte ?? 'non_detecte') },
    propositions7j: { total: e.propositions.length, parDecision: compter(e.propositions, p => p.decision) },
    tokens7j,
    deferes: ['couverture des départements sans arrêté annuel en campagne (1er juin / 15 juillet)'],
  }
}

export function texteBilan(s: SyntheseBilan): string {
  // Entrée lue = hors cache + création du cache + lecture du cache (la CLI les compte à part).
  const cache = s.tokens7j.cache_creation + s.tokens7j.cache_read
  const lus = s.tokens7j.input + cache
  const decisions = Object.entries(s.propositions7j.parDecision).map(([d, n]) => `${d} ${n}`).join(', ')
  return `Bilan hebdomadaire veille arrêtés : ${s.documents7j.total} document(s) découvert(s), ${s.propositions7j.total} proposition(s)${decisions ? ` (${decisions})` : ''}, `
    + `${lus} tokens lus (dont ${cache} en cache) / ${s.tokens7j.output} écrits, ${s.sourcesEnPanne} source(s) en panne`
}
