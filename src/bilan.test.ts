import { describe, it, expect } from 'vitest'
import { syntheseBilan, texteBilan } from './bilan.ts'

const MAINTENANT = new Date('2026-10-19T05:30:00Z')

describe('syntheseBilan', () => {
  const s = syntheseBilan({
    maintenant: MAINTENANT,
    sourcesEnPanne: 3,
    documents: [
      { statut_traitement: 'propose', type_detecte: 'annuel' },
      { statut_traitement: 'ignore', type_detecte: null },
      { statut_traitement: 'propose', type_detecte: 'annuel' },
    ],
    propositions: [
      { decision: 'publie', lecture: { usage: { input: 1000, output: 200, cache_creation: 50, cache_read: 10 } } },
      { decision: 'en_attente', lecture: { usage: { input: 500, output: 100, cache_creation: 0, cache_read: 0 } } },
      { decision: 'publie', lecture: null },
      { decision: 'publie_note', lecture: { usage: { input: 7 } } },
    ],
  })

  it('compte documents, propositions par décision et tokens (lecture.usage) sur 7 jours', () => {
    expect(s).toEqual({
      genereLe: '2026-10-19T05:30:00.000Z', periodeJours: 7, sourcesEnPanne: 3,
      documents7j: { total: 3, parStatut: { propose: 2, ignore: 1 }, parType: { annuel: 2, non_detecte: 1 } },
      propositions7j: { total: 4, parDecision: { publie: 2, en_attente: 1, publie_note: 1 } },
      tokens7j: { input: 1507, output: 300, cache_creation: 50, cache_read: 10 },
      deferes: ['couverture des départements sans arrêté annuel en campagne (1er juin / 15 juillet)'],
    })
  })

  it('ne contient que des comptes (fichier commité dans un dépôt public)', () => {
    const texte = JSON.stringify(s)
    expect(texte).not.toMatch(/https?:/)
  })

  it('texte de notification lisible', () => {
    expect(texteBilan(s)).toBe('Bilan hebdomadaire veille arrêtés : 3 document(s) découvert(s), 4 proposition(s) (publie 2, en_attente 1, publie_note 1), 1507 tokens lus / 300 écrits, 3 source(s) en panne')
  })
})
