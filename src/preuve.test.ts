import { describe, it, expect } from 'vitest'
import { verifierPreuves } from './preuve.ts'
import type { LectureClaude, PageTexte, PeriodeLue } from './types.ts'

const page = (n: number, texte: string): PageTexte => ({ n, source: 'native', texte, nbDates: 0, nbEspeces: 0 })
const PAGES = [
  page(1, 'Article 1 : Le sanglier peut être chassé du 1er juin 2026 au 28 février 2027 à l\'approche ou à l\'affût.'),
  page(2, 'Article 2 : du 15 septembre 2026 au 31 janvier 2027 en battue.\nEspèces concernées : chevreuil, daim.'),
  page(3, 'Article 3 : le cerf sika est chassé du 1er septembre au 28 février. Le lièvre est suspendu.'),
]
const periode = (o: Partial<PeriodeLue> & { citation: string; page: number }): PeriodeLue => {
  const { citation, page: p, ...reste } = o
  return {
    espece_code: 'sanglier', sous_type: null, date_ouverture: '2026-06-01', date_fermeture: '2027-02-28', mode_chasse: 'tous_modes',
    restriction_dates: null, source_article: '1', preuve: { article: '1', citation, page: p, annee_deduite: false }, ...reste,
  }
}
const lecture = (periodes: PeriodeLue[], suppressions: LectureClaude['suppressions'] = []): LectureClaude => ({
  acte: { numero: null, date: null, objet: '', signe: true, departement_lu: null, saison_lue: null }, periodes, suppressions, notes: '', pages_illisibles: [],
})
const SAISON = '2026-2027'

describe('verifierPreuves — périodes', () => {
  it('accepte une citation exacte avec espèce et deux dates', () => {
    const r = verifierPreuves(lecture([periode({ citation: 'Le sanglier peut être chassé du 1er juin 2026 au 28 février 2027', page: 1 })]), PAGES, SAISON)
    expect(r).toEqual({ ok: true, details: [], aRelire: [], pagesEnEchec: [], echecs: [] })
  })
  it("refuse une citation sans l'espèce : détail + page à relire", () => {
    const r = verifierPreuves(lecture([periode({ citation: 'du 15 septembre 2026 au 31 janvier 2027 en battue', page: 2, espece_code: 'chevreuil', date_ouverture: '2026-09-15', date_fermeture: '2027-01-31' })]), PAGES, SAISON)
    expect(r.ok).toBe(false)
    expect(r.details).toEqual(['période 1 (chevreuil) : espèce absente de la citation'])
    expect(r.aRelire).toEqual([2])
  })
  it('refuse une citation inventée avec sa similarité', () => {
    const r = verifierPreuves(lecture([periode({ citation: 'Le sanglier est interdit toute la saison hivernale sur tout le territoire départemental', page: 1 })]), PAGES, SAISON)
    expect(r.ok).toBe(false)
    expect(r.details).toHaveLength(1)
    expect(r.details[0]).toMatch(/^période 1 \(sanglier\) : citation introuvable \(similarité 0,\d\d\)$/)
    expect(r.aRelire).toEqual([])
  })
  it("refuse une page inexistante", () => {
    const r = verifierPreuves(lecture([periode({ citation: 'sanglier', page: 9 })]), PAGES, SAISON)
    expect(r.details).toEqual(['période 1 (sanglier) : page 9 introuvable'])
  })
  it("refuse une date de la lecture absente de la citation", () => {
    const r = verifierPreuves(lecture([periode({ citation: 'Le sanglier peut être chassé du 1er juin 2026 au 28 février 2027', page: 1, date_fermeture: '2027-03-31' })]), PAGES, SAISON)
    expect(r.ok).toBe(false)
    expect(r.details).toEqual(["période 1 (sanglier) : date de fermeture 2027-03-31 absente de la citation"])
    expect(r.aRelire).toEqual([])
  })
  it("signale une date d'ouverture absente avec l'apostrophe correcte", () => {
    const r = verifierPreuves(lecture([periode({ citation: 'Le sanglier peut être chassé du 1er juin 2026 au 28 février 2027', page: 1, date_ouverture: '2026-07-01' })]), PAGES, SAISON)
    expect(r.details).toEqual(["période 1 (sanglier) : date d'ouverture 2026-07-01 absente de la citation"])
  })
  it('distingue un nombre altéré (similarité ≥ 0,9) d\'une citation introuvable', () => {
    const r = verifierPreuves(lecture([periode({ citation: 'Le sanglier peut être chassé du 1er juin 2026 au 29 février 2027', page: 1 })]), PAGES, SAISON)
    expect(r.details).toHaveLength(1)
    expect(r.details[0]).toMatch(/^période 1 \(sanglier\) : citation introuvable ou nombre altéré \(similarité 0,9\d\)$/)
  })
  it('accepte le pluriel « sikas » pour cerf_sika', () => {
    const c = 'les cerfs sikas sont chassés du 1er septembre au 28 février'
    const p = [page(1, c)]
    const r = verifierPreuves(lecture([periode({ citation: c, page: 1, espece_code: 'cerf', sous_type: 'cerf_sika', date_ouverture: '2026-09-01', date_fermeture: '2027-02-28',
      preuve: { article: '1', citation: c, page: 1, annee_deduite: true } })]), p, SAISON)
    expect(r.details).toEqual([])
  })
  it('accepte une année déduite en comparant jour et mois', () => {
    const r = verifierPreuves(lecture([periode({ citation: 'le cerf sika est chassé du 1er septembre au 28 février', page: 3, espece_code: 'cerf', sous_type: 'cerf_sika', date_ouverture: '2026-09-01', date_fermeture: '2027-02-28',
      preuve: { article: '3', citation: 'le cerf sika est chassé du 1er septembre au 28 février', page: 3, annee_deduite: true } })]), PAGES, SAISON)
    expect(r).toEqual({ ok: true, details: [], aRelire: [], pagesEnEchec: [], echecs: [] })
  })
  it('exige « sika » pour le sous-type cerf_sika', () => {
    const c = 'est chassé du 1er septembre au 28 février. Le lièvre est suspendu.'
    const r = verifierPreuves(lecture([periode({ citation: c, page: 3, espece_code: 'cerf', sous_type: 'cerf_sika', date_ouverture: '2026-09-01', date_fermeture: '2027-02-28',
      preuve: { article: '3', citation: c, page: 3, annee_deduite: true } })]), PAGES, SAISON)
    expect(r.details).toEqual(['période 1 (cerf) : espèce absente de la citation'])
  })
  it("signale une espèce sans motif de recherche sans planter", () => {
    const r = verifierPreuves(lecture([periode({ citation: 'Le sanglier peut être chassé du 1er juin 2026 au 28 février 2027', page: 1, espece_code: 'dragon' })]), PAGES, SAISON)
    expect(r.details).toEqual(['période 1 (dragon) : espèce sans motif de recherche'])
  })
  it('numérote les périodes à partir de 1 et cumule les détails', () => {
    const ok = periode({ citation: 'Le sanglier peut être chassé du 1er juin 2026 au 28 février 2027', page: 1 })
    const ko = periode({ citation: 'inventé de toutes pièces, rien de tel dans le texte de la page', page: 1 })
    const r = verifierPreuves(lecture([ok, ko]), PAGES, SAISON)
    expect(r.details).toHaveLength(1)
    expect(r.details[0]).toMatch(/^période 2 /)
  })
})

describe('verifierPreuves — pages en échec', () => {
  it('rend la page déclarée de chaque élément en échec (page inexistante comprise), triée et sans doublon', () => {
    const r = verifierPreuves(lecture([
      periode({ citation: 'Le sanglier peut être chassé du 1er juin 2026 au 28 février 2027', page: 1, date_fermeture: '2027-03-31' }),
      periode({ citation: 'du 15 septembre 2026 au 31 janvier 2027 en battue', page: 2, espece_code: 'chevreuil', date_ouverture: '2026-09-15', date_fermeture: '2027-01-31' }),
      periode({ citation: 'sanglier', page: 9 }),
      periode({ citation: 'Le sanglier peut être chassé du 1er juin 2026 au 28 février 2027', page: 1 }),
    ], [{ espece_code: 'sanglier', sous_type: null, citation: 'Le lièvre est suspendu', page: 3 }]), PAGES, SAISON)
    expect(r.pagesEnEchec).toEqual([1, 2, 3, 9])
    expect(r.aRelire).toEqual([2, 3])
    expect(r.echecs).toEqual([
      { page: 1, detail: 'période 1 (sanglier) : date de fermeture 2027-03-31 absente de la citation' },
      { page: 2, detail: 'période 2 (chevreuil) : espèce absente de la citation' },
      { page: 9, detail: 'période 3 (sanglier) : page 9 introuvable' },
      { page: 3, detail: 'suppression 1 (sanglier) : espèce absente de la citation' },
    ])
    expect(r.details).toEqual(r.echecs.map(e => e.detail))
  })
})

describe('verifierPreuves — suppressions', () => {
  it('accepte une suppression dont la citation porte l\'espèce', () => {
    const r = verifierPreuves(lecture([], [{ espece_code: 'lievre', sous_type: null, citation: 'Le lièvre est suspendu', page: 3 }]), PAGES, SAISON)
    expect(r).toEqual({ ok: true, details: [], aRelire: [], pagesEnEchec: [], echecs: [] })
  })
  it("refuse une suppression sans l'espèce et demande la relecture de la page", () => {
    const r = verifierPreuves(lecture([], [{ espece_code: 'sanglier', sous_type: null, citation: 'Le lièvre est suspendu', page: 3 }]), PAGES, SAISON)
    expect(r.ok).toBe(false)
    expect(r.details).toEqual(['suppression 1 (sanglier) : espèce absente de la citation'])
    expect(r.aRelire).toEqual([3])
  })
  it('refuse une citation de suppression introuvable', () => {
    const r = verifierPreuves(lecture([], [{ espece_code: 'lievre', sous_type: null, citation: 'Le lièvre est totalement protégé dans tout le département jusqu\'en 2030', page: 3 }]), PAGES, SAISON)
    expect(r.details[0]).toMatch(/^suppression 1 \(lievre\) : citation introuvable \(similarité 0,\d\d\)$/)
  })
})

describe('verifierPreuves — plage « du 1er au 15 septembre 2026 »', () => {
  it('le jour nu de la citation compte comme date d’ouverture', () => {
    const pages = [page(1, 'Article 4 : le chevreuil est chassé en battue du 1er au 15 septembre 2026 inclus.')]
    const r = verifierPreuves(lecture([periode({ citation: 'le chevreuil est chassé en battue du 1er au 15 septembre 2026', page: 1, espece_code: 'chevreuil', date_ouverture: '2026-09-01', date_fermeture: '2026-09-15' })]), pages, SAISON)
    expect(r).toEqual({ ok: true, details: [], aRelire: [], pagesEnEchec: [], echecs: [] })
  })
})
