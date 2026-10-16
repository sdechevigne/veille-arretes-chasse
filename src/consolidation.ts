// Consolidation d'une lecture Claude : périodes retenues, zones publiées perdues, comparaison de deux lectures. Module pur.
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

// Clé comparable d'une période (normalisée comme le payload : sous-type canonique, mode nul = tous modes) et attributs
// secondaires, qui ne changent ni l'espèce ni le mode ni les dates (citation et page, qui varient d'une lecture à l'autre, exclues).
type Entree = { cle: string; secondaire: string }
const entrees = (s: LectureClaude): Entree[] => construirePayload({
  departement: '', saison: '', statut: 'en_attente_signature', acte: s.acte, url: '', periodes: s.periodes, notes: '',
  preuveCore: { code_detecte: '', dept_detecte: '', millesime_detecte: '', signature_detectee: '', extrait_source: '' },
}).periodes.map(p => ({
  cle: JSON.stringify([p.espece_code, p.sous_type ?? null, modeDe(p), p.date_ouverture, p.date_fermeture]),
  secondaire: JSON.stringify([p.restriction_dates ?? null, p.source_article ?? null]),
}))
  // Ordre total et stable : clé puis attributs secondaires (comparaison de chaînes, sans dépendre de l'ordre de lecture).
  .sort((x, y) => (x.cle < y.cle ? -1 : x.cle > y.cle ? 1 : x.secondaire < y.secondaire ? -1 : x.secondaire > y.secondaire ? 1 : 0))

const libelle = (cle: string): string => {
  const [espece, sousType, mode, ouverture, fermeture] = JSON.parse(cle) as (string | null)[]
  return `${espece}${sousType ? ` ${sousType}` : ''} ${mode} ${ouverture}→${fermeture}`
}
const secondaires = (liste: Entree[], cle: string) => liste.filter(e => e.cle === cle).map(e => {
  const [restriction, article] = JSON.parse(e.secondaire) as (string | null)[]
  return `restriction ${restriction ?? '-'}, article ${article ?? '-'}`
}).join(' | ')

/** Comparaison de deux lectures indépendantes sur (espèce, sous-type, mode, ouverture, fermeture).
 *  `ecarts` vide = concordantes ; `secondaires` = périodes concordantes dont la restriction ou l'article diffère (note, pas un écart). */
export function comparerLectures(a: LectureClaude, b: LectureClaude): { ecarts: string[]; secondaires: string[] } {
  const ea = entrees(a), eb = entrees(b)
  const ka = ea.map(e => e.cle), kb = eb.map(e => e.cle)
  if (ka.join('\n') !== kb.join('\n')) {
    if (ka.every(k => kb.includes(k)) && kb.every(k => ka.includes(k))) return { ecarts: [`nombre de périodes différent (${ka.length} / ${kb.length})`], secondaires: [] }
    return { ecarts: [...new Set(ka.filter(k => !kb.includes(k)))].map(k => `${libelle(k)} (lecture 1 seule)`)
      .concat([...new Set(kb.filter(k => !ka.includes(k)))].map(k => `${libelle(k)} (lecture 2 seule)`)), secondaires: [] }
  }
  const diff = [...new Set(ka)].filter(k => secondaires(ea, k) !== secondaires(eb, k))
  return { ecarts: [], secondaires: diff.map(k => `${libelle(k)} : ${secondaires(ea, k)} (lecture 1) / ${secondaires(eb, k)} (lecture 2)`) }
}
