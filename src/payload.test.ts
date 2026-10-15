import { describe, it, expect } from 'vitest'
import { construirePayload, validerVocabulaire } from './payload.ts'
import type { PayloadCore } from './payload.ts'
import type { PeriodePubliee } from './difference.ts'
import type { ActeLu, PeriodeLue } from './types.ts'

const acte: ActeLu = { numero: '2026-123', date: '2026-08-12', objet: 'Ouverture et clôture', signe: true, departement_lu: 'Oise', saison_lue: '2026-2027' }
const preuveCore = { code_detecte: '60', dept_detecte: 'Oise', millesime_detecte: '2026-2027', signature_detectee: '2026-08-12', extrait_source: 'Le sanglier est chassé' }
const lue = (o: Partial<PeriodeLue>): PeriodeLue => ({
  espece_code: 'sanglier', sous_type: null, date_ouverture: '2026-06-01', date_fermeture: '2027-02-28',
  mode_chasse: 'tous_modes', restriction_dates: null, source_article: 'Article 1',
  preuve: { article: '1', citation: 'x', page: 1, annee_deduite: false }, ...o,
})
const entree = (periodes: (PeriodeLue | PeriodePubliee)[], o: object = {}) => ({
  departement: '60', saison: '2026-2027', statut: 'signe' as const, acte, url: 'https://exemple.test/arrete.pdf', periodes, notes: '', preuveCore, ...o,
})

describe('construirePayload', () => {
  it('produit le format consommé par _apply_arrete_core, strict toujours vrai', () => {
    const p = construirePayload(entree([lue({})], { notes: 'RAS' }))
    expect(p).toMatchObject({
      departement: '60', saison: '2026-2027', strict: true, notes: 'RAS', preuve: preuveCore,
      arrete: { statut: 'signe', date_signature: '2026-08-12', numero_arrete: '2026-123', url_source: 'https://exemple.test/arrete.pdf', url_consultation: null },
    })
    expect(p.periodes).toHaveLength(1)
    expect(p.periodes[0]).toMatchObject({ espece_code: 'sanglier', sous_type: null, mode_chasse: 'tous_modes', source_article: 'Article 1' })
  })

  it('notes vides → null ; numéro absent → null', () => {
    const p = construirePayload(entree([lue({})], { acte: { ...acte, numero: null } }))
    expect(p.notes).toBeNull()
    expect(p.arrete.numero_arrete).toBeNull()
  })

  it('un projet n\'a pas de date de signature', () => {
    const p = construirePayload(entree([lue({})], { statut: 'en_attente_signature', acte: { ...acte, signe: false } }))
    expect(p.arrete.statut).toBe('en_attente_signature')
    expect(p.arrete.date_signature).toBeNull()
    expect(p.strict).toBe(true)
  })

  it('mode manquant → tous_modes', () => {
    const p = construirePayload(entree([lue({ mode_chasse: undefined }), lue({ mode_chasse: '', espece_code: 'renard' })]))
    expect(p.periodes.map(x => x.mode_chasse)).toEqual(['tous_modes', 'tous_modes'])
  })

  it('cerf sans précision → cerf_elaphe ; autres sous-types inchangés', () => {
    const p = construirePayload(entree([
      lue({ espece_code: 'cerf', sous_type: null }),
      lue({ espece_code: 'cerf', sous_type: 'cerf_sika', mode_chasse: 'battue' }),
      lue({ espece_code: 'sanglier', sous_type: null, mode_chasse: 'battue' }),
    ]))
    expect(p.periodes.filter(x => x.espece_code === 'cerf').map(x => x.sous_type).sort()).toEqual(['cerf_elaphe', 'cerf_sika'])
    expect(p.periodes.find(x => x.espece_code === 'sanglier' && x.mode_chasse === 'battue').sous_type).toBeNull()
  })

  it('tri stable (espèce, sous-type, date d\'ouverture, mode)', () => {
    const p = construirePayload(entree([
      lue({ espece_code: 'sanglier', date_ouverture: '2026-09-01', mode_chasse: 'tir', source_article: 'a' }),
      lue({ espece_code: 'chevreuil', date_ouverture: '2026-10-01', source_article: 'b' }),
      lue({ espece_code: 'sanglier', date_ouverture: '2026-06-01', mode_chasse: 'tir', source_article: 'c' }),
      lue({ espece_code: 'sanglier', date_ouverture: '2026-06-01', mode_chasse: 'battue', source_article: 'd' }),
      lue({ espece_code: 'sanglier', date_ouverture: '2026-06-01', mode_chasse: 'battue', date_fermeture: '2027-01-01', source_article: 'e' }),
    ]))
    expect(p.periodes.map(x => x.source_article)).toEqual(['b', 'd', 'e', 'c', 'a'])
  })

  it('zone_libelle / zone_geojson des lignes publiées sont conservées, absentes sinon ; id retiré ; preuve gardée', () => {
    const pub: PeriodePubliee = {
      id: 'uuid', espece_code: 'chevreuil', sous_type: null, date_ouverture: '2026-09-15', date_fermeture: '2027-01-31',
      mode_chasse: 'tous_modes', restriction_dates: null, source_article: 'Article 2', zone_libelle: 'Zone nord', zone_geojson: { type: 'Polygon' },
    }
    const p = construirePayload(entree([pub, lue({})]))
    const c = p.periodes.find(x => x.espece_code === 'chevreuil')
    expect(c.zone_libelle).toBe('Zone nord')
    expect(c.zone_geojson).toEqual({ type: 'Polygon' })
    expect('id' in c).toBe(false)
    const s = p.periodes.find(x => x.espece_code === 'sanglier')
    expect('zone_libelle' in s).toBe(false)
    expect(s.preuve.citation).toBe('x')
  })
})

describe('validerVocabulaire', () => {
  const sain = (): PayloadCore => construirePayload(entree([lue({})]))
  it('payload sain → []', () => expect(validerVocabulaire(sain())).toEqual([]))

  it('espèce hors vocabulaire', () => {
    const p = construirePayload(entree([lue({ espece_code: 'tetras' })]))
    expect(validerVocabulaire(p)).toEqual(['espece hors vocabulaire: "tetras"'])
  })

  it('mode hors vocabulaire ; mode null accepté', () => {
    const p = sain(); p.periodes[0].mode_chasse = 'poursuite'
    expect(validerVocabulaire(p)).toEqual(['mode hors vocabulaire: "poursuite"'])
    p.periodes[0].mode_chasse = null
    expect(validerVocabulaire(p)).toEqual([])
  })

  it('sous-type hors vocabulaire ; les 4 sous-types connus passent', () => {
    const p = sain(); p.periodes[0].sous_type = 'cerf_sambar'
    expect(validerVocabulaire(p)).toEqual(['sous_type hors vocabulaire: "cerf_sambar"'])
    for (const s of ['cerf_elaphe', 'cerf_sika', 'perdrix_grise', 'perdrix_rouge']) { p.periodes[0].sous_type = s; expect(validerVocabulaire(p)).toEqual([]) }
  })

  it('date mal formée ou calendrier impossible', () => {
    const p = sain(); p.periodes[0].date_ouverture = '2026-6-1'; p.periodes[0].date_fermeture = '2027-02-30'
    expect(validerVocabulaire(p)).toEqual(['date_ouverture invalide: "2026-6-1"', 'date_fermeture invalide: "2027-02-30"'])
  })

  it('dates hors saison', () => {
    const p = sain(); p.periodes[0].date_ouverture = '2025-06-01'; p.periodes[0].date_fermeture = '2028-01-31'
    expect(validerVocabulaire(p)).toEqual(['date_ouverture hors saison: 2025-06-01', 'date_fermeture hors saison: 2028-01-31'])
  })

  it('dates inversées (même règle que la base : fermeture hors an2)', () => {
    const p = sain(); p.periodes[0].date_ouverture = '2027-01-10'; p.periodes[0].date_fermeture = '2026-12-01'
    expect(validerVocabulaire(p)).toEqual(['dates inversees: sanglier 2027-01-10>2026-12-01'])
    p.periodes[0].date_fermeture = '2027-01-05'
    expect(validerVocabulaire(p)).toEqual([])
  })

  it('saison invalide ou non consécutive', () => {
    const p = sain(); p.saison = '26-27'; p.preuve.millesime_detecte = '26-27'
    expect(validerVocabulaire(p)).toEqual(['saison invalide: "26-27"'])
    p.saison = '2026-2028'; p.preuve.millesime_detecte = '2026-2028'
    expect(validerVocabulaire(p)).toEqual(['saison non consecutive: "2026-2028"'])
  })

  it('statut hors vocabulaire', () => {
    const p = sain(); p.arrete.statut = 'publie' as any
    expect(validerVocabulaire(p)).toEqual(['statut hors vocabulaire: "publie"'])
  })

  it('signé sans date de signature, url vide, aucune période', () => {
    const p = sain(); p.arrete.date_signature = null; p.arrete.url_source = ' '; p.periodes = []
    expect(validerVocabulaire(p)).toEqual(['statut "signe" mais date_signature absente', 'url_source absente', 'aucune periode datee'])
  })

  it('bloc preuve (strict + signé) : champs incohérents ou vides', () => {
    const p = sain(); p.preuve = { code_detecte: '80', dept_detecte: '', millesime_detecte: '2025-2026', signature_detectee: ' ', extrait_source: '' }
    expect(validerVocabulaire(p)).toEqual([
      'preuve.code_detecte "80" != departement "60"',
      'preuve.dept_detecte vide',
      'preuve.millesime_detecte "2025-2026" != saison "2026-2027"',
      'preuve.signature_detectee vide',
      'preuve.extrait_source vide',
    ])
    p.preuve = undefined
    expect(validerVocabulaire(p)).toEqual(['bloc preuve absent (strict + signe)'])
  })

  it('un projet (en attente de signature) n\'exige pas le bloc preuve', () => {
    const p = construirePayload(entree([lue({})], { statut: 'en_attente_signature', preuveCore: { ...preuveCore, signature_detectee: '' } }))
    p.preuve = undefined
    expect(validerVocabulaire(p)).toEqual([])
  })
})
