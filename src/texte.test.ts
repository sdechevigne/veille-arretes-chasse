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
  it('retrouve une sous-chaîne exacte', () => expect(trouverCitation('du 11 octobre 2026 au 29 novembre 2026', page)).toEqual({ ok: true, score: 1 }))
  it("tolère une faute d'OCR légère", () => expect(trouverCitation('Le libre est ouvert du 11 octobre 2026 au 29 novembre 2026', page).ok).toBe(true))
  it('refuse une citation inventée', () => expect(trouverCitation('du 11 octobre 2026 au 31 janvier 2027', page).ok).toBe(false))
})
