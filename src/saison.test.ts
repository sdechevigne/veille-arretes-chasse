import { describe, it, expect } from 'vitest'
import { saisonDepuisDate, saisonDepuisTexte, saisonCourante, saisonsDepuisTexte } from './saison.ts'

describe('saison', () => {
  it('bascule au 1er juillet', () => {
    expect(saisonDepuisDate(new Date('2026-06-30'))).toBe('2025-2026')
    expect(saisonDepuisDate(new Date('2026-07-01'))).toBe('2026-2027')
  })
  it('lit la saison citée dans un texte, avec ou sans tiret, en priorité sur la date', () => {
    expect(saisonDepuisTexte('campagne 2026-2027 dans le département')).toBe('2026-2027')
    expect(saisonDepuisTexte('campagne 2026/2027')).toBe('2026-2027')
    expect(saisonDepuisTexte('saison 2026 – 2027')).toBe('2026-2027')
    expect(saisonDepuisTexte('arrêté du 12 mai 2026 sans saison')).toBeNull()
  })
  it('saisonCourante = saison de la date du jour', () => {
    expect(saisonCourante(new Date('2026-10-14'))).toBe('2026-2027')
  })
  it('saisonsDepuisTexte : toutes les paires consécutives, sans doublon', () => {
    expect(saisonsDepuisTexte('2024-2025, 2025-2026 et 2026-2027 ; période 2020-2026 ; 2025-2026')).toEqual(['2024-2025', '2025-2026', '2026-2027'])
  })
})
