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

// Mots de tête retirés avant comparaison (« la Manche », « Département de la Manche », « Préfecture des Côtes-d'Armor »).
const MOTS_DE_TETE = new Set(['le', 'la', 'les', 'l', 'de', 'du', 'des', 'd', 'departement', 'prefecture'])

/** Nom de département comparable : miroir élargi de `_deaccent_fr` en base (minuscules, sans accents, apostrophes et traits
 *  d'union en espaces), espaces réduits, articles et « département / préfecture » de tête retirés. */
export function nomDepartementNormalise(nom: string): string {
  const mots = nom.toLowerCase().normalize('NFD').replace(/\p{M}/gu, '').replace(/['’\-]/g, ' ').split(/\s+/).filter(Boolean)
  while (mots.length > 1 && MOTS_DE_TETE.has(mots[0])) mots.shift()
  return mots.join(' ')
}

/** `preuve.dept_detecte` : le nom officiel quand le nom lu le désigne (forme longue comprise), sinon le nom lu tel quel
 *  (le contrôle C2 de la base bloquera : vrai désaccord), avec une note du robot. Absent → nom officiel. */
export function deptDetecte(lu: string | null, nomOfficiel: string): { valeur: string; note: string | null } {
  if (lu === null || !lu.trim() || nomDepartementNormalise(lu) === nomDepartementNormalise(nomOfficiel)) return { valeur: nomOfficiel, note: null }
  return { valeur: lu, note: `département lu « ${lu} » ≠ département attendu « ${nomOfficiel} »` }
}

/** Payload prêt pour la RPC. Extrait source : citation de la première période prouvée (ordre du payload), à défaut
 *  celle de la première suppression (modificatif ne faisant que supprimer). `notes` = mentions de Claude pour l'arrêté publié. */
export function payloadDe(e: Omit<EntreePayload, 'preuveCore'> & { nom: string; suppressions: LectureClaude['suppressions'] }): PayloadCore {
  const preuveCore = { code_detecte: e.departement, dept_detecte: deptDetecte(e.acte.departement_lu, e.nom).valeur, millesime_detecte: e.saison, signature_detectee: e.acte.date ?? '', extrait_source: '' }
  const { suppressions, nom: _nom, ...entree } = e
  const payload = construirePayload({ ...entree, preuveCore })
  const extrait = payload.periodes.find(p => p.preuve)?.preuve?.citation ?? suppressions[0]?.citation ?? ''
  return { ...payload, preuve: { ...preuveCore, extrait_source: extrait } }
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
