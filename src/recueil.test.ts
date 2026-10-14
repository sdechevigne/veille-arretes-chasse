import { describe, it, expect } from 'vitest'
import { lireSommaire, decouperParEntetes, actesChasse, pagesAOcr } from './recueil.ts'
import type { PageTexte } from './types.ts'

const page = (n: number, texte: string): PageTexte => ({ n, source: 'native', texte, nbDates: 0, nbEspeces: 0 })
const SOMMAIRE = `RECUEIL DES ACTES ADMINISTRATIFS N° 50-2026-160
SOMMAIRE
DDTM / Service Environnement
Arrêté n° 2026-DDTM-SE-123 portant ouverture et clôture de la chasse pour la campagne 2026-2027 ............ 3
Arrêté préfectoral portant réglementation de la pêche en eau douce ........................................... 9
Préfecture / Cabinet
Arrêté portant attribution de la médaille d'honneur .................................................................. 14
Arrêté modifiant l'arrêté du 12 mai 2026 relatif aux espèces susceptibles d'occasionner des dégâts (ESOD) ... 18`

describe('lireSommaire', () => {
  it('lit titres et pages, calcule les fins', () => {
    const a = lireSommaire([page(1, SOMMAIRE)], 22)!
    expect(a.map(x => [x.pageDebut, x.pageFin])).toEqual([[3, 8], [9, 13], [14, 17], [18, 22]])
    expect(a[0].titre).toMatch(/ouverture et clôture de la chasse/)
  })
  it('null si pas de sommaire', () => { expect(lireSommaire([page(1, 'ARRÊTÉ n° 1\nArticle 1 : bla')], 3)).toBeNull() })
})
describe('decouperParEntetes', () => {
  it('nouvel acte à chaque page avec en-tête ARRÊTÉ', () => {
    const pages = [page(1, 'PRÉFET\nARRÊTÉ PRÉFECTORAL N° 1\nVU…'), page(2, 'Article 2 …'), page(3, 'Arrêté n° 2 portant pêche\nVU…'), page(4, 'suite')]
    expect(decouperParEntetes(pages).map(a => [a.pageDebut, a.pageFin])).toEqual([[1, 2], [3, 4]])
  })
})
describe('actesChasse + pagesAOcr', () => {
  it('marque chasse par titre ou texte', () => {
    const actes = lireSommaire([page(1, SOMMAIRE)], 22)!
    const pages = [page(1, SOMMAIRE), ...Array.from({ length: 21 }, (_, i) => page(i + 2, 'texte neutre'))]
    const c = actesChasse(actes, pages).filter(a => a.chasse)
    expect(c.map(a => a.pageDebut)).toEqual([3, 18])
    expect(pagesAOcr(actesChasse(actes, pages), 22)).toEqual([3, 4, 5, 6, 7, 8, 18, 19, 20, 21, 22])
  })
  it('sans sommaire : ≤ 60 pages → toutes ; au-delà → échantillon', () => {
    expect(pagesAOcr(null, 10)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
    const e = pagesAOcr(null, 200); expect(e.slice(0, 6)).toEqual([1, 2, 3, 4, 5, 6]); expect(e).toContain(9); expect(e).not.toContain(8); expect(e.length).toBeLessThan(80)
  })
})
