import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { extraireLiens, pagesRaaAVisiter, titreDocument, decoderEntites } from './liens.ts'

const fx = (f: string) => readFileSync(new URL(`./__fixtures__/${f}`, import.meta.url), 'utf8')
const MANCHE = 'https://www.manche.gouv.fr/Publications/Recueil-des-actes-administratifs'
const VAR = 'https://www.var.gouv.fr/Publications/RAA-Recueil-des-actes-administratifs'

describe('extraireLiens — gabarit préfecture (DSFR)', () => {
  it('racine Manche : sous-pages par année, aucun PDF', () => {
    const l = extraireLiens(fx('manche-raa-racine.html'), MANCHE)
    expect(l.pdfs).toHaveLength(0)
    expect(l.sousPages.map(s => s.url)).toContain(`${MANCHE}/2026`)
    expect(l.sousPages.find(s => s.url.endsWith('/2026'))?.texte).toMatch(/2026/)
  })
  it('année Manche : cartes mensuelles « N.-Mois » + pagination', () => {
    const l = extraireLiens(fx('manche-raa-2026.html'), `${MANCHE}/2026`)
    expect(l.sousPages.map(s => s.url)).toContain(`${MANCHE}/2026/11.-Septembre`)
    expect(l.sousPages.find(s => s.url.endsWith('/10.-Aout'))?.texte).toBe('10. Août')
    expect(l.pagination).toContain(`${MANCHE}/2026/(offset)/10`)
  })
  it('mois Manche : liens PDF /contenu/telechargement/ avec espaces encodés et titre nettoyé', () => {
    const l = extraireLiens(fx('manche-raa-2026-septembre.html'), `${MANCHE}/2026/11.-Septembre`)
    expect(l.pdfs.length).toBeGreaterThanOrEqual(7)
    const p = l.pdfs.find(p => p.url.includes('551046'))!
    expect(p.url).toBe('https://www.manche.gouv.fr/contenu/telechargement/71997/551046/file/RAA%20sp%C3%A9cial%2050-2026-157.pdf')
    expect(titreDocument(p)).toBe('RAA spécial 50-2026-157')
  })
  it('mois Var : 10 PDF par page + pagination (offset)/10 et /20', () => {
    const l = extraireLiens(fx('var-raa-2026-aout.html'), `${VAR}/Recueil-des-actes-administratifs-2026/Aout-2026`)
    expect(l.pdfs).toHaveLength(10)
    expect(l.pagination).toEqual(expect.arrayContaining([
      `${VAR}/Recueil-des-actes-administratifs-2026/Aout-2026/(offset)/10`,
      `${VAR}/Recueil-des-actes-administratifs-2026/Aout-2026/(offset)/20`,
    ]))
    expect(new Set(l.pagination).size).toBe(l.pagination.length)
  })
  it('ignore les liens de partage et ancres', () => {
    const l = extraireLiens(fx('manche-raa-racine.html'), MANCHE)
    expect(l.sousPages.some(s => /twitter|facebook|linkedin/.test(s.url))).toBe(false)
  })
})

describe('pagesRaaAVisiter', () => {
  it('racine : la page de l’année courante', () => {
    const l = extraireLiens(fx('manche-raa-racine.html'), MANCHE)
    expect(pagesRaaAVisiter(l, new Date('2026-09-14'))).toEqual([`${MANCHE}/2026`])
  })
  it('année : mois courant et précédent, accents ignorés', () => {
    const l = extraireLiens(fx('manche-raa-2026.html'), `${MANCHE}/2026`)
    expect(pagesRaaAVisiter(l, new Date('2026-09-14'))).toEqual([`${MANCHE}/2026/10.-Aout`, `${MANCHE}/2026/11.-Septembre`])
  })
  it('Var : « Aout-2026 » retenu en septembre', () => {
    const l = extraireLiens(fx('var-raa-racine.html'), VAR)
    const annee = pagesRaaAVisiter(l, new Date('2026-09-14'))
    expect(annee).toEqual([`${VAR}/Recueil-des-actes-administratifs-2026`])
  })
})

describe('robustesse', () => {
  it('janvier : décembre de l’année précédente et page de l’année précédente', () => {
    const base = 'https://www.exemple.gouv.fr/raa'
    const liens = {
      pdfs: [], pagination: [],
      sousPages: [
        { url: `${base}/2026`, texte: '2026' },
        { url: `${base}/2025`, texte: '2025' },
        { url: `${base}/2024`, texte: '2024' },
        { url: `${base}/2026/1.-Janvier`, texte: '1. Janvier' },
        { url: `${base}/2025/12.-Decembre`, texte: '12. Décembre' },
        { url: `${base}/2026/Novembre-2025`, texte: 'Novembre 2025' },
      ],
    }
    expect(pagesRaaAVisiter(liens, new Date('2026-01-15'))).toEqual([
      `${base}/2026`, `${base}/2025`, `${base}/2026/1.-Janvier`, `${base}/2025/12.-Decembre`,
    ])
  })
  it('décode les entités HTML dans les href et les textes', () => {
    const html = '<a class="fr-link" href="/a/doc.pdf?x=1&amp;y=2#page=3">Arr&ecirc;t&eacute; d&#039;ouverture &amp; cl&#xF4;ture&nbsp;PDF</a>'
    const l = extraireLiens(html, 'https://www.exemple.gouv.fr/p')
    expect(l.pdfs).toEqual([{ url: 'https://www.exemple.gouv.fr/a/doc.pdf?x=1&y=2', texte: 'Arrêté d\'ouverture & clôture PDF' }])
    expect(decoderEntites('&amp;lt; &unknown; &#x1F600;')).toBe('&lt; &unknown; 😀')
  })
  it('PDF reconnu malgré ?query et #fragment ; un .pdf dans la query n’en fait pas un PDF', () => {
    const html = '<a href="/f/a.PDF?dl=1#p2">A</a><a class="fr-card__link" href="/page?file=b.pdf">B</a>'
    const l = extraireLiens(html, 'https://www.exemple.gouv.fr/')
    expect(l.pdfs.map(p => p.url)).toEqual(['https://www.exemple.gouv.fr/f/a.PDF?dl=1'])
    expect(l.sousPages.map(p => p.url)).toEqual(['https://www.exemple.gouv.fr/page?file=b.pdf'])
  })
  it('titreDocument : taille en Ko/Mo et suffixe PDF', () => {
    expect(titreDocument({ url: 'https://x.fr/a.pdf', texte: 'Télécharger Arrêté 12 PDF - 1,50 Mo - 12/05/2026' })).toBe('Arrêté 12')
    expect(titreDocument({ url: 'https://x.fr/a.pdf', texte: 'Arrêté 12 PDF - 300 Kb - 01/09/2026' })).toBe('Arrêté 12')
  })
  it('pourcentage mal formé : ne plante pas', () => {
    const l = extraireLiens('<a class="fr-card__link" href="/raa/%E0%A4%A">Septembre</a>', 'https://www.exemple.gouv.fr/')
    expect(() => pagesRaaAVisiter(l, new Date('2026-09-14'))).not.toThrow()
    expect(pagesRaaAVisiter(l, new Date('2026-09-14'))).toEqual(['https://www.exemple.gouv.fr/raa/%E0%A4%A'])
    expect(titreDocument({ url: 'https://x.fr/%E0%A4%A.pdf', texte: '' })).toBe('%E0%A4%A')
  })
})
