import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { construireDossier } from './dossier.ts'
import type { PeriodePubliee } from './difference.ts'
import type { PageTexte } from './types.ts'

const FIXTURE_54: { pages: PageTexte[] } = JSON.parse(readFileSync(new URL('./__fixtures__/54-ap.texte.json', import.meta.url), 'utf8'))
const page = (n: number, texte: string): PageTexte => ({ n, source: 'native', texte, nbDates: 0, nbEspeces: 0 })

const PAGES = [
  page(1, `PRÉFET DE MEURTHE-ET-MOSELLE
ARRÊTÉ n° 2026/DDT/48 relatif à l'ouverture et à la clôture de la chasse
Campagne 2026-2027
VU le code de l'environnement,
et notamment ses articles R 424-3 à R 424-9 ;
vu l'arrêté ministériel du 26 juin 1987 ;

Considérant l'avis de la commission départementale ;
ARRÊTE
Article 1er : La chasse est ouverte du 20 septembre 2026 au 28 février 2027.
Article 2 : Les dispositions du code rural s'appliquent.
Article 3 : Le chevreuil est chassé en battue du 15 octobre 2026`),
  page(2, `au 31 janvier 2027 inclus.
Article 4 : Le présent arrêté est publié au recueil des actes administratifs.
Fait à Nancy, le 12 août 2026
Pour le préfet, le directeur, [SIGNATAIRE]`),
]

const base = { departement: '54', nom: 'Meurthe-et-Moselle', saison: '2026-2027', type: 'annuel' as const, pages: PAGES }

describe('construireDossier', () => {
  const d = construireDossier({ ...base, mode: 'complet' })

  it("commence par la ligne d'identité", () => {
    expect(d.texte.split('\n')[0]).toBe('Département 54 (Meurthe-et-Moselle), saison 2026-2027, type annuel, mode complet')
  })

  it("garde l'en-tête sans les visas (lignes « vu » et leurs lignes de suite)", () => {
    expect(d.texte).toContain('=== En-tête (page 1) ===')
    expect(d.texte).toContain('Campagne 2026-2027')
    expect(d.texte).toContain("Considérant l'avis de la commission départementale ;")
    expect(d.texte).not.toMatch(/^\s*vu\b/im)
    expect(d.texte).not.toContain('R 424-3')
  })

  it("tronque l'en-tête à 1 500 caractères", () => {
    const long = construireDossier({ ...base, mode: 'complet', pages: [page(1, 'X'.repeat(5000) + '\nArticle 1 : du 1er juin 2026 au 28 février 2027.')] })
    const entete = long.texte.split('=== En-tête (page 1) ===\n')[1].split('\n=== Article')[0]
    expect(entete.replace(/\n?\[…\]\s*$/, '').length).toBeLessThanOrEqual(1500)
    expect(entete).toContain('[…]')
  })

  it('ne garde que les articles datés, plus le dernier (bloc de signature)', () => {
    expect(d.texte).toContain('=== Article 1 (page 1) ===')
    expect(d.texte).toContain('=== Article 3 (page 1) ===')
    expect(d.texte).toContain('=== Article 4 (page 2) ===')
    expect(d.texte).not.toContain('=== Article 2')
    expect(d.texte).not.toContain('code rural')
  })

  it("insère un marqueur de page dans un article à cheval, sans altérer le texte de chaque page", () => {
    expect(d.texte).toContain('Article 3 : Le chevreuil est chassé en battue du 15 octobre 2026\n--- page 2 ---\nau 31 janvier 2027 inclus.')
    expect(d.texte).toContain('Fait à Nancy, le 12 août 2026\nPour le préfet, le directeur, [SIGNATAIRE]')
    expect(d.pagesIncluses).toEqual([1, 2])
  })

  it("garde le dernier article même non daté (projet : « Fait à , le » vide)", () => {
    const projet = [PAGES[0], page(2, 'au 31 janvier 2027 inclus.\nArticle 4 : Publication.\nFait à , le\nLe préfet')]
    const p = construireDossier({ ...base, type: 'projet', mode: 'complet', pages: projet })
    expect(p.texte).toContain('=== Article 4 (page 2) ===\nArticle 4 : Publication.\nFait à , le\nLe préfet')
  })

  it('filtre sur les articles ciblés quand ils sont donnés', () => {
    const c = construireDossier({ ...base, mode: 'complet', articlesCibles: ['3'] })
    expect(c.texte).toContain('=== Article 3 (page 1) ===')
    expect(c.texte).not.toContain('=== Article 1 (page 1) ===')
  })

  it('ajoute en mode difference le bloc des périodes publiées en lignes compactes', () => {
    const publiees: PeriodePubliee[] = [
      { espece_code: 'sanglier', sous_type: null, date_ouverture: '2026-06-01', date_fermeture: '2027-02-28', mode_chasse: 'tous_modes', restriction_dates: null, source_article: 'art. 2' },
      { espece_code: 'cerf', sous_type: 'cerf_elaphe', date_ouverture: '2026-09-01', date_fermeture: '2027-02-28', mode_chasse: 'approche_affut', restriction_dates: null, source_article: null },
    ]
    const m = construireDossier({ ...base, type: 'modificatif', mode: 'difference', publiees })
    expect(m.texte.split('\n')[0]).toContain('type modificatif, mode difference')
    expect(m.texte).toContain('=== Périodes actuellement publiées ===\n'
      + 'sanglier | - | tous_modes | 2026-06-01 → 2027-02-28 | art. 2\n'
      + 'cerf | cerf_elaphe | approche_affut | 2026-09-01 → 2027-02-28 | -')
    expect(d.texte).not.toContain('Périodes actuellement publiées')
  })

  it('réduit le dossier script_projet_signe à en-tête + dernier article + signature', () => {
    const s = construireDossier({ ...base, mode: 'script_projet_signe' })
    expect(s.texte).toContain('=== En-tête (page 1) ===')
    expect(s.texte).toContain('=== Article 4 (page 2) ===')
    expect(s.texte).toContain('[SIGNATAIRE]')
    expect(s.texte).not.toContain('=== Article 1')
    expect(s.texte).not.toContain('=== Article 3')
    expect(s.pagesIncluses).toEqual([1, 2])
  })

  it("sur un vrai arrêté (54), chaque morceau d'article est une sous-chaîne exacte de la page annoncée par son repère", () => {
    const reel = construireDossier({ ...base, mode: 'complet', pages: FIXTURE_54.pages })
    const morceaux = reel.texte.split('\n\n=== Article ').slice(1)
      .flatMap(b => b.split('\n--- page ').map((m, i) => i === 0
        ? { page: Number(/\(page (\d+)\) ===/.exec(m)![1]), texte: m.slice(m.indexOf('===\n') + 4) }
        : { page: Number(m.slice(0, m.indexOf(' '))), texte: m.slice(m.indexOf('---\n') + 4) }))
    expect(morceaux.length).toBeGreaterThan(5)
    for (const m of morceaux) {
      const texte = m.texte.split('\n\n=== Périodes')[0]
      expect(FIXTURE_54.pages.find(p => p.n === m.page)!.texte).toContain(texte)
    }
    expect(reel.estimationTokens).toBeLessThan(10000)
  })

  it('estime les tokens à longueur / 3,2', () => {
    expect(d.estimationTokens).toBe(Math.ceil(d.texte.length / 3.2))
  })
})
