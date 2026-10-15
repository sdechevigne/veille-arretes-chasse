// Consolidation d'une lecture Claude : périodes retenues, zones publiées perdues, concordance d'une double lecture. Module pur.
import { appliquerDifference, type PeriodePubliee } from './difference.ts'
import { construirePayload, type EntreePayload, type PayloadCore, type PeriodePayload } from './payload.ts'
import type { LectureClaude } from './types.ts'

export type ModeLecture = 'complet' | 'difference' | 'script_projet_signe'

const modeDe = (p: { mode_chasse: string | null }): string => p.mode_chasse || 'tous_modes'

/** Périodes à soumettre selon le mode ; en différence, le journal d'application part dans les notes. */
export function consoliderPeriodes(mode: ModeLecture, sortie: LectureClaude, publiees: PeriodePubliee[], periodesProjet: PeriodePayload[]):
  { periodes: PeriodePubliee[]; journal: string[]; suppressionExplicite: boolean } {
  if (mode === 'difference') return appliquerDifference(publiees, sortie)
  // Périodes du projet : déjà normalisées par construirePayload (mode nul = tous modes), preuve d'origine conservée.
  const periodes = mode === 'script_projet_signe' ? periodesProjet.map(p => ({ ...p, mode_chasse: modeDe(p) })) : sortie.periodes
  return { periodes, journal: [], suppressionExplicite: false }
}

/** Zones publiées qu'aucune période consolidée ne reprend (même espèce, sous-type, mode et zone) : jamais effacées en silence. */
export function zonesNonReprises(publiees: PeriodePubliee[], periodes: PeriodePubliee[]): string[] {
  return publiees.filter(p => p.zone_libelle && !periodes.some(q => q.zone_libelle === p.zone_libelle && q.espece_code === p.espece_code
    && (q.sous_type ?? null) === (p.sous_type ?? null) && modeDe(q) === modeDe(p)))
    .map(p => `zone publiée non reprise : ${p.espece_code} ${modeDe(p)} (${p.zone_libelle})`)
}

/** Payload prêt pour la RPC ; l'extrait source est la citation de la première période (ordre du payload). */
export function payloadDe(e: Omit<EntreePayload, 'preuveCore'> & { nom: string }): PayloadCore {
  const preuveCore = { code_detecte: e.departement, dept_detecte: e.acte.departement_lu ?? e.nom, millesime_detecte: e.saison, signature_detectee: e.acte.date ?? '', extrait_source: '' }
  const payload = construirePayload({ ...e, preuveCore })
  return { ...payload, preuve: { ...preuveCore, extrait_source: payload.periodes.find(p => p.preuve)?.preuve?.citation ?? '' } }
}

// Forme comparable d'une période : celle du payload, sans la preuve (citation et page varient d'une lecture à l'autre).
const formes = (s: LectureClaude): string[] => construirePayload({
  departement: '', saison: '', statut: 'en_attente_signature', acte: s.acte, url: '', periodes: s.periodes, notes: '',
  preuveCore: { code_detecte: '', dept_detecte: '', millesime_detecte: '', signature_detectee: '', extrait_source: '' },
}).periodes.map(({ preuve: _preuve, ...p }) => JSON.stringify(p))

const libelle = (forme: string): string => {
  const p = JSON.parse(forme) as PeriodePayload
  return `${p.espece_code} ${modeDe(p)} ${p.date_ouverture}→${p.date_fermeture}`
}

/** Écarts entre deux lectures indépendantes (vide = concordantes). */
export function ecartsDoubleLecture(a: LectureClaude, b: LectureClaude): string[] {
  const fa = formes(a), fb = formes(b)
  if (fa.join('\n') === fb.join('\n')) return []
  if (fa.every(f => fb.includes(f)) && fb.every(f => fa.includes(f))) return [`nombre de périodes différent (${fa.length} / ${fb.length})`]
  return [...fa.filter(f => !fb.includes(f)).map(f => `${libelle(f)} (lecture 1 seule)`), ...fb.filter(f => !fa.includes(f)).map(f => `${libelle(f)} (lecture 2 seule)`)]
}
