import { describe, it, expect } from 'vitest'
import { dateIso, datesDe } from './dates.ts'
describe('dateIso', () => {
  it('lit les formes françaises courantes', () => {
    expect(dateIso('1er juin 2026', '2026-2027')).toEqual({ iso: '2026-06-01', anneeDeduite: false })
    expect(dateIso('01/06/2026', '2026-2027')).toEqual({ iso: '2026-06-01', anneeDeduite: false })
    expect(dateIso('1" juin 2026', '2026-2027')).toEqual({ iso: '2026-06-01', anneeDeduite: false })
    expect(dateIso('28 février 2027', '2026-2027')).toEqual({ iso: '2027-02-28', anneeDeduite: false })
  })
  it("déduit l'année manquante de la saison", () => {
    expect(dateIso('15 août', '2026-2027')).toEqual({ iso: '2026-08-15', anneeDeduite: true })
    expect(dateIso('28 février', '2026-2027')).toEqual({ iso: '2027-02-28', anneeDeduite: true })
  })
  it('refuse une date impossible ou hors saison', () => {
    expect(dateIso('31 février 2027', '2026-2027')).toBeNull()
    expect(dateIso('15 août 2024', '2026-2027')).toBeNull()
  })
})
describe('dateIso (limites)', () => {
  it('lit les 12 mois, avec les variantes OCR sans accent', () => {
    const mois = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre']
    mois.forEach((m, i) => {
      const mm = String(i + 1).padStart(2, '0')
      const an = i + 1 >= 7 ? 2026 : 2027
      expect(dateIso(`5 ${m} ${an}`, '2026-2027')).toEqual({ iso: `${an}-${mm}-05`, anneeDeduite: false })
      expect(dateIso(`5 ${m}`, '2026-2027')).toEqual({ iso: `${an}-${mm}-05`, anneeDeduite: true })
    })
    expect(dateIso('3 fevrier 2027', '2026-2027')?.iso).toBe('2027-02-03')
    expect(dateIso('3 aout 2026', '2026-2027')?.iso).toBe('2026-08-03')
    expect(dateIso('3 decembre 2026', '2026-2027')?.iso).toBe('2026-12-03')
    expect(dateIso('3 AOÛT 2026', '2026-2027')?.iso).toBe('2026-08-03')
  })
  it('lit le format numérique avec tirets, et refuse un mois ou un jour invalide', () => {
    expect(dateIso('15-08-2026', '2026-2027')).toEqual({ iso: '2026-08-15', anneeDeduite: false })
    expect(dateIso('01/13/2026', '2026-2027')).toBeNull()
    expect(dateIso('00/08/2026', '2026-2027')).toBeNull()
    expect(dateIso('32/08/2026', '2026-2027')).toBeNull()
    expect(dateIso('29/02/2027', '2026-2027')).toBeNull()
  })
  it('refuse un fragment illisible ou une saison mal formée', () => {
    expect(dateIso('bientôt', '2026-2027')).toBeNull()
    expect(dateIso('1er juin 2026', '2026')).toBeNull()
    expect(dateIso('1er juin 2026', '2026-2028')).toBeNull()
    expect(dateIso('1er juin 2026', '')).toBeNull()
    expect(dateIso('1er juin 2026', 'abcd-efgh')).toBeNull()
  })
})
describe('datesDe', () => {
  it("déduit l'année d'une date sans année", () => {
    expect(datesDe('ouverture le 15 août, fermeture le 28 février', '2026-2027')).toEqual(['2026-08-15', '2027-02-28'])
  })
  it('ignore les dates hors saison, impossibles ou absentes', () => {
    expect(datesDe('du 15 août 2024 au 31 février 2027 puis le 2 septembre 2026', '2026-2027')).toEqual(['2026-09-02'])
    expect(datesDe('aucune date ici', '2026-2027')).toEqual([])
    expect(datesDe('', '2026-2027')).toEqual([])
  })
  it('renvoie [] si la saison est mal formée', () => {
    expect(datesDe('le 1er juin 2026', 'xx')).toEqual([])
  })
  it('extrait toutes les dates ISO dans l’ordre', () => {
    expect(datesDe('du 1er juin 2026 au 14 août 2026 puis du 15/08/2026', '2026-2027')).toEqual(['2026-06-01', '2026-08-14', '2026-08-15'])
  })
})
