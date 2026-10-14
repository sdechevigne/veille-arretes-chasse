import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { extraireLiens, pagesRaaAVisiter, titreDocument } from './liens.ts'

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
