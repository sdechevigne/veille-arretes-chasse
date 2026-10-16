import { describe, it, expect } from 'vitest'
import { comparerLectures, deptDetecte, nomDepartementNormalise } from './consolidation.ts'
import type { LectureClaude, PeriodeLue } from './types.ts'

const per = (o: Partial<PeriodeLue>): PeriodeLue => ({ espece_code: 'sanglier', sous_type: null, date_ouverture: '2026-06-01', date_fermeture: '2027-02-28', mode_chasse: 'tous_modes',
  restriction_dates: null, source_article: '1', preuve: { article: '1', citation: 'citation quelconque assez longue', page: 1, annee_deduite: false }, ...o })
const lect = (periodes: PeriodeLue[]): LectureClaude => ({ acte: { numero: null, date: null, objet: 'x', signe: true, departement_lu: null, saison_lue: null }, periodes, suppressions: [], notes: '', pages_illisibles: [] })

describe('comparerLectures', () => {
  it('ordre de lecture, citation et page indifférents ; mode nul = tous modes ; cerf sans sous-type = élaphe', () => {
    const a = lect([per({}), per({ espece_code: 'cerf', mode_chasse: 'battue' }), per({ espece_code: 'lievre', mode_chasse: '' })])
    const b = lect([per({ espece_code: 'lievre', mode_chasse: 'tous_modes', preuve: { article: '2', citation: 'autre citation tout aussi longue', page: 3, annee_deduite: true } }),
      per({ espece_code: 'cerf', sous_type: 'cerf_elaphe', mode_chasse: 'battue' }), per({})])
    expect(comparerLectures(a, b)).toEqual({ ecarts: [], secondaires: [] })
  })
  it('restriction ou article différents : note secondaire, pas un écart', () => {
    const r = comparerLectures(lect([per({ restriction_dates: 'samedi et dimanche' })]), lect([per({ source_article: '3' })]))
    expect(r.ecarts).toEqual([])
    expect(r.secondaires).toEqual(['sanglier tous_modes 2026-06-01→2027-02-28 : restriction samedi et dimanche, article 1 (lecture 1) / restriction -, article 3 (lecture 2)'])
  })
  it('date, mode ou espèce différents : écart nommé ; même ensemble en nombre différent : écart de nombre', () => {
    expect(comparerLectures(lect([per({})]), lect([per({ date_fermeture: '2027-01-31' })])).ecarts)
      .toEqual(['sanglier tous_modes 2026-06-01→2027-02-28 (lecture 1 seule)', 'sanglier tous_modes 2026-06-01→2027-01-31 (lecture 2 seule)'])
    expect(comparerLectures(lect([per({}), per({})]), lect([per({})])).ecarts).toEqual(['nombre de périodes différent (2 / 1)'])
  })
})

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
