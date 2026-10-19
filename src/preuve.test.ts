import { describe, it, expect } from 'vitest'
import { datesGenerales, DISTANCE_MAX_FRAGMENTS, levableSurImage, verifierPreuves } from './preuve.ts'
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
    restriction_dates: null, source_article: '1', preuve: { article: '1', citation, page: p, annee_deduite: false, extraits: [] }, ...reste,
  }
}
const lecture = (periodes: PeriodeLue[], suppressions: LectureClaude['suppressions'] = []): LectureClaude => ({
  acte: { numero: null, date: null, objet: '', signe: true, departement_lu: null, saison_lue: null }, periodes, suppressions, notes: '', pages_illisibles: [],
})
const SAISON = '2026-2027'

describe('verifierPreuves — périodes', () => {
  it('accepte une citation exacte avec espèce et deux dates', () => {
    const r = verifierPreuves(lecture([periode({ citation: 'Le sanglier peut être chassé du 1er juin 2026 au 28 février 2027', page: 1 })]), PAGES, SAISON)
    expect(r).toEqual({ ok: true, details: [], pagesEnEchec: [], echecs: [], notes: [] })
  })
  it("refuse une citation sans l'espèce : détail et page en échec", () => {
    const r = verifierPreuves(lecture([periode({ citation: 'du 15 septembre 2026 au 31 janvier 2027 en battue', page: 2, espece_code: 'chevreuil', date_ouverture: '2026-09-15', date_fermeture: '2027-01-31' })]), PAGES, SAISON)
    expect(r.ok).toBe(false)
    expect(r.details).toEqual(['période 1 (chevreuil) : espèce absente de la citation'])
    expect(r.pagesEnEchec).toEqual([2])
  })
  it('refuse une citation inventée avec sa similarité', () => {
    const r = verifierPreuves(lecture([periode({ citation: 'Le sanglier est interdit toute la saison hivernale sur tout le territoire départemental', page: 1 })]), PAGES, SAISON)
    expect(r.ok).toBe(false)
    expect(r.details).toHaveLength(1)
    expect(r.details[0]).toMatch(/^période 1 \(sanglier\) : citation introuvable \(similarité 0,\d\d\)$/)
  })
  it("refuse une page inexistante", () => {
    const r = verifierPreuves(lecture([periode({ citation: 'sanglier', page: 9 })]), PAGES, SAISON)
    expect(r.details).toEqual(['période 1 (sanglier) : page 9 introuvable'])
  })
  it("refuse une date de la lecture absente de la citation", () => {
    const r = verifierPreuves(lecture([periode({ citation: 'Le sanglier peut être chassé du 1er juin 2026 au 28 février 2027', page: 1, date_fermeture: '2027-03-31' })]), PAGES, SAISON)
    expect(r.ok).toBe(false)
    expect(r.details).toEqual(["période 1 (sanglier) : date de fermeture 2027-03-31 absente de la citation"])
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
      preuve: { article: '1', citation: c, page: 1, annee_deduite: true, extraits: [] } })]), p, SAISON)
    expect(r.details).toEqual([])
  })
  it('accepte une année déduite en comparant jour et mois', () => {
    const r = verifierPreuves(lecture([periode({ citation: 'le cerf sika est chassé du 1er septembre au 28 février', page: 3, espece_code: 'cerf', sous_type: 'cerf_sika', date_ouverture: '2026-09-01', date_fermeture: '2027-02-28',
      preuve: { article: '3', citation: 'le cerf sika est chassé du 1er septembre au 28 février', page: 3, annee_deduite: true, extraits: [] } })]), PAGES, SAISON)
    expect(r).toEqual({ ok: true, details: [], pagesEnEchec: [], echecs: [], notes: [] })
  })
  it('exige « sika » pour le sous-type cerf_sika', () => {
    const c = 'est chassé du 1er septembre au 28 février. Le lièvre est suspendu.'
    const r = verifierPreuves(lecture([periode({ citation: c, page: 3, espece_code: 'cerf', sous_type: 'cerf_sika', date_ouverture: '2026-09-01', date_fermeture: '2027-02-28',
      preuve: { article: '3', citation: c, page: 3, annee_deduite: true, extraits: [] } })]), PAGES, SAISON)
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
    ], [{ espece_code: 'sanglier', sous_type: null, citation: 'Le lièvre est suspendu', page: 3, extraits: [] }]), PAGES, SAISON)
    expect(r.pagesEnEchec).toEqual([1, 2, 3, 9])
    expect(r.echecs).toEqual([
      { page: 1, nature: 'date_absente', detail: 'période 1 (sanglier) : date de fermeture 2027-03-31 absente de la citation' },
      { page: 2, nature: 'espece_absente', detail: 'période 2 (chevreuil) : espèce absente de la citation' },
      { page: 9, nature: 'page_introuvable', detail: 'période 3 (sanglier) : page 9 introuvable' },
      { page: 3, nature: 'espece_absente', detail: 'suppression 1 (sanglier) : espèce absente de la citation' },
    ])
    expect(r.details).toEqual(r.echecs.map(e => e.detail))
  })
})

describe('levableSurImage', () => {
  it('citation abîmée (similarité ≥ 0,5) levable ; citation inventée (< 0,5) bloquante ; score porté par l’échec', () => {
    const abimee = verifierPreuves(lecture([periode({ citation: 'Le sanglier peut être chassé du premier juin 2026 au 28 février 2027', page: 1 })]), PAGES, SAISON).echecs[0]
    const inventee = verifierPreuves(lecture([periode({ citation: 'Le sanglier est interdit toute la saison hivernale sur tout le territoire départemental', page: 1 })]), PAGES, SAISON).echecs[0]
    expect(abimee).toMatchObject({ nature: 'citation_introuvable' }); expect(abimee.score).toBeGreaterThanOrEqual(0.5)
    expect(inventee).toMatchObject({ nature: 'citation_introuvable' }); expect(inventee.score).toBeLessThan(0.5)
    expect(levableSurImage(abimee)).toBe(true); expect(levableSurImage(inventee)).toBe(false)
  })
  it('espèce absente, nombre altéré, date absente levables ; page introuvable et espèce sans motif bloquantes', () => {
    for (const nature of ['espece_absente', 'nombre_altere', 'date_absente'] as const) expect(levableSurImage({ page: 1, detail: '', nature })).toBe(true)
    for (const nature of ['page_introuvable', 'espece_sans_motif', 'date_ecartee'] as const) expect(levableSurImage({ page: 1, detail: '', nature })).toBe(false)
  })
})

describe('verifierPreuves — suppressions', () => {
  it('accepte une suppression dont la citation porte l\'espèce', () => {
    const r = verifierPreuves(lecture([], [{ espece_code: 'lievre', sous_type: null, citation: 'Le lièvre est suspendu', page: 3, extraits: [] }]), PAGES, SAISON)
    expect(r).toEqual({ ok: true, details: [], pagesEnEchec: [], echecs: [], notes: [] })
  })
  it("refuse une suppression sans l'espèce : détail et page en échec", () => {
    const r = verifierPreuves(lecture([], [{ espece_code: 'sanglier', sous_type: null, citation: 'Le lièvre est suspendu', page: 3, extraits: [] }]), PAGES, SAISON)
    expect(r.ok).toBe(false)
    expect(r.details).toEqual(['suppression 1 (sanglier) : espèce absente de la citation'])
    expect(r.pagesEnEchec).toEqual([3])
  })
  it('refuse une citation de suppression introuvable', () => {
    const r = verifierPreuves(lecture([], [{ espece_code: 'lievre', sous_type: null, citation: 'Le lièvre est totalement protégé dans tout le département jusqu\'en 2030', page: 3, extraits: [] }]), PAGES, SAISON)
    expect(r.details[0]).toMatch(/^suppression 1 \(lievre\) : citation introuvable \(similarité 0,\d\d\)$/)
  })
})

describe('verifierPreuves — plage « du 1er au 15 septembre 2026 »', () => {
  it('le jour nu de la citation compte comme date d’ouverture', () => {
    const pages = [page(1, 'Article 4 : le chevreuil est chassé en battue du 1er au 15 septembre 2026 inclus.')]
    const r = verifierPreuves(lecture([periode({ citation: 'le chevreuil est chassé en battue du 1er au 15 septembre 2026', page: 1, espece_code: 'chevreuil', date_ouverture: '2026-09-01', date_fermeture: '2026-09-15' })]), pages, SAISON)
    expect(r).toEqual({ ok: true, details: [], pagesEnEchec: [], echecs: [], notes: [] })
  })
})

// Arrêté en tableau : l'espèce et ses dates sont dans des cellules voisines, pas dans une même phrase.
const PAGE_TABLEAU = [
  'Article 3 – Périodes d\'ouverture spécifiques',
  'Espèces            Ouverture            Fermeture',
  'Chevreuil',
  '                   1er juin 2026        28 février 2027',
  'Sanglier',
  '                   15 août 2026         31 mars 2027',
].join('\n')
const enTableau = (extraits: string[], o: Partial<PeriodeLue> = {}): PeriodeLue => periode({ citation: '1er juin 2026        28 février 2027', page: 1, espece_code: 'chevreuil',
  preuve: { article: '3', citation: '1er juin 2026        28 février 2027', page: 1, annee_deduite: false, extraits }, ...o })

describe('verifierPreuves — preuve composée (extraits de la même page)', () => {
  it('tableau : espèce dans un extrait, dates dans la citation → ok', () => {
    expect(verifierPreuves(lecture([enTableau(['Chevreuil'])]), [page(1, PAGE_TABLEAU)], SAISON)).toEqual({ ok: true, details: [], pagesEnEchec: [], echecs: [],
      notes: ['période 1 (chevreuil) : espèce prouvée par extrait « Chevreuil »'] })
  })
  it('R47 : espèce empruntée à la ligne voisine (Chevreuil au-dessus de la ligne du sanglier) → extrait_ambigu, espèce non prouvée', () => {
    const citation = '15 août 2026         31 mars 2027'
    const p = periode({ citation, page: 1, espece_code: 'chevreuil', date_ouverture: '2026-08-15', date_fermeture: '2027-03-31',
      preuve: { article: '3', citation, page: 1, annee_deduite: false, extraits: ['Chevreuil'] } })
    const r = verifierPreuves(lecture([p]), [page(1, PAGE_TABLEAU)], SAISON)
    expect(r.ok).toBe(false)
    expect(r.echecs.map(e => e.nature)).toEqual(['extrait_ambigu', 'espece_absente'])
    expect(r.details[0]).toBe('période 1 (chevreuil) : extrait « Chevreuil » séparé de la citation par une autre espèce (sanglier)')
    expect(r.notes).toEqual([])
  })
  it('R47 : extrait d’espèce placé après la citation → extrait_ambigu', () => {
    const texte = '1er juin 2026        28 février 2027\nChevreuil'
    const r = verifierPreuves(lecture([enTableau(['Chevreuil'])]), [page(1, texte)], SAISON)
    expect(r.echecs.map(e => e.nature)).toEqual(['extrait_ambigu', 'espece_absente'])
    expect(r.details[0]).toBe('période 1 (chevreuil) : extrait « Chevreuil » après la citation')
  })
  it('extrait introuvable sur la page → échec extrait_introuvable avec sa similarité (et l’extrait ne prouve rien)', () => {
    const r = verifierPreuves(lecture([enTableau(['Cerf élaphe'])]), [page(1, PAGE_TABLEAU)], SAISON)
    expect(r.echecs[0]).toMatchObject({ page: 1, nature: 'extrait_introuvable' })
    expect(r.echecs[0].detail).toMatch(/^période 1 \(chevreuil\) : extrait « Cerf élaphe » introuvable \(similarité 0,\d\d\)$/)
    expect(r.echecs[0].score).toBeLessThan(0.9)
    expect(r.echecs.map(e => e.nature)).toEqual(['extrait_introuvable', 'espece_absente'])
  })
  it('extrait trop éloigné de la citation → échec extraits_eloignes', () => {
    const loin = PAGE_TABLEAU + '\n' + 'x '.repeat(DISTANCE_MAX_FRAGMENTS) + '\nChevreuil des Landes'
    const r = verifierPreuves(lecture([enTableau(['Chevreuil des Landes'])]), [page(1, loin)], SAISON)
    expect(r.echecs.map(e => e.nature)).toContain('extraits_eloignes')
    expect(r.details[0]).toMatch(/^période 1 \(chevreuil\) : extrait « Chevreuil des Landes » trop éloigné de la citation \(\d+ caractères\)$/)
  })
  it('sans extrait, comportement inchangé (espèce absente de la citation)', () => {
    expect(verifierPreuves(lecture([enTableau([])]), [page(1, PAGE_TABLEAU)], SAISON).echecs.map(e => e.nature)).toEqual(['espece_absente'])
  })
  it('une date portée par un extrait compte', () => {
    const p = periode({ citation: 'Chevreuil', page: 1, espece_code: 'chevreuil',
      preuve: { article: '3', citation: 'Chevreuil', page: 1, annee_deduite: false, extraits: ['1er juin 2026        28 février 2027'] } })
    expect(verifierPreuves(lecture([p]), [page(1, PAGE_TABLEAU)], SAISON).ok).toBe(true)
  })
  it('suppression : espèce dans un extrait → ok', () => {
    const pages = [page(1, 'Lièvre\n   La chasse est suspendue pour toute la campagne.')]
    const r = verifierPreuves(lecture([], [{ espece_code: 'lievre', sous_type: null, citation: 'La chasse est suspendue pour toute la campagne', page: 1, extraits: ['Lièvre'] }]), pages, SAISON)
    expect(r.ok).toBe(true)
  })
})

// Renvois aux dates générales : une cellule « Clôture générale » renvoie à une date écrite une seule fois ailleurs dans l'arrêté.
const chevreuilCloture = (o: Partial<PeriodeLue['preuve']> = {}): PeriodeLue => {
  const citation = 'Chevreuil          1er juin 2026          Clôture générale'
  return periode({ citation, page: 1, espece_code: 'chevreuil', preuve: { article: '3', citation, page: 1, annee_deduite: false, extraits: [], ...o } })
}
const CLOTURE = 'Article 1 : La clôture générale est fixée au 28 février 2027.'
const TABLEAU_CLOTURE = 'Article 3 :\nEspèces          Ouverture          Fermeture\nChevreuil          1er juin 2026          Clôture générale'

describe('verifierPreuves — preuve composée : l’espèce ouvre la ligne de ses dates (R50)', () => {
  const chevreuil = (citation: string, extraits: string[], o: Partial<PeriodeLue> = {}) => periode({ citation, page: 1, espece_code: 'chevreuil',
    date_ouverture: '2026-08-15', date_fermeture: '2027-03-31', preuve: { article: '3', citation, page: 1, annee_deduite: false, extraits }, ...o })
  const SANGLIER = '15 août 2026         31 mars 2027'
  it('espèce dans la citation, dates prises sur la ligne du sanglier → extrait_ambigu, dates non comptées', () => {
    const r = verifierPreuves(lecture([chevreuil('Espèces            Ouverture            Fermeture\nChevreuil', [SANGLIER])]), [page(1, PAGE_TABLEAU)], SAISON)
    expect(r.echecs.map(e => e.nature)).toEqual(['extrait_ambigu', 'date_absente', 'date_absente'])
    expect(r.details[0]).toBe(`période 1 (chevreuil) : extrait « ${SANGLIER} » séparé de l'espèce par une autre espèce (sanglier)`)
    expect(levableSurImage(r.echecs[0])).toBe(false)
  })
  it('variante : citation « Chevreuil / 1er juin 2026 » + dates du sanglier → extrait_ambigu', () => {
    const r = verifierPreuves(lecture([chevreuil('Chevreuil\n                   1er juin 2026', [SANGLIER])]), [page(1, PAGE_TABLEAU)], SAISON)
    expect(r.ok).toBe(false)
    expect(r.echecs[0]).toMatchObject({ nature: 'extrait_ambigu' })
  })
  it('ligne légitime (style Ille-et-Vilaine) : cellule de l’espèce puis ses dates, aucune autre espèce entre → ok', () => {
    const texte = 'Lièvre          11 octobre 2026          13 décembre 2026\nSanglier         15 août 2026             31 mars 2027'
    const r = verifierPreuves(lecture([chevreuil('Lièvre', ['11 octobre 2026          13 décembre 2026'], { espece_code: 'lievre', date_ouverture: '2026-10-11', date_fermeture: '2026-12-13' })]), [page(1, texte)], SAISON)
    expect(r).toMatchObject({ ok: true, echecs: [] })
  })
  it('espèce placée après le fragment daté → extrait_ambigu', () => {
    const r = verifierPreuves(lecture([chevreuil('Chevreuil', ['1er juin 2026        28 février 2027'], { date_ouverture: '2026-06-01', date_fermeture: '2027-02-28' })]),
      [page(1, '1er juin 2026        28 février 2027\nChevreuil')], SAISON)
    expect(r.echecs.map(e => e.nature)).toEqual(['extrait_ambigu', 'date_absente', 'date_absente'])
    expect(r.details[0]).toBe("période 1 (chevreuil) : extrait « 1er juin 2026        28 février 2027 » placé avant l'espèce")
  })
  // R51 : une date présente dans la preuve mais écartée est « écartée », jamais « absente » (sinon levable sur image).
  const LIGNES_CHEVREUIL_SANGLIER = 'Chevreuil          1er juin 2026          Clôture générale\nSanglier           15 août 2026           31 mars 2027'
  const ENTETE = 'Espèces            Ouverture            Fermeture'
  it('extrait daté qui porte lui-même l’espèce : les dates de la ligne suivante (sanglier) sont écartées (R51)', () => {
    const texte = `${ENTETE}\n${LIGNES_CHEVREUIL_SANGLIER}`
    const r = verifierPreuves(lecture([chevreuil(`${ENTETE}\nChevreuil`, [LIGNES_CHEVREUIL_SANGLIER])]), [page(1, texte)], SAISON)
    expect(r.ok).toBe(false)
    expect(r.echecs.map(e => e.nature)).toEqual(['date_ecartee', 'date_ecartee'])
    expect(r.details).toEqual([
      "période 1 (chevreuil) : date d'ouverture 2026-08-15 écartée (autre espèce entre l'espèce et la date : sanglier)",
      "période 1 (chevreuil) : date de fermeture 2027-03-31 écartée (autre espèce entre l'espèce et la date : sanglier)",
    ])
  })
  it('dates situées avant l’espèce (extrait « dates / Chevreuil » placé avant la citation) : écartées (R51)', () => {
    const texte = '15 août 2026           31 mars 2027\nChevreuil\n1er juin 2026          Clôture générale'
    const r = verifierPreuves(lecture([chevreuil('1er juin 2026          Clôture générale', ['15 août 2026           31 mars 2027\nChevreuil'])]), [page(1, texte)], SAISON)
    expect(r.ok).toBe(false)
    expect(r.echecs.map(e => e.nature)).toEqual(['date_ecartee', 'date_ecartee'])
    expect(r.details).toEqual([
      "période 1 (chevreuil) : date d'ouverture 2026-08-15 écartée (date placée avant l'espèce)",
      "période 1 (chevreuil) : date de fermeture 2027-03-31 écartée (date placée avant l'espèce)",
    ])
  })
  it('page OCR : une date écartée n’est pas levable sur image (R51)', () => {
    const texte = `${ENTETE}\n${LIGNES_CHEVREUIL_SANGLIER}`
    const ocr: PageTexte = { n: 1, source: 'ocr', texte, nbDates: 0, nbEspeces: 0 }
    const r = verifierPreuves(lecture([chevreuil(`${ENTETE}\nChevreuil`, [LIGNES_CHEVREUIL_SANGLIER])]), [ocr], SAISON)
    expect(r.echecs.map(e => e.nature)).toEqual(['date_ecartee', 'date_ecartee'])
    expect(r.echecs.every(e => !levableSurImage(e))).toBe(true)
  })
  it('un renvoi aux dates générales ne ressuscite pas une date écartée (R51)', () => {
    const texte = `Article 1 : la clôture générale est fixée au 31 mars 2027.\nArticle 3 :\n${ENTETE}\n${LIGNES_CHEVREUIL_SANGLIER}`
    const r = verifierPreuves(lecture([chevreuil(`${ENTETE}\nChevreuil`, [LIGNES_CHEVREUIL_SANGLIER], { date_ouverture: '2026-06-01' })]), [page(1, texte)], SAISON)
    expect(r.echecs.map(e => e.nature)).toEqual(['date_ecartee'])
    expect(r.details).toEqual(["période 1 (chevreuil) : date de fermeture 2027-03-31 écartée (autre espèce entre l'espèce et la date : sanglier)"])
    expect(r.notes).toEqual([])
  })
  it('citation avec l’espèce et ses dates + extrait portant le renvoi → ok', () => {
    const texte = "Article 1 : la clôture générale est fixée au 28 février 2027.\nArticle 3 :\nChevreuil          1er juin 2026\n                   jusqu'à la clôture générale"
    const r = verifierPreuves(lecture([chevreuil('Chevreuil          1er juin 2026', ["jusqu'à la clôture générale"], { date_ouverture: '2026-06-01', date_fermeture: '2027-02-28' })]), [page(1, texte)], SAISON)
    expect(r).toMatchObject({ ok: true, echecs: [], notes: ['période 1 (chevreuil) : date de fermeture 2027-02-28 = clôture générale (renvoi)'] })
  })
  it('sans extrait, inchangé : un article qui cite plusieurs espèces pour les mêmes dates reste valable', () => {
    const c = 'La chasse du lièvre, de la perdrix et du faisan est ouverte du 27 septembre 2026 au 28 février 2027'
    const r = verifierPreuves(lecture([periode({ citation: c, page: 1, espece_code: 'lievre', date_ouverture: '2026-09-27', date_fermeture: '2027-02-28' })]), [page(1, `Article 2 : ${c}.`)], SAISON)
    expect(r).toMatchObject({ ok: true, echecs: [] })
  })
})

describe('verifierPreuves — renvois aux dates générales', () => {
  it('cellule « Clôture générale » + clôture générale datée sur la page → ok, renvoi noté', () => {
    const r = verifierPreuves(lecture([chevreuilCloture()]), [page(1, `${CLOTURE}\n${TABLEAU_CLOTURE}`)], SAISON)
    expect(r).toMatchObject({ ok: true, echecs: [], notes: ['période 1 (chevreuil) : date de fermeture 2027-02-28 = clôture générale (renvoi)'] })
  })
  it('renvoi sur une autre page que la date générale → ok', () => {
    const r = verifierPreuves(lecture([chevreuilCloture({ page: 2 })]), [page(1, CLOTURE), page(2, TABLEAU_CLOTURE)], SAISON)
    expect(r.ok).toBe(true)
  })
  it('« de l’ouverture générale au 31 janvier 2027 » : ouverture par renvoi, fermeture littérale → ok', () => {
    const pages = [page(1, "La période d'ouverture générale de la chasse à tir est fixée :\n     du 27 septembre 2026 au 28 février 2027"),
      page(2, 'La chasse du faisan est autorisée de l’ouverture générale au 31 janvier 2027 sur le territoire de la\ncommune de Oizon.')]
    const citation = 'La chasse du faisan est autorisée de l’ouverture générale au 31 janvier 2027 sur'
    const r = verifierPreuves(lecture([periode({ citation, page: 2, espece_code: 'faisan', date_ouverture: '2026-09-27', date_fermeture: '2027-01-31' })]), pages, SAISON)
    expect(r).toMatchObject({ ok: true, notes: ["période 1 (faisan) : date d'ouverture 2026-09-27 = ouverture générale (renvoi)"] })
  })
  it('renvoi sans date générale dans le document → date_absente', () => {
    const r = verifierPreuves(lecture([chevreuilCloture()]), [page(1, TABLEAU_CLOTURE)], SAISON)
    expect(r.echecs).toEqual([{ page: 1, nature: 'date_absente', detail: 'période 1 (chevreuil) : date de fermeture 2027-02-28 absente de la citation' }])
    expect(r.notes).toEqual([])
  })
  it('un renvoi ne vaut que pour sa date : « ouverture générale » ne prouve pas une fermeture', () => {
    const pages = [page(1, "Article 1 : l'ouverture générale est fixée au 13 septembre 2026.\nArticle 4 : le lapin est chassé de l'ouverture générale à la fin de la saison.")]
    const citation = "le lapin est chassé de l'ouverture générale à la fin de la saison"
    const r = verifierPreuves(lecture([periode({ citation, page: 1, espece_code: 'lapin', date_ouverture: '2026-09-13', date_fermeture: '2026-09-13' })]), pages, SAISON)
    expect(r.echecs.map(e => e.detail)).toEqual(['période 1 (lapin) : date de fermeture 2026-09-13 absente de la citation'])
  })
  it('« jusqu’à la veille de l’ouverture générale » (13 septembre) : fermeture 12 septembre ok, 11 septembre → date_absente', () => {
    const pages = [page(1, "Article 1 : l'ouverture générale de la chasse est fixée au 13 septembre 2026.\nArticle 4 : le lapin est chassé du 1er août 2026 jusqu'à la veille de l'ouverture générale.")]
    const lapin = (date_fermeture: string) => periode({ citation: "le lapin est chassé du 1er août 2026 jusqu'à la veille de l'ouverture générale", page: 1, espece_code: 'lapin', date_ouverture: '2026-08-01', date_fermeture })
    expect(verifierPreuves(lecture([lapin('2026-09-12')]), pages, SAISON)).toMatchObject({ ok: true,
      notes: ["période 1 (lapin) : date de fermeture 2026-09-12 = veille de l'ouverture générale (renvoi)"] })
    expect(verifierPreuves(lecture([lapin('2026-09-11')]), pages, SAISON).echecs.map(e => e.nature)).toEqual(['date_absente'])
  })
  it('« le lendemain de la clôture générale » : date − 1 jour dans les clôtures', () => {
    const pages = [page(1, "Article 1 : la clôture générale est fixée au 28 février 2027.\nArticle 5 : le renard est chassé du 1er juin 2026 au lendemain de la clôture générale.")]
    const r = verifierPreuves(lecture([periode({ citation: 'le renard est chassé du 1er juin 2026 au lendemain de la clôture générale', page: 1, espece_code: 'renard', date_ouverture: '2026-06-01', date_fermeture: '2027-03-01' })]), pages, SAISON)
    expect(r).toMatchObject({ ok: true, notes: ['période 1 (renard) : date de fermeture 2027-03-01 = lendemain de la clôture générale (renvoi)'] })
  })
  it('l’espèce reste exigée : renvoi sans espèce → espece_absente', () => {
    const citation = '1er juin 2026          Clôture générale'
    const r = verifierPreuves(lecture([periode({ citation, page: 1, espece_code: 'chevreuil', preuve: { article: '3', citation, page: 1, annee_deduite: false, extraits: [] } })]),
      [page(1, `${CLOTURE}\n${TABLEAU_CLOTURE}`)], SAISON)
    expect(r.echecs.map(e => e.nature)).toEqual(['espece_absente'])
  })
  it('le renvoi peut être porté par un extrait (cellule « Clôture / générale » coupée par la mise en page)', () => {
    const texte = `${CLOTURE}\nChevreuil          1er juin 2026          Clôture       - plan de chasse\n                                         générale      - du 1er juin à l’ouverture`
    const citation = 'Chevreuil          1er juin 2026          Clôture'
    const r = verifierPreuves(lecture([periode({ citation, page: 1, espece_code: 'chevreuil', preuve: { article: '3', citation, page: 1, annee_deduite: false, extraits: ['générale'] } })]),
      [page(1, texte)], SAISON)
    expect(r.ok).toBe(true)
  })
})

describe('verifierPreuves — garde-fous des renvois (R48)', () => {
  const FAISAN = "Article 1 : l'ouverture générale est fixée au 27 septembre 2026.\nArticle 4 : faisan : de l'ouverture générale au 31 janvier 2027 ; en battue du 1er décembre 2026 au 31 janvier 2027."
  const faisan = (citation: string) => periode({ citation, page: 1, espece_code: 'faisan', date_ouverture: '2026-09-27', date_fermeture: '2027-01-31' })
  it('preuve à plusieurs dates littérales : pas de renvoi → date_absente sur l’ouverture', () => {
    const r = verifierPreuves(lecture([faisan("faisan : de l'ouverture générale au 31 janvier 2027 ; en battue du 1er décembre 2026 au 31 janvier 2027")]), [page(1, FAISAN)], SAISON)
    expect(r.echecs).toEqual([{ page: 1, nature: 'date_absente', detail: "période 1 (faisan) : date d'ouverture 2026-09-27 absente de la citation" }])
    expect(r.notes).toEqual([])
  })
  it('« de l’ouverture générale au 31 janvier 2027 » seul : renvoi admis', () => {
    expect(verifierPreuves(lecture([faisan("faisan : de l'ouverture générale au 31 janvier 2027")]), [page(1, FAISAN)], SAISON).ok).toBe(true)
  })
  it('« veille » détachée de l’expression : décalage non appliqué', () => {
    const texte = "Article 1 : l'ouverture générale est fixée au 13 septembre 2026.\nArticle 4 : le lapin, chassé la veille, reste chassé du 1er août 2026 à l'ouverture générale."
    const citation = "le lapin, chassé la veille, reste chassé du 1er août 2026 à l'ouverture générale"
    const r = verifierPreuves(lecture([periode({ citation, page: 1, espece_code: 'lapin', date_ouverture: '2026-08-01', date_fermeture: '2026-09-12' })]), [page(1, texte)], SAISON)
    expect(r.echecs.map(e => e.detail)).toEqual(['période 1 (lapin) : date de fermeture 2026-09-12 absente de la citation'])
  })
})

describe('datesGenerales', () => {
  it('dates lues dans les 200 caractères qui suivent « ouverture générale » / « clôture générale » / « fermeture générale », toutes pages', () => {
    const g = datesGenerales([page(1, "L'ouverture générale est fixée au 13 septembre 2026."), page(2, 'La fermeture générale : 28 février 2027. ' + 'x'.repeat(250) + ' 31 mars 2027')], SAISON)
    expect([...g.ouvertures]).toEqual(['2026-09-13'])
    expect([...g.clotures]).toEqual(['2027-02-28'])
  })
})

describe('datesGenerales — première date ou première plage après chaque expression (R46)', () => {
  const CHER = "1.1 - La période d’ouverture générale de la chasse à tir est fixée :\n\n      du 27 septembre 2026 au 28 février 2027\n\npour toutes les espèces de gibier"
  it('« période d’ouverture générale … du A au B » : A → ouvertures, B → clôtures', () => {
    const g = datesGenerales([page(1, CHER)], SAISON)
    expect([...g.ouvertures]).toEqual(['2026-09-27'])
    expect([...g.clotures]).toEqual(['2027-02-28'])
  })
  it('cellule « Clôture générale » sur une autre page : fermeture 2027-02-28 admise par la plage générale', () => {
    const r = verifierPreuves(lecture([chevreuilCloture({ page: 2 })]), [page(1, CHER), page(2, TABLEAU_CLOTURE)], SAISON)
    expect(r).toMatchObject({ ok: true, notes: ['période 1 (chevreuil) : date de fermeture 2027-02-28 = clôture générale (renvoi)'] })
  })
  it('bruit : seule la première date suit l’expression', () => {
    const g = datesGenerales([page(1, "L'ouverture générale est fixée le 13 septembre 2026. Le 1er juin 2026, la chasse du chevreuil est ouverte.")], SAISON)
    expect([...g.ouvertures]).toEqual(['2026-09-13'])
    expect([...g.clotures]).toEqual([])
  })
  it('« clôture générale » : première date seulement, vers les clôtures', () => {
    const g = datesGenerales([page(1, 'La clôture générale est fixée au 28 février 2027, sauf du 1er au 15 mars 2027.')], SAISON)
    expect([...g.clotures]).toEqual(['2027-02-28'])
    expect([...g.ouvertures]).toEqual([])
  })
  it('citation recopiée à cheval sur deux lignes (« Ouverture\\ngénérale ») : renvoi reconnu', () => {
    const texte = "Article 1 : l'ouverture générale est fixée au 27 septembre 2026.\nArticle 3 : Faisan : de l'Ouverture\ngénérale au 31 janvier 2027."
    const citation = "Faisan : de l'Ouverture\ngénérale au 31 janvier 2027"
    const r = verifierPreuves(lecture([periode({ citation, page: 1, espece_code: 'faisan', date_ouverture: '2026-09-27', date_fermeture: '2027-01-31' })]), [page(1, texte)], SAISON)
    expect(r).toMatchObject({ ok: true, notes: ["période 1 (faisan) : date d'ouverture 2026-09-27 = ouverture générale (renvoi)"] })
  })
})

describe('levableSurImage — extraits', () => {
  it('extrait introuvable levable si abîmé (≥ 0,5), jamais un extrait éloigné ou ambigu', () => {
    expect(levableSurImage({ page: 1, detail: '', nature: 'extrait_ambigu' })).toBe(false)
    expect(levableSurImage({ page: 1, detail: '', nature: 'extrait_introuvable', score: 0.6 })).toBe(true)
    expect(levableSurImage({ page: 1, detail: '', nature: 'extrait_introuvable', score: 0.3 })).toBe(false)
    expect(levableSurImage({ page: 1, detail: '', nature: 'extraits_eloignes' })).toBe(false)
  })
})
