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
describe('datesDe', () => {
  it('extrait toutes les dates ISO dans l’ordre', () => {
    expect(datesDe('du 1er juin 2026 au 14 août 2026 puis du 15/08/2026', '2026-2027')).toEqual(['2026-06-01', '2026-08-14', '2026-08-15'])
  })
})
