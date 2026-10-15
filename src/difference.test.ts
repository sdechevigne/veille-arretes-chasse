import { describe, it, expect } from 'vitest'
import { appliquerDifference } from './difference.ts'
import type { PeriodePubliee } from './difference.ts'
import type { LectureClaude, PeriodeLue } from './types.ts'

const publiee = (o: Partial<PeriodePubliee>): PeriodePubliee => ({
  espece_code: 'sanglier', sous_type: null, date_ouverture: '2026-06-01', date_fermeture: '2027-01-31',
  mode_chasse: 'tous_modes', restriction_dates: null, source_article: 'Article 1', ...o,
})
const lue = (o: Partial<PeriodeLue>): PeriodeLue => ({
  espece_code: 'sanglier', sous_type: null, date_ouverture: '2026-06-01', date_fermeture: '2027-02-28',
  mode_chasse: 'tous_modes', restriction_dates: null, source_article: 'Article 1',
  preuve: { article: '1', citation: 'x', page: 1, annee_deduite: false }, ...o,
})
const lecture = (periodes: PeriodeLue[], suppressions: LectureClaude['suppressions'] = []): LectureClaude => ({
  acte: { numero: null, date: null, objet: '', signe: true, departement_lu: null, saison_lue: null },
  periodes, suppressions, notes: '',
})

describe('appliquerDifference', () => {
  it('une période lue remplace la publiée de même (espèce, sous-type, mode) et le journal le dit', () => {
    const r = appliquerDifference([publiee({ id: 'a' })], lecture([lue({})]))
    expect(r.periodes).toHaveLength(1)
    expect(r.periodes[0].date_fermeture).toBe('2027-02-28')
    expect(r.suppressionExplicite).toBe(false)
    expect(r.journal).toEqual(['sanglier tous_modes : 2026-06-01→2027-02-28 remplace 2026-06-01→2027-01-31'])
  })

  it('conserve telle quelle une espèce non citée, avec sa zone', () => {
    const zone = publiee({ espece_code: 'chevreuil', zone_libelle: 'Zone nord', zone_geojson: { type: 'Polygon' } })
    const r = appliquerDifference([zone, publiee({})], lecture([lue({})]))
    const chevreuil = r.periodes.find(p => p.espece_code === 'chevreuil')
    expect(chevreuil).toEqual(zone)
    expect(r.journal.some(l => l.includes('chevreuil'))).toBe(false)
  })

  it('un autre mode de la même espèce est conservé, un mode nouveau est un ajout', () => {
    const battue = publiee({ mode_chasse: 'battue' })
    const r = appliquerDifference([battue], lecture([lue({ mode_chasse: 'tir' })]))
    expect(r.periodes).toHaveLength(2)
    expect(r.periodes).toContainEqual(battue)
    expect(r.journal).toEqual(['ajout sanglier tir : 2026-06-01→2027-02-28'])
  })

  it('une période lue remplace toutes les sous-périodes publiées de sa clé', () => {
    const pub = [publiee({ date_ouverture: '2026-06-01', date_fermeture: '2026-08-31' }), publiee({ date_ouverture: '2026-10-01', date_fermeture: '2027-01-31' })]
    const r = appliquerDifference(pub, lecture([lue({})]))
    expect(r.periodes).toHaveLength(1)
    expect(r.journal).toEqual(['sanglier tous_modes : 2026-06-01→2027-02-28 remplace 2026-06-01→2026-08-31 + 2026-10-01→2027-01-31'])
  })

  it('plusieurs périodes lues de même clé sont toutes gardées (sous-périodes)', () => {
    const r = appliquerDifference([publiee({})], lecture([
      lue({ date_ouverture: '2026-06-01', date_fermeture: '2026-08-31' }),
      lue({ date_ouverture: '2026-10-01', date_fermeture: '2027-02-28' }),
    ]))
    expect(r.periodes.map(p => p.date_ouverture)).toEqual(['2026-06-01', '2026-10-01'])
    expect(r.journal).toHaveLength(1)
  })

  it('une suppression retire les publiées de même (espèce, sous-type) et lève suppressionExplicite', () => {
    const r = appliquerDifference(
      [publiee({ espece_code: 'daim' }), publiee({ espece_code: 'daim', mode_chasse: 'battue' }), publiee({})],
      lecture([], [{ espece_code: 'daim', sous_type: null, citation: 'x', page: 2 }]),
    )
    expect(r.periodes.map(p => p.espece_code)).toEqual(['sanglier'])
    expect(r.suppressionExplicite).toBe(true)
    expect(r.journal).toEqual(['suppression daim : 2026-06-01→2027-01-31 + 2026-06-01→2027-01-31'])
  })

  it('une suppression de sous-type ne touche pas l\'autre sous-type', () => {
    const r = appliquerDifference(
      [publiee({ espece_code: 'cerf', sous_type: 'cerf_elaphe' }), publiee({ espece_code: 'cerf', sous_type: 'cerf_sika' })],
      lecture([], [{ espece_code: 'cerf', sous_type: 'cerf_sika', citation: 'x', page: 1 }]),
    )
    expect(r.periodes.map(p => p.sous_type)).toEqual(['cerf_elaphe'])
  })

  it('suppression sans rien de publié : drapeau levé et journal explicite', () => {
    const r = appliquerDifference([], lecture([], [{ espece_code: 'daim', sous_type: null, citation: 'x', page: 1 }]))
    expect(r.suppressionExplicite).toBe(true)
    expect(r.journal).toEqual(['suppression daim : aucune période publiée'])
  })

  it('convention cerf sans précision = cerf_elaphe : la publiée cerf/null est remplacée par la lue cerf_elaphe', () => {
    const r = appliquerDifference(
      [publiee({ espece_code: 'cerf', sous_type: null })],
      lecture([lue({ espece_code: 'cerf', sous_type: 'cerf_elaphe', date_fermeture: '2027-02-28' })]),
    )
    expect(r.periodes).toHaveLength(1)
    expect(r.periodes[0].sous_type).toBe('cerf_elaphe')
    expect(r.journal[0]).toContain('remplace')
  })

  it('aucune publiée : tout est ajout ; la preuve de la période lue est conservée', () => {
    const r = appliquerDifference([], lecture([lue({})]))
    expect(r.journal).toEqual(['ajout sanglier tous_modes : 2026-06-01→2027-02-28'])
    expect(r.periodes[0].preuve?.citation).toBe('x')
  })

  it('une période lue identique à la publiée → « inchangé »', () => {
    const r = appliquerDifference([publiee({ date_fermeture: '2027-02-28' })], lecture([lue({})]))
    expect(r.journal).toEqual(['sanglier tous_modes : 2026-06-01→2027-02-28 inchangé'])
    expect(r.periodes).toHaveLength(1)
  })

  it('les périodes renvoyées sont des copies, pas des alias des entrées', () => {
    const pub = publiee({ espece_code: 'daim' }), l = lue({})
    const r = appliquerDifference([pub], lecture([l]))
    expect(r.periodes.some(x => x === pub || x === (l as unknown))).toBe(false)
    r.periodes.find(x => x.espece_code === 'daim').date_ouverture = '1999-01-01'
    expect(pub.date_ouverture).toBe('2026-06-01')
  })

  it('ne modifie pas les entrées', () => {
    const pub = [publiee({})]
    const copie = JSON.parse(JSON.stringify(pub))
    appliquerDifference(pub, lecture([lue({})]))
    expect(pub).toEqual(copie)
  })
})
