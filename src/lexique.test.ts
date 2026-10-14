import { describe, it, expect } from 'vitest'
import { compterDates, compterEspeces, parleDeChasse } from './lexique.ts'

describe('lexique', () => {
  it('compte les dates en lettres, numériques, et année reportée à la ligne', () => {
    expect(compterDates('du 1er juin 2026 au 10/07/2026 ; ouverture le 20 septembre\n2026 ; 31-03-2027')).toBe(4)
  })
  it('compte les espèces distinctes, pluriels et fautes OCR tolérés', () => {
    expect(compterEspeces('Sangliers, chevreuil, liévre, LIÈVRE, perdrix rouge, rat musqué')).toBe(5)
    expect(compterEspeces('aucun animal ici')).toBe(0)
  })
  it('parleDeChasse', () => {
    expect(parleDeChasse('arrêté portant ouverture de la chasse')).toBe(true)
    expect(parleDeChasse('arrêté portant réglementation de la pêche en eau douce')).toBe(false)
  })
  it('cerf-volant et pie-grièche ne sont pas du gibier ; mois suivi d’une lettre : pas une date', () => {
    expect(compterEspeces('un cerf-volant et une pie-grièche')).toBe(0)
    expect(compterEspeces('un cerf, des pies')).toBe(2)
    expect(compterDates('le 12 marsupilami 2026')).toBe(0)
  })
})
