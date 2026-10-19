// Lecture des dates françaises (« 1er juin 2026 », « 01/06/2026 », « 15 août ») en ISO. Module pur.
import { MOIS } from './lexique.ts'

// L'ordre de `MOIS` (lexique.ts) est celui du calendrier : indice + 1 = numéro du mois (couvert par dates.test.ts).
const MOIS_RE = MOIS.split('|').map(m => new RegExp(`^(?:${m})$`, 'i'))
// « dernier jour de février [2027] » : le jour dépend du mois et de l'année, calculé dans dateIso. Jamais « avant-dernier jour »
// (avec tiret, tiret typographique ou espace) ni « sous-dernier » : `\b` seul s'arrêterait entre le tiret et « dernier ».
const DERNIER_JOUR = String.raw`(?<![-\u2010-\u2015])(?<!avant[\s\u2010-\u2015-]+)dernier\s+jour\s+(?:de\s+|d['’]\s*)`
const FRAGMENT = new RegExp(String.raw`^(\d{1,2})(?:er|"|’|')?\s+(${MOIS})(?:\s+(20\d\d))?$|^(\d{2})[/-](\d{2})[/-](20\d\d)$|^${DERNIER_JOUR}(${MOIS})(?:\s+(20\d\d))?$`, 'i')
const RE_DATES = new RegExp(String.raw`\b\d{1,2}(?:er|"|’|')?\s+(?:${MOIS})\b(?:\s+20\d\d\b)?|\b\d{2}[/-]\d{2}[/-]20\d\d\b|\b${DERNIER_JOUR}(?:${MOIS})\b(?:\s+20\d\d\b)?`, 'gi')

export function dateIso(fragment: string, saison: string): { iso: string; anneeDeduite: boolean } | null {
  const s = /^(20\d\d)-(20\d\d)$/.exec(saison)
  const m = FRAGMENT.exec(fragment.trim())
  if (!s || !m || +s[2] !== +s[1] + 1) return null
  const an1 = +s[1], an2 = +s[2]
  const nomMois = m[2] ?? m[7]
  const mois = nomMois ? MOIS_RE.findIndex(re => re.test(nomMois)) + 1 : +m[5]
  let annee = +(m[3] ?? m[6] ?? m[8] ?? 0)
  const anneeDeduite = !annee
  if (anneeDeduite) annee = mois >= 7 ? an1 : an2
  if (annee !== an1 && annee !== an2) return null
  const jour = m[7] ? new Date(Date.UTC(annee, mois, 0)).getUTCDate() : +(m[1] ?? m[4])
  const d = new Date(Date.UTC(annee, mois - 1, jour))
  if (mois < 1 || mois > 12 || d.getUTCFullYear() !== annee || d.getUTCMonth() !== mois - 1 || d.getUTCDate() !== jour) return null
  return { iso: d.toISOString().slice(0, 10), anneeDeduite }
}

// Jour nu suivi de « au <date> » (« du 1er au 15 septembre 2026 ») : il hérite du mois et de l'année de la date qui suit,
// lue ensuite par RE_DATES (lookahead : rien n'est consommé).
const JOUR_NU = String.raw`\b(\d{1,2})(?:er|"|’|')?\s+au\s+(?=\d{1,2}(?:er|"|’|')?\s+(${MOIS})\b(?:\s+(20\d\d)\b)?)`
const RE_DATES_PLAGES = new RegExp(`${JOUR_NU}|${RE_DATES.source}`, 'gi')

// Toutes les dates ISO valides du texte, dans l'ordre, avec leur position [debut, fin) ; jour nu : position du jour seul.
export function datesPositionnees(t: string, saison: string): { iso: string; debut: number; fin: number }[] {
  return [...t.matchAll(RE_DATES_PLAGES)].flatMap(m => {
    const d = dateIso(m[1] ? [m[1], m[2], m[3]].filter(Boolean).join(' ') : m[0], saison)
    return d ? [{ iso: d.iso, debut: m.index, fin: m.index + (m[1] ? m[1].length : m[0].length) }] : []
  })
}

// Toutes les dates ISO valides du texte, dans l'ordre.
export const datesDe = (t: string, saison: string): string[] => datesPositionnees(t, saison).map(d => d.iso)

// Entre les deux dates d'une plage : « au » / « jusqu'au » seul (le suffixe d'un jour nu, « 1er au », compris).
const RE_ENTRE_PLAGE = /^(?:er|"|’|')?\s*(?:au|jusqu'au|jusqu au)\s+$/i

/** Première date du texte, et la suivante si les deux forment une plage « du A au B » ; null sans date. */
export function premierePlage(t: string, saison: string): { debut: string; fin: string | null } | null {
  const [a, b] = datesPositionnees(t, saison)
  if (!a) return null
  return { debut: a.iso, fin: b && RE_ENTRE_PLAGE.test(t.slice(a.fin, b.debut)) ? b.iso : null }
}

// Nombre de dates écrites dans le texte, avec ou sans année (« 1er septembre », « 15/08/2026 »), sans les valider.
// Plus large que `compterDates` (lexique.ts, qui exige une année) : sert à ne pas écarter un article « du 1er septembre au 28 février ».
export const compterDatesLarges = (t: string): number => (t.match(RE_DATES) ?? []).length
