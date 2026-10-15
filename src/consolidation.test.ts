import { describe, it, expect } from 'vitest'
import { deptDetecte, nomDepartementNormalise } from './consolidation.ts'

describe('nomDepartementNormalise', () => {
  it('minuscules, sans accents, apostrophes et traits d’union en espaces, articles et « département / préfecture » de tête retirés', () => {
    expect(nomDepartementNormalise('Côtes-d’Armor')).toBe('cotes d armor')
    expect(nomDepartementNormalise("Préfecture des Côtes-d'Armor")).toBe('cotes d armor')
    expect(nomDepartementNormalise('  Département   de la  Manche ')).toBe('manche')
    expect(nomDepartementNormalise("l'Ain")).toBe('ain')
  })
})

describe('deptDetecte', () => {
  it('forme longue du nom officiel : nom officiel envoyé, sans note', () => {
    for (const lu of ['la Manche', 'Département de la Manche', 'MANCHE', 'Préfecture de la Manche']) expect(deptDetecte(lu, 'Manche')).toEqual({ valeur: 'Manche', note: null })
    expect(deptDetecte("Préfecture des Côtes-d'Armor", "Côtes-d'Armor")).toEqual({ valeur: "Côtes-d'Armor", note: null })
  })
  it('absent : nom officiel', () => {
    expect(deptDetecte(null, 'Manche')).toEqual({ valeur: 'Manche', note: null })
  })
  it('autre département : valeur lue gardée (C2 bloquera) et note du robot', () => {
    expect(deptDetecte('Calvados', 'Manche')).toEqual({ valeur: 'Calvados', note: 'département lu « Calvados » ≠ département attendu « Manche »' })
  })
})
