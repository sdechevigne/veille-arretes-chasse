import { describe, it, expect } from 'vitest'
import { ESPECES, MODES, SOUS_TYPES } from './vocabulaire.ts'

describe('vocabulaire core', () => {
  it('28 espèces, 6 modes, 4 sous-types', () => {
    expect(ESPECES).toHaveLength(28)
    expect(MODES).toEqual(['tous_modes', 'approche_affut', 'battue', 'tir', 'venerie_sous_terre', 'courre'])
    expect(SOUS_TYPES).toEqual(['cerf_elaphe', 'cerf_sika', 'perdrix_grise', 'perdrix_rouge'])
  })
  it('espèces triées et sans doublon', () => {
    expect([...ESPECES]).toEqual([...ESPECES].sort())
    expect(new Set(ESPECES).size).toBe(ESPECES.length)
  })
})
