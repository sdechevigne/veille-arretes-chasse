import { describe, it, expect } from 'vitest'
import { normaliser, similarite, trouverCitation } from './texte.ts'
describe('normaliser', () => {
  it('abaisse, désaccentue, aplatit les espaces et le 1er', () => {
    expect(normaliser('  Lièvre : du 1er  Octobre\n2026 ')).toBe('lievre : du 1 octobre 2026')
    expect(normaliser('l’ouverture')).toBe("l'ouverture")
  })
})
describe('similarite', () => {
  it('vaut 1 pour deux textes égaux à la casse près et 0 pour des textes disjoints', () => {
    expect(similarite('Sanglier', 'sanglier')).toBe(1)
    expect(similarite('abc', 'xyz')).toBe(0)
  })
})
describe('trouverCitation', () => {
  const page = 'Article 3 — Le lièvre est ouvert du 11 octobre 2026 au 29 novembre 2026, le dimanche seulement.'
  it('retrouve une sous-chaîne exacte, avec sa position dans la page normalisée', () => {
    const c = 'du 11 octobre 2026 au 29 novembre 2026'
    expect(trouverCitation(c, page)).toEqual({ ok: true, score: 1, debut: normaliser(page).indexOf(normaliser(c)) })
    expect(trouverCitation('Lièvre', page).debut).toBe(normaliser(page).indexOf(normaliser('Lièvre')))
  })
  it('position de la meilleure fenêtre pour une citation approchée (retrouvée ou non)', () => {
    const debut = normaliser(page).indexOf('le lievre est ouvert')
    expect(trouverCitation('Le libre est ouvert du 11 octobre 2026 au 29 novembre 2026', page).debut).toBe(debut)
    // Fenêtre non retrouvée : à un caractère près (une espace voisine peut égaler le score).
    const r = trouverCitation('le liavre est ouvart du ll octobre', page)
    expect(r.ok).toBe(false); expect(Math.abs(r.debut - debut)).toBeLessThanOrEqual(1)
  })
  it("tolère une faute d'OCR légère", () => expect(trouverCitation('Le libre est ouvert du 11 octobre 2026 au 29 novembre 2026', page).ok).toBe(true))
  it('refuse une citation inventée', () => expect(trouverCitation('du 11 octobre 2026 au 31 janvier 2027', page).ok).toBe(false))
})
describe('normaliser (variantes)', () => {
  it("ramène les apostrophes OCR à l'apostrophe droite", () => {
    expect(normaliser('l‘ouverture l`ouverture lʼouverture l´ouverture')).toBe("l'ouverture l'ouverture l'ouverture l'ouverture")
  })
  it('ne touche que le « er » collé à un nombre', () => {
    expect(normaliser('Premier 1er 21er')).toBe('premier 1 21')
  })
})
describe('trouverCitation (limites)', () => {
  const page = 'Article 3 — Le lièvre est ouvert du 11 octobre 2026 au 29 novembre 2026, le dimanche seulement.'
  it('refuse une citation vide, une page vide, ou les deux', () => {
    expect(trouverCitation('', page)).toEqual({ ok: false, score: 0, debut: -1 })
    expect(trouverCitation('   ', page)).toEqual({ ok: false, score: 0, debut: -1 })
    expect(trouverCitation('du 11 octobre 2026', '').ok).toBe(false)
    expect(trouverCitation('', '')).toEqual({ ok: false, score: 0, debut: -1 })
  })
  it('gère une citation plus longue que la page', () => {
    expect(trouverCitation('Le lièvre est ouvert du 11 octobre 2026 au 29 novembre 2026, le dimanche seulement, sauf dérogation.', page).ok).toBe(false)
    expect(trouverCitation('lievre est ouvert du 11 octobre 2026 au 29 novembre 2026, le dimanche seulement. et plus', page).score).toBeLessThan(1)
    expect(trouverCitation('abcd', 'abc').ok).toBe(false)
  })
  it('refuse sous le seuil, près de la frontière', () => {
    const r = trouverCitation('le liavre est ouvart du ll octobre', page)
    expect(r.score).toBeGreaterThan(0.7)
    expect(r.score).toBeLessThan(0.9)
    expect(r.ok).toBe(false)
  })
  it('refuse un chiffre, un jour ou une année altérés, même très proche du texte', () => {
    expect(trouverCitation('Le lièvre est ouvert du 11 octobre 2026 au 29 novembre 2027', page).ok).toBe(false)
    expect(trouverCitation('Le lièvre est ouvert du 11 octobre 2026 au 28 novembre 2026', page).ok).toBe(false)
    expect(trouverCitation('Le lièvre est ouvert du 12 octobre 2026 au 29 novembre 2026', page).ok).toBe(false)
  })
  it('accepte une faute d’OCR sur le texte avec les nombres intacts, y compris si la fenêtre se décale', () => {
    const r = trouverCitation('Le libre est ouvert du 11 octobre 2026 au 29 novembre 2026', page)
    expect(r.ok).toBe(true)
    expect(r.score).toBeGreaterThanOrEqual(0.9)
    expect(r.score).toBeLessThan(1)
  })
  it('retrouve une citation courte avec une faute grâce au pas de 1 caractère', () => {
    const r = trouverCitation('le lievre esx ouvert du', page)
    expect(r.ok).toBe(true)
    expect(r.score).toBeLessThan(1)
  })
})
