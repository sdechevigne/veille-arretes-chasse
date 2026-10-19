// Contrat commun des lecteurs Claude (opencode, CLI) : requête, réponse, validation Ajv, double en mémoire pour les tests.
import Ajv2020 from 'ajv/dist/2020.js'
import type { ValidateFunction } from 'ajv/dist/2020.js'
import type { LectureClaude } from './types.ts'

export interface RequeteLecture { modele: 'sonnet' | 'opus'; systeme: string; schema: object; texte: string; images?: { page: number; png: Buffer }[]; delaiMs?: number }
export interface UsageClaude { input: number; output: number; cache_creation: number; cache_read: number }
export type ReponseLecture =
  | { ok: true; sortie: LectureClaude; usage: UsageClaude; modele: string }
  | { ok: false; erreur: 'quota' | 'schema' | 'timeout' | 'cli'; message: string }
export interface Lecteur { lire(req: RequeteLecture): Promise<ReponseLecture> }

export const DELAI_LECTURE_MS = 240_000

const ajv = new Ajv2020({ allErrors: true, strict: true })
const validateurs = new WeakMap<object, ValidateFunction>()
function validateur(schema: object): ValidateFunction {
  let v = validateurs.get(schema); if (!v) { v = ajv.compile(schema); validateurs.set(schema, v) }
  return v
}

/** null = sortie conforme au schéma, sinon le texte des erreurs Ajv. */
export function validerSortie(schema: object, sortie: unknown): string | null {
  const v = validateur(schema)
  return v(sortie) ? null : ajv.errorsText(v.errors, { separator: ' ; ', dataVar: 'sortie' })
}

/** La consigne envoyée au modèle n'a pas besoin du méta-schéma ; Ajv valide sur le schéma complet. */
export function schemaSansMeta(schema: object): Record<string, unknown> {
  const { $schema: _meta, ...reste } = schema as Record<string, unknown>
  return reste
}

// Double en mémoire pour les tests : rend les réponses dans l'ordre et mémorise les requêtes reçues.
export function creerLecteurMemoire(reponses: ReponseLecture[]): Lecteur & { requetes: RequeteLecture[] } {
  const file = [...reponses]; const requetes: RequeteLecture[] = []
  return { requetes, async lire(req) { requetes.push(req); const r = file.shift(); if (!r) throw new Error('lecteur mémoire : plus de réponse prévue'); return r } }
}
