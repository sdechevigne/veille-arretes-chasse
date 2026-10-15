import { describe, it, expect } from 'vitest'
import { comparerProjetSigne } from './projet.ts'
import type { Article } from './types.ts'

const art = (numero: string | null, texte: string): Article => ({ numero, titre: numero ? `Article ${numero}` : 'en-tête', pageDebut: 1, texte })

const PROJET: Article[] = [
  art(null, "PROJET D'ARRÊTÉ soumis à la consultation du public\nArrêté n° du ..."),
  art('1', 'Article 1 : Le sanglier est chassé du 1er juin 2026 au 28 février 2027.'),
  art('2', 'Article 2 : Vu l\'avis de la commission du 3 mai 2026 ; Le chevreuil est chassé du 15 septembre 2026 au 31 janvier 2027.'),
  art('3', "Article 3 : Le renard est chassé du 1er septembre 2026 au 28 février 2027.\nFait à , le\nLe Préfet,"),
]
const SIGNE: Article[] = [
  art(null, 'ARRÊTÉ n° 2026-123 du 12 août 2026'),
  art('1', 'Article 1 : Le sanglier est chassé du 1er juin 2026 au 28 février 2027.'),
  art('2', 'Article 2 : Le chevreuil est chassé du 15 septembre 2026 au 31 janvier 2027.'),
  art('3', "Article 3 : Le renard est chassé du 1er septembre 2026 au 28 février 2027.\nFait à Lille, le 14 août 2026\nLe Préfet,\nJean DUPONT"),
]

describe('comparerProjetSigne', () => {
  it('identique quand seules les mentions variables diffèrent (en-tête, avis, fait à … le …)', () => {
    expect(comparerProjetSigne(PROJET, SIGNE)).toEqual({ identique: true, articlesDifferents: [] })
  })

  it('le bloc de signature (lieu, date, nom du signataire) est ignoré', () => {
    const projet = [...PROJET, art('4', 'Article 4 : Le préfet est chargé de l\'exécution.\nFait à , le\nLe Préfet,')]
    const signe = [...SIGNE, art('4', 'Article 4 : Le préfet est chargé de l\'exécution.\nFait à Lille, le 14 août 2026\nLe Préfet,\nJean DUPONT')]
    expect(comparerProjetSigne(projet, signe)).toEqual({ identique: true, articlesDifferents: [] })
  })

  it('un changement avant le bloc de signature reste détecté', () => {
    const signe = SIGNE.map(a => (a.numero === '3' ? art('3', 'Article 3 : Le renard est chassé du 1er septembre 2026 au 31 janvier 2027.\nFait à Lille, le 14 août 2026\nLe Préfet,\nJean DUPONT') : a))
    expect(comparerProjetSigne(PROJET, signe)).toEqual({ identique: false, articlesDifferents: ['3'] })
  })

  it('un article dont une date change est signalé', () => {
    const signe = SIGNE.map(a => (a.numero === '3' ? art('3', 'Article 3 : Le renard est chassé du 1er septembre 2026 au 31 janvier 2027.') : a))
    expect(comparerProjetSigne(PROJET, signe)).toEqual({ identique: false, articlesDifferents: ['3'] })
  })

  it('un article non daté ajouté d\'un seul côté est différent', () => {
    const signe = [...SIGNE, art('5', 'Article 5 : la chasse du blaireau est suspendue jusqu\'à nouvel ordre.')]
    const r = comparerProjetSigne(PROJET, signe)
    expect(r.identique).toBe(false)
    expect(r.articlesDifferents).toContain('5')
  })

  it('les articles sans date présents des deux côtés sont ignorés', () => {
    const projet = [...PROJET, art('4', 'Article 4 : Le préfet est chargé de l\'exécution.')]
    const signe = [...SIGNE, art('4', 'Article 4 : Le secrétaire général est chargé de l\'exécution.')]
    expect(comparerProjetSigne(projet, signe).identique).toBe(true)
  })

  it('un article daté présent d\'un seul côté est différent', () => {
    const signe = [...SIGNE, art('4', 'Article 4 : La bécasse est chassée du 20 septembre 2026 au 20 février 2027.')]
    expect(comparerProjetSigne(PROJET, signe)).toEqual({ identique: false, articlesDifferents: ['4'] })
  })

  it('un article devenu daté d\'un seul côté est différent', () => {
    const projet = [...PROJET, art('4', 'Article 4 : dates à fixer.')]
    const signe = [...SIGNE, art('4', 'Article 4 : dates fixées au 1er octobre 2026.')]
    expect(comparerProjetSigne(projet, signe).articlesDifferents).toEqual(['4'])
  })

  it('l\'en-tête n\'est jamais comparé, même avec des dates différentes', () => {
    const projet = [art(null, 'Projet du 1er mai 2026'), ...PROJET.slice(1)]
    const signe = [art(null, 'Arrêté du 9 août 2026'), ...SIGNE.slice(1)]
    expect(comparerProjetSigne(projet, signe).identique).toBe(true)
  })

  it('insensible aux accents, à la casse et aux espaces', () => {
    const projet = [art('1', 'Article 1 : Le sanglier est chassé du 1er juin 2026 au 28 février 2027.')]
    const signe = [art('1', 'ARTICLE 1 :  Le  sanglier est chasse du 1er juin 2026\nau 28 fevrier 2027.')]
    expect(comparerProjetSigne(projet, signe).identique).toBe(true)
  })

  it('sans aucun article daté des deux côtés, rien ne prouve l\'identité : lecture complète', () => {
    expect(comparerProjetSigne([art(null, 'x'), art('1', 'rien')], [art(null, 'y'), art('1', 'rien')]).identique).toBe(false)
  })

  it('liste les numéros différents triés numériquement', () => {
    const projet = [art('2', 'Article 2 : du 1er juin 2026'), art('10', 'Article 10 : du 1er juin 2026')]
    const signe = [art('2', 'Article 2 : du 2 juin 2026'), art('10', 'Article 10 : du 2 juin 2026')]
    expect(comparerProjetSigne(projet, signe).articlesDifferents).toEqual(['2', '10'])
  })
})
