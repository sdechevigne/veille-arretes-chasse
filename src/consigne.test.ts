import { describe, it, expect } from 'vitest'
import { chargerConsigne } from './consigne.ts'
import { ESPECES, MODES, SOUS_TYPES } from './vocabulaire.ts'

const { systeme, schema } = chargerConsigne() as { systeme: string; schema: any }
const periode = schema.properties.periodes.items.properties
const suppression = schema.properties.suppressions.items.properties

// Parcourt tout le schéma : chaque objet doit être fermé et exiger toutes ses propriétés (sortie structurée stricte).
function objets(n: any, acc: any[] = []): any[] {
  if (n && typeof n === 'object') {
    if (n.type === 'object') acc.push(n)
    for (const v of Object.values(n)) objets(v, acc)
  }
  return acc
}

describe('chargerConsigne', () => {
  it('le vocabulaire du schéma est celui de vocabulaire.ts (source unique)', () => {
    expect(periode.espece_code.enum).toEqual([...ESPECES])
    expect(suppression.espece_code.enum).toEqual([...ESPECES])
    expect(periode.mode_chasse.enum).toEqual([...MODES])
    expect(periode.sous_type.enum).toEqual([...SOUS_TYPES, null])
    expect(suppression.sous_type.enum).toEqual([...SOUS_TYPES, null])
  })

  it('le schéma est en draft 2020-12, fermé et à propriétés toutes requises', () => {
    expect(schema.$schema).toBe('https://json-schema.org/draft/2020-12/schema')
    const tous = objets(schema)
    expect(tous.length).toBeGreaterThanOrEqual(5)
    for (const o of tous) {
      expect(o.additionalProperties).toBe(false)
      expect([...o.required].sort()).toEqual(Object.keys(o.properties).sort())
    }
    expect(periode.preuve.properties.page).toMatchObject({ type: 'integer', minimum: 1 })
    expect(periode.date_ouverture.pattern).toBe('^\\d{4}-\\d{2}-\\d{2}$')
  })

  it('pages illisibles : liste requise d’entiers ≥ 1, décrite dans la consigne', () => {
    expect(schema.required).toContain('pages_illisibles')
    expect(schema.properties.pages_illisibles).toMatchObject({ type: 'array', items: { type: 'integer', minimum: 1 } })
    expect(systeme).toMatch(/`pages_illisibles`/)
  })

  it('preuve composée : `extraits` (0 à 3 extraits de 8 à 200 caractères) sur chaque preuve et chaque suppression, décrit dans la consigne', () => {
    const extraits = { type: 'array', maxItems: 3, items: { type: 'string', minLength: 8, maxLength: 200 } }
    expect(periode.preuve.properties.extraits).toEqual(extraits)
    expect(suppression.extraits).toEqual(extraits)
    expect(systeme).toMatch(/`extraits`/)
    expect(systeme).toMatch(/ouverture générale/)
  })

  it('la consigne cite chaque espèce, chaque mode et chaque sous-type', () => {
    for (const mot of [...ESPECES, ...MODES, ...SOUS_TYPES]) expect(systeme).toMatch(new RegExp(`\\b${mot}\\b`))
  })

  it('la consigne reste courte (< 12 000 caractères)', () => {
    expect(systeme.length).toBeGreaterThan(3000)
    expect(systeme.length).toBeLessThan(12000)
  })
})
