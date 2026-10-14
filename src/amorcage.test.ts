import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { deriverSources, sqlAmorcage, DOMAINES_PREFECTURES, type ArreteUrl } from './amorcage.ts'

describe('deriverSources', () => {
  it('fédération : url_source gardée, vérifiée ; RAA ajouté non vérifié', () => {
    const s = deriverSources([{ departement: '24', url_source: 'https://www.chasseurs24.com/wp-content/uploads/2026/06/AP.pdf' }])
    expect(s).toEqual(expect.arrayContaining([
      { departement: '24', type_source: 'federation', url: 'https://www.chasseurs24.com/wp-content/uploads/2026/06/AP.pdf', verifiee: true },
      { departement: '24', type_source: 'prefecture_raa', url: 'https://www.dordogne.gouv.fr/Publications/Recueil-des-actes-administratifs', verifiee: false },
    ]))
    expect(s).toHaveLength(2)
  })
  it('préfecture : page chasse parente si page HTML, sinon seulement RAA', () => {
    const s = deriverSources([{ departement: '62', url_source: 'https://www.pas-de-calais.gouv.fr/Publications/Consultation-du-public/Chasse-et-Faune-sauvage/Informations-post-consultation/Arrete-2026' }])
    expect(s.find(x => x.type_source === 'prefecture_consultation')?.url).toBe('https://www.pas-de-calais.gouv.fr/Publications/Consultation-du-public/Chasse-et-Faune-sauvage/Informations-post-consultation')
    const c = deriverSources([{ departement: '31', url_source: 'https://www.haute-garonne.gouv.fr/Actions-de-l-Etat/Chasse/Actes-reglementaires/Arrete' }])
    expect(c.find(x => x.type_source === 'prefecture_chasse')).toEqual({ departement: '31', type_source: 'prefecture_chasse', url: 'https://www.haute-garonne.gouv.fr/Actions-de-l-Etat/Chasse/Actes-reglementaires', verifiee: false })
    const p = deriverSources([{ departement: '06', url_source: 'https://www.alpes-maritimes.gouv.fr/contenu/telechargement/59598/455176/file/AP.pdf' }])
    expect(p.map(x => x.type_source)).toEqual(['prefecture_raa'])
  })
  it('site de l\'État tiers (DRIEAT) : prefecture_chasse sur le dossier parent, non vérifiée, plus le RAA', () => {
    const s = deriverSources([{ departement: '92', url_source: 'https://www.drieat.ile-de-france.developpement-durable.gouv.fr/IMG/pdf/projet_ap92.pdf' }])
    expect(s).toEqual([
      { departement: '92', type_source: 'prefecture_chasse', url: 'https://www.drieat.ile-de-france.developpement-durable.gouv.fr/IMG/pdf', verifiee: false, note: expect.stringContaining('à corriger à la main') },
      { departement: '92', type_source: 'prefecture_raa', url: 'https://www.hauts-de-seine.gouv.fr/Publications/Recueil-des-actes-administratifs', verifiee: false },
    ])
  })
  it('url_source vide ou invalide : seulement le RAA ; département inconnu : erreur', () => {
    expect(deriverSources([{ departement: '24', url_source: null }]).map(x => x.type_source)).toEqual(['prefecture_raa'])
    expect(deriverSources([{ departement: '24', url_source: 'pas une url' }]).map(x => x.type_source)).toEqual(['prefecture_raa'])
    expect(() => deriverSources([{ departement: 'XX', url_source: null }])).toThrow(/XX/)
  })
  it('table des domaines : 96 départements (2A/2B inclus, 20 exclu), formats valides, sans doublon', () => {
    expect(Object.keys(DOMAINES_PREFECTURES)).toHaveLength(96)
    expect(Object.keys(DOMAINES_PREFECTURES)).toEqual(expect.arrayContaining(['2A', '2B', '75']))
    for (const d of Object.values(DOMAINES_PREFECTURES)) expect(d).toMatch(/^www\.[a-z0-9.-]+\.gouv\.fr$/)
    expect(new Set(Object.values(DOMAINES_PREFECTURES)).size).toBe(96)
    expect(DOMAINES_PREFECTURES['20']).toBeUndefined() // la Corse est 2A / 2B
  })
  it('export réel 2026-2027 : 95 RAA, 44 fédérations, chaque .gouv.fr de préfecture correspond à la table', () => {
    const arretes: ArreteUrl[] = JSON.parse(readFileSync(new URL('./__fixtures__/arretes-urls-2026-2027.json', import.meta.url), 'utf8'))
    const s = deriverSources(arretes)
    const n = (t: string) => s.filter(x => x.type_source === t).length
    expect(n('prefecture_raa')).toBe(95)
    expect(n('federation')).toBe(44)
    expect(n('prefecture_chasse') + n('prefecture_consultation')).toBe(4) // 31, 62, 92, 93
    expect(s.filter(x => x.verifiee).every(x => x.type_source === 'federation')).toBe(true)
    // Seuls 92 et 93 pointent vers un site de l'État autre que la préfecture.
    const tiers = arretes.filter(a => new URL(a.url_source!).hostname.endsWith('.gouv.fr') && new URL(a.url_source!).hostname !== DOMAINES_PREFECTURES[a.departement])
    expect(tiers.map(a => a.departement)).toEqual(['92', '93'])
  })
})

describe('sqlAmorcage', () => {
  it('INSERT idempotent, now() si vérifiée, apostrophes doublées, ordre stable', () => {
    const sql = sqlAmorcage([
      { departement: '24', type_source: 'prefecture_raa', url: 'https://www.dordogne.gouv.fr/Publications/Recueil-des-actes-administratifs', verifiee: false },
      { departement: '21', type_source: 'federation', url: "https://fdc21.fr/l'arrete.pdf", verifiee: true },
    ])
    expect(sql).toBe(
      "INSERT INTO public.arretes_sources (departement, type_source, url, verifiee_le, notes) VALUES\n" +
      "  ('21', 'federation', 'https://fdc21.fr/l''arrete.pdf', now(), 'amorçage 2026-10 depuis arretes.url_source'),\n" +
      "  ('24', 'prefecture_raa', 'https://www.dordogne.gouv.fr/Publications/Recueil-des-actes-administratifs', NULL, 'amorçage 2026-10 heuristique domaine')\n" +
      "ON CONFLICT (departement, type_source, url) DO NOTHING;\n")
  })
  it('note propre à la source (site tiers) prioritaire sur la note par défaut', () => {
    const sql = sqlAmorcage([{ departement: '92', type_source: 'prefecture_chasse', url: 'https://x.gouv.fr/IMG/pdf', verifiee: false, note: "à corriger l'url" }])
    expect(sql).toContain("NULL, 'à corriger l''url')")
  })
  it('liste vide : chaîne vide', () => { expect(sqlAmorcage([])).toBe('') })
})
