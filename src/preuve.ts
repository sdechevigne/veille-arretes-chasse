// Contrôle C1 : chaque période (ou suppression) lue par Claude doit être appuyée par une citation exacte du texte,
// portant l'espèce et les deux dates, complétée au besoin d'extraits voisins de la même page (arrêtés en tableau).
// Une date absente de la preuve n'est admise que par un renvoi aux dates générales écrites dans l'arrêté. Module pur.
import { compterDatesLarges, datesDe, datesPositionnees, premierePlage } from './dates.ts'
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
  | 'date_ecartee' | 'extrait_introuvable' | 'extraits_eloignes' | 'extrait_ambigu'
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

const RENVOIS = {
  ouverture: { ensemble: 'ouvertures', nom: 'ouverture générale', defini: "l'ouverture générale" },
  cloture: { ensemble: 'clotures', nom: 'clôture générale', defini: 'la clôture générale' },
} as const
type TypeRenvoi = keyof typeof RENVOIS
/** Renvoi aux dates générales vu dans une preuve ; `ecarte` = raison de son refus par la règle de ligne (Ruling R52).
 *  `relatif: 'jusqua'` = « (jusqu')à l'ouverture générale », fin de période (Ruling R54). */
interface RenvoiVu { type: TypeRenvoi; relatif: 'veille' | 'lendemain' | 'jusqua' | null; ecarte?: string }

// « ouverture / clôture / fermeture générale », éventuellement précédée de « la veille de » / « le lendemain de », qui doit
// lui être collé (Ruling R48) ; ou « à / jusqu'à / jusqu'au jour de l'ouverture générale » (Ruling R54), collé lui aussi.
// Global : à n'employer qu'avec matchAll (`.test` garderait son `lastIndex`).
const RE_RENVOI = /\b(?:(veille|lendemain) de (?:la |l' ?|l )?)?(ouverture|cloture|fermeture) generale\b|\b(?:jusqu' ?au jour de |(?:jusqu' ?|jusqu )?a )(?:l' ?|l )ouverture generale\b/g

/** Renvois d'un texte normalisé, situés dans ce texte. */
const renvoisDe = (t: string): (RenvoiVu & Occurrence)[] => [...t.matchAll(RE_RENVOI)].map(m => ({
  type: m[2] === undefined || m[2] === 'ouverture' ? 'ouverture' : 'cloture', relatif: (m[2] === undefined ? 'jusqua' : m[1] ?? null) as RenvoiVu['relatif'],
  debut: m.index, fin: m.index + m[0].length,
}))

/** Renvoi de la preuve qui justifierait une date absente, ou null : une date d'ouverture renvoie à l'ouverture générale, une
 *  date de fermeture à la clôture générale ; « la veille de » / « le lendemain de » l'une ou l'autre décale d'un jour ;
 *  « (jusqu')à l'ouverture générale » ne prouve qu'une fermeture, la veille de l'ouverture générale (Ruling R54).
 *  `vus` porte les renvois retenus en tête ; celui qui répond rend sa raison d'écartement s'il en a une (Ruling R52). */
function renvoi(date: string, ouverture: boolean, vus: RenvoiVu[], generales: DatesGenerales): { nom: string; ecarte?: string } | null {
  const direct = RENVOIS[ouverture ? 'ouverture' : 'cloture']
  const v = vus.find(x => x.relatif !== 'jusqua' && (x.type === 'ouverture') === ouverture)
  if (v && generales[direct.ensemble].has(date)) return { nom: direct.nom, ecarte: v.ecarte }
  for (const x of vus) {
    if (x.relatif === 'jusqua') {
      if (!ouverture && generales.ouvertures.has(decaler(date, 1))) return { nom: `veille de ${RENVOIS.ouverture.defini}`, ecarte: x.ecarte }
      continue
    }
    if (!x.relatif) continue
    const cible = RENVOIS[x.type]
    if (generales[cible.ensemble].has(decaler(date, x.relatif === 'veille' ? 1 : -1))) return { nom: `${x.relatif} de ${cible.defini}`, ecarte: x.ecarte }
  }
  return null
}

/** Fragment d'une preuve composée, situé sur la page normalisée. */
interface Fragment { texte: string; debut: number; fin: number }
interface Occurrence { debut: number; fin: number }
interface DateSituee extends Occurrence { iso: string; fragment: Fragment }
/** Renvoi situé sur la page, tout entier dans `fragment` (Ruling R53). */
interface RenvoiSitue extends Occurrence { type: TypeRenvoi; relatif: RenvoiVu['relatif']; fragment: Fragment }

const autreEspece = (t: string, espece: string): string | undefined =>
  Object.entries(ESPECES_RECHERCHE).find(([code, re]) => code !== espece && re.test(t))?.[0]

/** Preuve composée (Rulings R47, R50, R51, R52, R53) : dans un tableau, la ligne d'une espèce commence à son nom. Un extrait qui apporte
 *  l'espèce absente de la citation doit la précéder sans autre espèce intercalée ; puis, sur l'occurrence de l'espèce la plus proche
 *  avant eux (`occ`), ne comptent que les dates ET les renvois situés après `occ` sans autre espèce entre `occ` et eux. Rend les
 *  extraits à écarter (avec leur raison), les dates retenues, les dates écartées et les renvois (retenus d'abord, puis écartés avec
 *  leur raison ; un renvoi n'est lu que contigu dans un seul fragment, jamais recollé entre deux, R53) ; sans occurrence de l'espèce, rien n'est filtré (l'espèce manque déjà). Positions sur la page normalisée. */
function preuveComposee(page: string, citation: Fragment, extraits: Fragment[], motif: RegExp, espece: string, saison: string)
  : { ambigus: Map<Fragment, string>; dates: string[]; ecartees: Map<string, string>; renvois: RenvoiVu[] } {
  const tranche = (f: Fragment) => page.slice(f.debut, f.fin)
  const especesDe = (f: Fragment): Occurrence[] => [...tranche(f).matchAll(new RegExp(motif.source, `${motif.flags.replace('g', '')}g`))]
    .map(m => ({ debut: f.debut + m.index, fin: f.debut + m.index + m[0].length }))
  const datesDeFragment = (f: Fragment): DateSituee[] => datesPositionnees(tranche(f), saison)
    .map(d => ({ iso: d.iso, debut: f.debut + d.debut, fin: f.debut + d.fin, fragment: f }))
  const ambigus = new Map<Fragment, string>()
  if (!especesDe(citation).length) {
    // L'espèce vient d'un extrait : il doit précéder la citation (jusqu'à sa fin si elle porte des dates, son début sinon).
    const borne = datesDeFragment(citation).length ? citation.fin : citation.debut
    for (const e of extraits) {
      const [s] = especesDe(e)
      if (!s) continue
      if (s.debut > citation.debut) { ambigus.set(e, 'après la citation'); continue }
      const code = autreEspece(page.slice(s.fin, borne), espece)
      if (code) ambigus.set(e, `séparé de la citation par une autre espèce (${code})`)
    }
  }
  const gardes = [citation, ...extraits.filter(e => !ambigus.has(e))]
  const dates = gardes.flatMap(datesDeFragment)
  // Renvoi (Ruling R53) : contigu dans UN SEUL fragment, citation ou extrait. Aucun recollage entre fragments : la queue d'une
  // cellule coupée (« Clôture » / « générale ») n'est jamais située, sa position ne prouverait rien.
  const renvois: RenvoiSitue[] = gardes.flatMap(f => renvoisDe(tranche(f)).map(v => ({ type: v.type, relatif: v.relatif,
    debut: f.debut + v.debut, fin: f.debut + v.fin, fragment: f })))
  const vu = (v: RenvoiSitue, ecarte?: string): RenvoiVu => ({ type: v.type, relatif: v.relatif, ...(ecarte ? { ecarte } : {}) })
  const uniques = (ds: DateSituee[]) => [...new Map(ds.map(d => [d.debut, d.iso])).values()]
  const occurrences = gardes.flatMap(especesDe)
  if (!occurrences.length) return { ambigus, dates: uniques(dates), ecartees: new Map(), renvois: renvois.map(v => vu(v)) }
  const valide = (s: Occurrence, x: Occurrence) => x.debut >= s.fin && !autreEspece(page.slice(s.fin, x.fin), espece)
  // `occ` : l'occurrence qui valide le plus de dates et de renvois ; à égalité, la plus proche avant eux (la plus tardive).
  const portes: Occurrence[] = [...dates, ...renvois]
  const occ = occurrences.reduce((m, s) => {
    const n = portes.filter(x => valide(s, x)).length, nm = portes.filter(x => valide(m, x)).length
    return n > nm || (n === nm && s.debut > m.debut) ? s : m
  })
  // Extrait présent pour ses seules dates et renvois, tous écartés (ou qui n'apporte ni date, ni renvoi, ni espèce) : ambigu
  // (il ne porte pas non plus l'occurrence retenue).
  for (const e of gardes.slice(1)) {
    const siens = [...dates, ...renvois].filter(x => x.fragment === e).sort((a, b) => a.debut - b.debut)
    if (siens.some(x => valide(occ, x))) continue
    if (occ.debut >= e.debut && occ.fin <= e.fin) continue
    if (!siens.length) { if (!especesDe(e).length) ambigus.set(e, "n'apporte ni l'espèce, ni date, ni renvoi retenu"); continue }
    const x = siens[0]
    ambigus.set(e, x.debut < occ.fin ? "placé avant l'espèce" : `séparé de l'espèce par une autre espèce (${autreEspece(page.slice(occ.fin, x.fin), espece)})`)
  }
  const retenues = dates.filter(d => valide(occ, d))
  // Dates écartées (Ruling R51) : présentes dans un fragment conservé, refusées par la règle ci-dessus, et introuvables
  // ailleurs dans la preuve. Celles d'un extrait ambigu ne comptent pas : cet extrait est retiré de la preuve.
  const vues = new Set(retenues.map(d => d.iso))
  const ecartees = new Map<string, string>()
  for (const d of dates) {
    if (vues.has(d.iso) || ecartees.has(d.iso) || valide(occ, d) || ambigus.has(d.fragment)) continue
    ecartees.set(d.iso, d.debut < occ.fin ? "date placée avant l'espèce"
      : `autre espèce entre l'espèce et la date : ${autreEspece(page.slice(occ.fin, d.fin), espece)}`)
  }
  // Renvois écartés (Ruling R52) : même règle de ligne ; ceux d'un extrait ambigu disparaissent avec lui.
  const ecartes = renvois.filter(v => !valide(occ, v) && !ambigus.has(v.fragment))
    .map(v => vu(v, v.debut < occ.fin ? "renvoi placé avant l'espèce"
      : `autre espèce entre l'espèce et le renvoi : ${autreEspece(page.slice(occ.fin, v.fin), espece)}`))
  return { ambigus, dates: uniques(retenues), ecartees, renvois: [...renvois.filter(v => valide(occ, v)).map(v => vu(v)), ...ecartes] }
}

/** Extrait situé à son occurrence exacte la plus proche du début de la citation (Ruling R54 ; à égalité, la première) ; un
 *  extrait qui porte l'espèce de la période (`motif`) est cherché d'abord AVANT la citation, la ligne d'une espèce commençant à
 *  son nom (Ruling R57), puis après faute d'occurrence avant. Sans occurrence exacte, recherche tolérante de trouverCitation.
 *  Positions sur la page normalisée. La citation, elle, garde sa première occurrence (trouverCitation). */
function situerExtrait(extrait: string, pageNormalisee: string, texte: string, debutCitation: number, motif: RegExp | undefined)
  : { ok: boolean; score: number; debut: number } {
  const e = normaliser(extrait)
  const occurrences: number[] = []
  for (let i = e ? pageNormalisee.indexOf(e) : -1; i >= 0; i = pageNormalisee.indexOf(e, i + 1)) occurrences.push(i)
  const avant = motif?.test(e) ? occurrences.filter(i => i < debutCitation) : []
  const candidates = avant.length ? avant : occurrences
  const meilleur = candidates.reduce((m, i) => (m < 0 || Math.abs(i - debutCitation) < Math.abs(m - debutCitation) ? i : m), -1)
  return meilleur >= 0 ? { ok: true, score: 1, debut: meilleur } : trouverCitation(extrait, texte)
}

// Mots d'un renvoi aux dates générales, même isolés : la queue d'une cellule coupée (« générale ») n'est pas un extrait
// inutile, elle reste jugée par la règle de ligne (R53 : extrait_ambigu).
const RE_MOT_RENVOI = /\b(?:ouvertures?|clotures?|fermetures?|generales?|veille|lendemain)\b/

/** Extrait inutile (Ruling R54) : texte normalisé sans aucune espèce (toutes espèces, sika compris), sans date et sans mot de
 *  renvoi (mode de chasse, restriction, titre). Une date écrite hors saison (compterDatesLarges) suffit à le garder : elle est
 *  suspecte, pas inutile. */
const extraitInutile = (t: string, saison: string): boolean =>
  !RE_SIKA.test(t) && !Object.values(ESPECES_RECHERCHE).some(re => re.test(t))
  && !datesPositionnees(t, saison).length && !compterDatesLarges(t) && !RE_MOT_RENVOI.test(t)

/** Seuil sous lequel une citation non retrouvée est jugée inventée (et non abîmée par l'OCR). */
export const SEUIL_CITATION_ABIMEE = 0.5

/** Échec qu'un texte OCR abîmé peut expliquer, donc levable par une lecture sur image concordante.
 *  Un extrait éloigné ou ambigu ne l'est jamais (assemblage possible de morceaux sans rapport), ni une date écartée
 *  (Ruling R51 : une lecture sur image concordante répéterait l'emprunt à la ligne voisine). Pour un extrait court
 *  (nom d'espèce), le seuil de similarité 0,5 est faible : la levée repose alors sur la concordance des lectures sur image. */
export const levableSurImage = (e: EchecPreuve): boolean =>
  e.nature === 'espece_absente' || e.nature === 'nombre_altere' || e.nature === 'date_absente'
  || ((e.nature === 'citation_introuvable' || e.nature === 'extrait_introuvable') && (e.score ?? 0) >= SEUIL_CITATION_ABIMEE)

export function verifierPreuves(lecture: LectureClaude, pages: PageTexte[], saison: string): VerificationPreuves {
  const echecs: EchecPreuve[] = [], notes: string[] = []
  let generales: DatesGenerales | undefined

  // Vérifie page, citation, extraits et espèce ; renvoie le texte de la preuve (citation et extraits retenus) et ses dates
  // si la citation est retrouvée (pour poursuivre sur les dates), null sinon.
  const verifierCitation = (etiquette: string, espece: string, sousType: string | null, citation: string, numPage: number, extraits: string[])
    : { texte: string; dates: string[]; ecartees: Map<string, string>; renvois: RenvoiVu[] } | null => {
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
    // Extraits : retrouvés sur la même page, près de la citation ; un extrait en échec ne prouve rien.
    const motif = motifEspece(espece, sousType)
    const fragment = (texte: string, debut: number): Fragment => ({ texte, debut, fin: debut + normaliser(texte).length })
    const pageNormalisee = normaliser(page.texte)
    const retenus: Fragment[] = []
    for (const extrait of extraits) {
      const e = situerExtrait(extrait, pageNormalisee, page.texte, trouvee.debut, motif)
      if (!e.ok) { echouer('extrait_introuvable', `${prefixe}extrait « ${extrait} » introuvable (similarité ${pct(e.score)})`, e.score); continue }
      // Extrait inutile (Ruling R54) : ni espèce, ni date, ni mot de renvoi ; il ne prouve rien et n'est pas compté.
      if (extraitInutile(normaliser(extrait), saison)) { notes.push(`${prefixe}extrait « ${extrait} » sans espèce, date ni renvoi, ignoré`); continue }
      const ecart = Math.abs(e.debut - trouvee.debut)
      if (ecart > DISTANCE_MAX_FRAGMENTS) { echouer('extraits_eloignes', `${prefixe}extrait « ${extrait} » trop éloigné de la citation (${ecart} caractères)`); continue }
      retenus.push(fragment(extrait, e.debut))
    }
    // Preuve composée : l'espèce ouvre la ligne de ses dates (R47, R50) ; une preuve sans extrait reste inchangée.
    const cite = fragment(citation, trouvee.debut)
    const composee = retenus.length && motif ? preuveComposee(normaliser(page.texte), cite, retenus, motif, espece, saison) : null
    const ambigus = composee?.ambigus ?? new Map<Fragment, string>()
    for (const [e, raison] of ambigus) echouer('extrait_ambigu', `${prefixe}extrait « ${e.texte} » ${raison}`)
    const preuve = [cite, ...retenus.filter(e => !ambigus.has(e))]
    const texte = preuve.map(f => f.texte).join(' ')
    if (!motif) echouer('espece_sans_motif', `${prefixe}espèce sans motif de recherche`)
    else if (!motif.test(texte)) echouer('espece_absente', `${prefixe}espèce absente de la citation`)
    else if (!motif.test(citation)) notes.push(`${prefixe}espèce prouvée par extrait « ${preuve.find(f => motif.test(f.texte))!.texte} »`)
    return { texte, dates: composee?.dates ?? datesDe(normaliser(texte), saison), ecartees: composee?.ecartees ?? new Map(),
      renvois: composee?.renvois ?? renvoisDe(normaliser(texte)).map(v => ({ type: v.type, relatif: v.relatif })) }
  }

  lecture.periodes.forEach((p, i) => {
    const { citation, page, annee_deduite, extraits } = p.preuve
    const verifiee = verifierCitation(`période ${i + 1}`, p.espece_code, p.sous_type, citation, page, extraits)
    if (verifiee === null) return
    const cle = (d: string) => (annee_deduite ? d.slice(5) : d)
    const vues = verifiee.dates.map(cle)
    const ecartees = new Map([...verifiee.ecartees].map(([iso, raison]) => [cle(iso), raison]))
    const prefixe = `période ${i + 1} (${p.espece_code}) : `
    for (const [libelle, date, ouverture] of [["d'ouverture", p.date_ouverture, true], ['de fermeture', p.date_fermeture, false]] as const) {
      if (vues.includes(cle(date))) continue
      // Date écrite dans la preuve mais refusée par la règle de ligne (Ruling R51) : jamais levable, et aucun renvoi ne la rattrape.
      const ecartee = ecartees.get(cle(date))
      if (ecartee) { echecs.push({ page, nature: 'date_ecartee', detail: `${prefixe}date ${libelle} ${date} écartée (${ecartee})` }); continue }
      // Renvoi admis seulement si la preuve porte au plus une date littérale distincte, comptée par valeur (Rulings R48, R57) :
      // au-delà, elle décrit d'autres périodes ; une même date écrite deux fois (colonne des dates et des conditions) compte une fois.
      const r = new Set(vues).size <= 1 ? renvoi(date, ouverture, verifiee.renvois, (generales ??= datesGenerales(pages, saison))) : null
      if (r && !r.ecarte) notes.push(`${prefixe}date ${libelle} ${date} = ${r.nom} (renvoi)`)
      // Renvoi présent mais refusé par la règle de ligne (Ruling R52) : la date est écartée, pas absente.
      else if (r) echecs.push({ page, nature: 'date_ecartee', detail: `${prefixe}date ${libelle} ${date} écartée (${r.ecarte})` })
      else echecs.push({ page, nature: 'date_absente', detail: `${prefixe}date ${libelle} ${date} absente de la citation` })
    }
  })
  lecture.suppressions.forEach((s, i) => { verifierCitation(`suppression ${i + 1}`, s.espece_code, s.sous_type, s.citation, s.page, s.extraits) })

  const tri = (x: Iterable<number>) => [...new Set(x)].sort((a, b) => a - b)
  return { ok: echecs.length === 0, details: echecs.map(e => e.detail), pagesEnEchec: tri(echecs.map(e => e.page)), echecs, notes }
}
