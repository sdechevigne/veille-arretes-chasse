// Contrôle C1 : chaque période (ou suppression) lue par Claude doit être appuyée par une citation exacte du texte,
// portant l'espèce et les deux dates, complétée au besoin d'extraits voisins de la même page (arrêtés en tableau).
// Une date absente de la preuve n'est admise que par un renvoi aux dates générales écrites dans l'arrêté. Module pur.
import { datesDe, premierePlage } from './dates.ts'
import { ESPECES_RECHERCHE } from './lexique.ts'
import { normaliser, trouverCitation } from './texte.ts'
import type { LectureClaude, PageTexte } from './types.ts'

const RE_SIKA = /\bsikas?\b/i

const motifEspece = (code: string, sousType: string | null): RegExp | undefined =>
  sousType === 'cerf_sika' ? RE_SIKA : ESPECES_RECHERCHE[code]

// Même seuil que trouverCitation : au-dessus, l'échec ne peut venir que d'un nombre différent.
const SEUIL_NOMBRE_ALTERE = 0.9

const pct = (x: number) => x.toFixed(2).replace('.', ',')

export type NatureEchec = 'page_introuvable' | 'citation_introuvable' | 'nombre_altere' | 'espece_sans_motif' | 'espece_absente' | 'date_absente'
  | 'extrait_introuvable' | 'extraits_eloignes' | 'extrait_ambigu'
/** Échec C1 d'un élément, avec la page déclarée par sa preuve (aiguillage texte natif / scan) ; `score` = similarité
 *  de la meilleure fenêtre pour une citation non retrouvée. */
export interface EchecPreuve { page: number; detail: string; nature: NatureEchec; score?: number }
export interface VerificationPreuves {
  ok: boolean; details: string[]
  /** Page déclarée de chaque élément en échec, triée, sans doublon (page inexistante comprise). */
  pagesEnEchec: number[]
  echecs: EchecPreuve[]
  /** Dates admises par renvoi aux dates générales, espèces prouvées par un extrait (notes de la lecture si C1 est vert). */
  notes: string[]
}

/** Écart maximal (caractères du texte de page normalisé) entre le début de la citation et celui d'un extrait (Ruling R43). */
export const DISTANCE_MAX_FRAGMENTS = 600
/** Fenêtre (caractères normalisés) qui suit « ouverture générale » / « clôture générale », où est lue la date générale. */
export const FENETRE_DATES_GENERALES = 200
// Expressions sur texte normalisé (accents retirés).
const RE_OUVERTURE_GENERALE = /\bouverture generale\b/
const RE_CLOTURE_GENERALE = /\b(?:cloture|fermeture) generale\b/
// « la veille de l'ouverture générale », « le lendemain de la clôture générale » : rattaché à l'expression (Ruling R48).
const RE_RELATIF = /\b(veille|lendemain) de (?:la |l' ?|l )?(ouverture|cloture|fermeture) generale\b/g

export interface DatesGenerales { ouvertures: Set<string>; clotures: Set<string> }

/** Dates générales écrites dans l'arrêté (Ruling R46) : après chaque « ouverture générale », la première date (→ ouvertures) ou
 *  la première plage « du A au B » (A → ouvertures, B → clôtures) ; après « clôture / fermeture générale », la première date (→ clôtures). */
export function datesGenerales(pages: PageTexte[], saison: string): DatesGenerales {
  const ouvertures = new Set<string>(), clotures = new Set<string>()
  const apres = (t: string, re: RegExp) => [...t.matchAll(new RegExp(re.source, 'g'))]
    .map(m => premierePlage(t.slice(m.index + m[0].length, m.index + m[0].length + FENETRE_DATES_GENERALES), saison)).filter(p => p !== null)
  for (const page of pages) {
    const t = normaliser(page.texte)
    for (const p of apres(t, RE_OUVERTURE_GENERALE)) { ouvertures.add(p.debut); if (p.fin) clotures.add(p.fin) }
    for (const p of apres(t, RE_CLOTURE_GENERALE)) clotures.add(p.debut)
  }
  return { ouvertures, clotures }
}

const decaler = (iso: string, jours: number) => {
  const [a, m, j] = iso.split('-').map(Number)
  return new Date(Date.UTC(a, m - 1, j + jours)).toISOString().slice(0, 10)
}

const RENVOIS = [
  { motif: RE_OUVERTURE_GENERALE, ensemble: 'ouvertures', nom: 'ouverture générale', defini: "l'ouverture générale" },
  { motif: RE_CLOTURE_GENERALE, ensemble: 'clotures', nom: 'clôture générale', defini: 'la clôture générale' },
] as const

/** Renvoi de la preuve (texte normalisé) qui justifie une date absente, ou null : une date d'ouverture renvoie à l'ouverture
 *  générale, une date de fermeture à la clôture générale ; « la veille de » / « le lendemain de » l'une ou l'autre décale d'un jour. */
function renvoi(date: string, ouverture: boolean, preuve: string, generales: DatesGenerales): string | null {
  for (const r of RENVOIS) if ((r.ensemble === 'ouvertures') === ouverture && r.motif.test(preuve) && generales[r.ensemble].has(date)) return r.nom
  for (const m of preuve.matchAll(RE_RELATIF)) {
    const r = RENVOIS[m[2] === 'ouverture' ? 0 : 1]
    if (generales[r.ensemble].has(decaler(date, m[1] === 'veille' ? 1 : -1))) return `${m[1]} de ${r.defini}`
  }
  return null
}

/** Pourquoi un extrait ne peut pas prouver l'espèce (Ruling R47), ou null : il doit précéder la citation sans qu'une autre
 *  espèce s'intercale (sinon l'espèce peut venir de la ligne voisine d'un tableau). Positions sur la page normalisée. */
function ambiguite(page: string, extrait: { debut: number; fin: number }, citation: number, espece: string): string | null {
  if (extrait.debut > citation) return 'après la citation'
  const entre = page.slice(extrait.fin, citation)
  const autre = Object.entries(ESPECES_RECHERCHE).find(([code, re]) => code !== espece && re.test(entre))
  return autre ? `séparé de la citation par une autre espèce (${autre[0]})` : null
}

/** Seuil sous lequel une citation non retrouvée est jugée inventée (et non abîmée par l'OCR). */
export const SEUIL_CITATION_ABIMEE = 0.5

/** Échec qu'un texte OCR abîmé peut expliquer, donc levable par une lecture sur image concordante.
 *  Un extrait éloigné ou ambigu ne l'est jamais (assemblage possible de morceaux sans rapport). Pour un extrait court
 *  (nom d'espèce), le seuil de similarité 0,5 est faible : la levée repose alors sur la concordance des lectures sur image. */
export const levableSurImage = (e: EchecPreuve): boolean =>
  e.nature === 'espece_absente' || e.nature === 'nombre_altere' || e.nature === 'date_absente'
  || ((e.nature === 'citation_introuvable' || e.nature === 'extrait_introuvable') && (e.score ?? 0) >= SEUIL_CITATION_ABIMEE)

export function verifierPreuves(lecture: LectureClaude, pages: PageTexte[], saison: string): VerificationPreuves {
  const echecs: EchecPreuve[] = [], notes: string[] = []
  let generales: DatesGenerales | undefined

  // Vérifie page, citation, extraits et espèce ; renvoie le texte de la preuve (citation et extraits retrouvés près d'elle)
  // si la citation est retrouvée (pour poursuivre sur les dates), null sinon.
  const verifierCitation = (etiquette: string, espece: string, sousType: string | null, citation: string, numPage: number, extraits: string[]): string | null => {
    const prefixe = `${etiquette} (${espece}) : `
    const echouer = (nature: NatureEchec, detail: string, score?: number) => { echecs.push({ page: numPage, detail, nature, ...(score === undefined ? {} : { score }) }) }
    const page = pages.find(p => p.n === numPage)
    if (!page) { echouer('page_introuvable', `${prefixe}page ${numPage} introuvable`); return null }
    const trouvee = trouverCitation(citation, page.texte)
    if (!trouvee.ok) {
      // Score ≥ 0,9 : le texte ressemble, c'est un nombre (jour, année) qui diffère.
      const altere = trouvee.score >= SEUIL_NOMBRE_ALTERE
      echouer(altere ? 'nombre_altere' : 'citation_introuvable', `${prefixe}${altere ? 'citation introuvable ou nombre altéré' : 'citation introuvable'} (similarité ${pct(trouvee.score)})`, trouvee.score)
      return null
    }
    // Extraits : retrouvés sur la même page, près de la citation ; un extrait en échec ne prouve rien. Un extrait qui apporte
    // l'espèce absente de la citation doit en plus la précéder sans autre espèce intercalée.
    const motif = motifEspece(espece, sousType)
    const especeCitee = !!motif?.test(citation)
    const pageNorm = normaliser(page.texte)
    const preuve = [citation]
    let especeParExtrait: string | undefined
    for (const extrait of extraits) {
      const e = trouverCitation(extrait, page.texte)
      if (!e.ok) { echouer('extrait_introuvable', `${prefixe}extrait « ${extrait} » introuvable (similarité ${pct(e.score)})`, e.score); continue }
      const ecart = Math.abs(e.debut - trouvee.debut)
      if (ecart > DISTANCE_MAX_FRAGMENTS) { echouer('extraits_eloignes', `${prefixe}extrait « ${extrait} » trop éloigné de la citation (${ecart} caractères)`); continue }
      if (motif && !especeCitee && motif.test(extrait)) {
        const raison = ambiguite(pageNorm, { debut: e.debut, fin: e.debut + normaliser(extrait).length }, trouvee.debut, espece)
        if (raison) { echouer('extrait_ambigu', `${prefixe}extrait « ${extrait} » ${raison}`); continue }
        especeParExtrait ??= extrait
      }
      preuve.push(extrait)
    }
    const texte = preuve.join(' ')
    if (!motif) echouer('espece_sans_motif', `${prefixe}espèce sans motif de recherche`)
    else if (!motif.test(texte)) echouer('espece_absente', `${prefixe}espèce absente de la citation`)
    else if (especeParExtrait !== undefined) notes.push(`${prefixe}espèce prouvée par extrait « ${especeParExtrait} »`)
    return texte
  }

  lecture.periodes.forEach((p, i) => {
    const { citation, page, annee_deduite, extraits } = p.preuve
    const texte = verifierCitation(`période ${i + 1}`, p.espece_code, p.sous_type, citation, page, extraits)
    if (texte === null) return
    const preuve = normaliser(texte)
    const vues = datesDe(preuve, saison).map(d => (annee_deduite ? d.slice(5) : d))
    const prefixe = `période ${i + 1} (${p.espece_code}) : `
    for (const [libelle, date, ouverture] of [["d'ouverture", p.date_ouverture, true], ['de fermeture', p.date_fermeture, false]] as const) {
      if (vues.includes(annee_deduite ? date.slice(5) : date)) continue
      // Renvoi admis seulement si la preuve porte au plus une date littérale (Ruling R48) : au-delà, elle décrit d'autres périodes.
      const r = vues.length <= 1 ? renvoi(date, ouverture, preuve, (generales ??= datesGenerales(pages, saison))) : null
      if (r) notes.push(`${prefixe}date ${libelle} ${date} = ${r} (renvoi)`)
      else echecs.push({ page, nature: 'date_absente', detail: `${prefixe}date ${libelle} ${date} absente de la citation` })
    }
  })
  lecture.suppressions.forEach((s, i) => { verifierCitation(`suppression ${i + 1}`, s.espece_code, s.sous_type, s.citation, s.page, s.extraits) })

  const tri = (x: Iterable<number>) => [...new Set(x)].sort((a, b) => a - b)
  return { ok: echecs.length === 0, details: echecs.map(e => e.detail), pagesEnEchec: tri(echecs.map(e => e.page)), echecs, notes }
}
