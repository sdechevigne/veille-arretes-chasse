// Lecture des dates françaises (« 1er juin 2026 », « 01/06/2026 », « 15 août ») en ISO. Module pur.
import { MOIS } from './lexique.ts'

// L'ordre de `MOIS` (lexique.ts) est celui du calendrier : indice + 1 = numéro du mois (couvert par dates.test.ts).
const MOIS_RE = MOIS.split('|').map(m => new RegExp(`^(?:${m})$`, 'i'))
const FRAGMENT = new RegExp(String.raw`^(\d{1,2})(?:er|"|’|')?\s+(${MOIS})(?:\s+(20\d\d))?$|^(\d{2})[/-](\d{2})[/-](20\d\d)$`, 'i')
const RE_DATES = new RegExp(String.raw`\b\d{1,2}(?:er|"|’|')?\s+(?:${MOIS})\b(?:\s+20\d\d\b)?|\b\d{2}[/-]\d{2}[/-]20\d\d\b`, 'gi')

export function dateIso(fragment: string, saison: string): { iso: string; anneeDeduite: boolean } | null {
  const s = /^(20\d\d)-(20\d\d)$/.exec(saison)
  const m = FRAGMENT.exec(fragment.trim())
  if (!s || !m || +s[2] !== +s[1] + 1) return null
  const an1 = +s[1], an2 = +s[2]
  const jour = +(m[1] ?? m[4])
  const mois = m[2] ? MOIS_RE.findIndex(re => re.test(m[2])) + 1 : +m[5]
  let annee = m[3] ? +m[3] : m[6] ? +m[6] : 0
  const anneeDeduite = !annee
  if (anneeDeduite) annee = mois >= 7 ? an1 : an2
  if (annee !== an1 && annee !== an2) return null
  const d = new Date(Date.UTC(annee, mois - 1, jour))
  if (mois < 1 || mois > 12 || d.getUTCFullYear() !== annee || d.getUTCMonth() !== mois - 1 || d.getUTCDate() !== jour) return null
  return { iso: d.toISOString().slice(0, 10), anneeDeduite }
}

// Toutes les dates ISO valides du texte, dans l'ordre.
export function datesDe(t: string, saison: string): string[] {
  return (t.match(RE_DATES) ?? []).flatMap(f => { const d = dateIso(f, saison); return d ? [d.iso] : [] })
}

// Nombre de dates écrites dans le texte, avec ou sans année (« 1er septembre », « 15/08/2026 »), sans les valider.
// Plus large que `compterDates` (lexique.ts, qui exige une année) : sert à ne pas écarter un article « du 1er septembre au 28 février ».
export const compterDatesLarges = (t: string): number => (t.match(RE_DATES) ?? []).length
