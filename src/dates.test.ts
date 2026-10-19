import { describe, it, expect } from 'vitest'
import { dateIso, datesDe, datesPositionnees, premierePlage, compterDatesLarges } from './dates.ts'
import { normaliser } from './texte.ts'
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

describe('compterDatesLarges', () => {
  it('compte les dates avec ou sans année et les dates numériques', () => {
    expect(compterDatesLarges('du 1er septembre au 28 février')).toBe(2)
    expect(compterDatesLarges('du 1er juin 2026 au 15/08/2026')).toBe(2)
    expect(compterDatesLarges("l'ouverture le 15 août")).toBe(1)
  })
  it('vaut 0 sans date (numéro d\'article, nombre isolé)', () => {
    expect(compterDatesLarges('Article 1er : le sanglier, 3 spécimens par jour')).toBe(0)
    expect(compterDatesLarges('')).toBe(0)
  })
})

describe('datesDe — jour nu suivi de « au <date> »', () => {
  it('le jour nu hérite du mois et de l’année de la date qui suit', () => {
    expect(datesDe('du 1er au 15 septembre 2026', '2026-2027')).toEqual(['2026-09-01', '2026-09-15'])
    expect(datesDe('du 1 au 15 septembre', '2026-2027')).toEqual(['2026-09-01', '2026-09-15'])
    expect(datesDe('du 1er septembre au 15 octobre 2026', '2026-2027')).toEqual(['2026-09-01', '2026-10-15'])
    expect(datesDe('du 10 au 31 janvier 2027 inclus', '2026-2027')).toEqual(['2027-01-10', '2027-01-31'])
  })
})

describe('datesDe — « dernier jour de <mois> » (R45)', () => {
  it('février : 28 ou 29 selon l’année déduite de la saison', () => {
    expect(datesDe('du 1er septembre au dernier jour de février', '2026-2027')).toEqual(['2026-09-01', '2027-02-28'])
    expect(datesDe('du 1er septembre au dernier jour de février', '2027-2028')).toEqual(['2027-09-01', '2028-02-29'])
  })
  it('année écrite : respectée, et refusée hors saison', () => {
    expect(datesDe('au dernier jour de septembre 2026', '2026-2027')).toEqual(['2026-09-30'])
    expect(datesDe('au dernier jour de février 2025', '2026-2027')).toEqual([])
  })
  it('variantes : majuscules, « d’octobre », sans accent', () => {
    expect(datesDe('Au Dernier Jour de Février', '2026-2027')).toEqual(['2027-02-28'])
    expect(datesDe("jusqu'au dernier jour d'octobre", '2026-2027')).toEqual(['2026-10-31'])
    expect(datesDe('au dernier jour de fevrier', '2026-2027')).toEqual(['2027-02-28'])
  })
  it('dateIso lit le fragment seul', () => {
    expect(dateIso('dernier jour de février', '2027-2028')).toEqual({ iso: '2028-02-29', anneeDeduite: true })
    expect(dateIso('dernier jour de février 2027', '2026-2027')).toEqual({ iso: '2027-02-28', anneeDeduite: false })
  })
  it('position : la date couvre toute l’expression', () => {
    const t = 'Du 1er Juin au dernier jour de février.'
    expect(datesPositionnees(t, '2026-2027')).toEqual([
      { iso: '2027-06-01', debut: 3, fin: 11 },
      { iso: '2027-02-28', debut: 15, fin: 38 },
    ])
  })
  it('« avant-dernier jour » n’est PAS le dernier jour : aucune date (tiret, espace, tirets typographiques, texte normalisé)', () => {
    for (const t of ["jusqu'à l'avant-dernier jour de février", "jusqu'à l'avant dernier jour de février", 'jusqu’à l’avant‑dernier jour de février',
      'jusqu’à l’avant–dernier jour de février', 'jusqu\'a l\'avant-dernier jour de fevrier 2027', 'Avant-Dernier jour de février', 'sous-dernier jour de février']) {
      expect(datesPositionnees(t, '2026-2027')).toEqual([])
      expect(datesPositionnees(normaliser(t), '2026-2027')).toEqual([])
    }
    expect(compterDatesLarges("l'avant-dernier jour de février")).toBe(0)
    expect(datesDe("du 1er septembre à l'avant-dernier jour de février puis jusqu'au dernier jour de mars", '2026-2027')).toEqual(['2026-09-01', '2027-03-31'])
  })
  it('« du 1er au dernier jour de février » : seule la fin est lue (le jour nu est perdu : faux négatif sûr)', () => {
    expect(datesDe('du 1er au dernier jour de février', '2026-2027')).toEqual(['2027-02-28'])
  })
  it('compterDatesLarges la compte comme une date', () => {
    expect(compterDatesLarges('du 1er septembre au dernier jour de février')).toBe(2)
  })
})

describe('datesPositionnees', () => {
  it('chaque date valide avec sa position (jour nu : fin après le jour)', () => {
    const t = 'du 1 au 15 septembre 2026, puis le 2 octobre'
    expect(datesPositionnees(t, '2026-2027')).toEqual([
      { iso: '2026-09-01', debut: 3, fin: 4 },
      { iso: '2026-09-15', debut: 8, fin: 25 },
      { iso: '2026-10-02', debut: 35, fin: 44 },
    ])
    expect(datesPositionnees(t, '2026-2027').map(d => d.iso)).toEqual(datesDe(t, '2026-2027'))
  })
})

describe('premierePlage', () => {
  const S = '2026-2027'
  it('première plage « du A au B » (au, jusqu’au, jour nu)', () => {
    expect(premierePlage(' de la chasse est fixee : du 27 septembre 2026 au 28 fevrier 2027 pour toutes', S)).toEqual({ debut: '2026-09-27', fin: '2027-02-28' })
    expect(premierePlage(" du 1 juin 2026 jusqu'au 14 aout 2026", S)).toEqual({ debut: '2026-06-01', fin: '2026-08-14' })
    expect(premierePlage(' du 1 au 15 septembre 2026', S)).toEqual({ debut: '2026-09-01', fin: '2026-09-15' })
  })
  it('date seule : la suivante n’en fait pas une plage', () => {
    expect(premierePlage(' est fixee le 13 septembre 2026. le 1 juin 2026, la chasse', S)).toEqual({ debut: '2026-09-13', fin: null })
    expect(premierePlage(' au 31 janvier 2027 sur le territoire', S)).toEqual({ debut: '2027-01-31', fin: null })
  })
  it('aucune date → null', () => { expect(premierePlage(' de la chasse.', S)).toBeNull() })
})
