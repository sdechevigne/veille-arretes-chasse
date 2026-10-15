// Contrôle C1 : chaque période (ou suppression) lue par Claude doit être appuyée par une citation exacte du texte,
// portant l'espèce et les deux dates. Module pur.
import { datesDe } from './dates.ts'
import { ESPECES_RECHERCHE } from './lexique.ts'
import { normaliser, trouverCitation } from './texte.ts'
import type { LectureClaude, PageTexte } from './types.ts'

const RE_SIKA = /\bsika\b/i

const motifEspece = (code: string, sousType: string | null): RegExp | undefined =>
  sousType === 'cerf_sika' ? RE_SIKA : ESPECES_RECHERCHE[code]

const pct = (x: number) => x.toFixed(2).replace('.', ',')

export function verifierPreuves(lecture: LectureClaude, pages: PageTexte[], saison: string): { ok: boolean; details: string[]; aRelire: number[] } {
  const details: string[] = []
  const aRelire = new Set<number>()

  // Vérifie page, citation et espèce ; renvoie vrai si la citation est retrouvée (pour poursuivre sur les dates).
  const verifierCitation = (etiquette: string, espece: string, sousType: string | null, citation: string, numPage: number): boolean => {
    const prefixe = `${etiquette} (${espece}) : `
    const page = pages.find(p => p.n === numPage)
    if (!page) { details.push(`${prefixe}page ${numPage} introuvable`); return false }
    const trouvee = trouverCitation(citation, page.texte)
    if (!trouvee.ok) { details.push(`${prefixe}citation introuvable (similarité ${pct(trouvee.score)})`); return false }
    const motif = motifEspece(espece, sousType)
    if (!motif) details.push(`${prefixe}espèce sans motif de recherche`)
    else if (!motif.test(citation)) {
      details.push(`${prefixe}espèce absente de la citation`)
      aRelire.add(numPage) // OCR en colonnes : l'espèce est peut-être lisible sur l'image de la page
    }
    return true
  }

  lecture.periodes.forEach((p, i) => {
    const { citation, page, annee_deduite } = p.preuve
    if (!verifierCitation(`période ${i + 1}`, p.espece_code, p.sous_type, citation, page)) return
    const vues = datesDe(normaliser(citation), saison).map(d => (annee_deduite ? d.slice(5) : d))
    const prefixe = `période ${i + 1} (${p.espece_code}) : `
    for (const [libelle, date] of [['ouverture', p.date_ouverture], ['fermeture', p.date_fermeture]] as const) {
      if (!vues.includes(annee_deduite ? date.slice(5) : date)) details.push(`${prefixe}date de ${libelle} ${date} absente de la citation`)
    }
  })
  lecture.suppressions.forEach((s, i) => { verifierCitation(`suppression ${i + 1}`, s.espece_code, s.sous_type, s.citation, s.page) })

  return { ok: details.length === 0, details, aRelire: [...aRelire].sort((a, b) => a - b) }
}
