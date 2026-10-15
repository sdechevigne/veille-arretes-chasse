import { describe, it, expect } from 'vitest'
import { decouperArticles, articlesDates } from './articles.ts'
import type { PageTexte } from './types.ts'

const page = (n: number, texte: string): PageTexte => ({ n, source: 'native', texte, nbDates: 0, nbEspeces: 0 })

const PAGES = [
  page(1, `PRÉFET DU DÉPARTEMENT
ARRÊTÉ n° 2026-123 du 1er juin 2026
Vu le code de l'environnement,
ARRÊTE
Article 1er : Le sanglier peut être chassé du 1er juin 2026 au 28 février 2027.
Article 2 : Le chevreuil est chassé du 15 septembre 2026`),
  page(2, `au 31 janvier 2027 en battue uniquement.
Article 3 : Le présent arrêté est publié au recueil des actes administratifs.
Fait à Chantilly, le préfet.`),
]

describe('decouperArticles', () => {
  const articles = decouperArticles(PAGES)
  it("découpe l'en-tête et les 3 articles", () => {
    expect(articles.map(a => a.numero)).toEqual([null, '1', '2', '3'])
    expect(articles[0].titre).toBe('en-tête')
  })
  it('retient la page de début, y compris pour un article à cheval sur deux pages', () => {
    expect(articles.map(a => a.pageDebut)).toEqual([1, 1, 1, 2])
    expect(articles[2].texte).toContain('au 31 janvier 2027')
  })
  it('rattache la signature au dernier article', () => expect(articles[3].texte).toContain('le préfet'))
  it('reconnaît « premier » et sans en-tête ne crée pas d\'en-tête vide', () => {
    const a = decouperArticles([page(1, 'Article premier : x\nArticle 2 : y')])
    expect(a.map(x => x.numero)).toEqual(['1', '2'])
  })
  it("garde tout le texte en en-tête s'il n'y a aucun article", () => {
    const a = decouperArticles([page(3, 'Simple avis.')])
    expect(a).toHaveLength(1)
    expect(a[0]).toMatchObject({ numero: null, titre: 'en-tête', pageDebut: 3 })
  })
})

describe('articlesDates', () => {
  it("garde l'en-tête et les articles portant une date, écarte l'article sans date", () => {
    const gardes = articlesDates(decouperArticles(PAGES))
    expect(gardes.map(a => a.numero)).toEqual([null, '1', '2'])
  })
  it('garde un article dont les dates sont sans année ou numériques', () => {
    const a = decouperArticles([page(1, 'ARRÊTÉ\nArticle 1 : le cerf : du 1er septembre au 28 février.\nArticle 2 : le lièvre du 01/10/2026 au 30/11/2026.\nArticle 3 : sans date.')])
    expect(articlesDates(a).map(x => x.numero)).toEqual([null, '1', '2'])
  })
})
