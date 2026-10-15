import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { argsImagePage, lirePage, qualitePage, qualiteDocument, run } from './pdf.ts'
import { compterDates, compterEspeces } from './lexique.ts'
import type { OutilsPdf } from './pdf.ts'
import type { PageTexte } from './types.ts'

const outils = (natif: string, ocr: string): OutilsPdf => ({ async nbPages() { return 1 }, async texteNatif() { return natif }, async ocrPage() { return ocr }, async imagePage() { return Buffer.alloc(0) } })
const long = (s: string) => Array(40).fill(s).join(' ')

describe('lirePage', () => {
  it('texte natif suffisant : pas d’OCR', async () => {
    const p = await lirePage(outils(long('mot') + ' sanglier 1er juin 2026', 'JAMAIS'), 'x.pdf', 1)
    expect(p.source).toBe('native'); expect(p.nbDates).toBe(1); expect(p.nbEspeces).toBe(1)
  })
  it('page vide ou presque : OCR', async () => {
    const p = await lirePage(outils('  ', 'chevreuil du 01/06/2026 au 28/02/2027'), 'x.pdf', 1)
    expect(p.source).toBe('ocr'); expect(p.nbDates).toBe(2)
  })
  it('échec outil : page en erreur, pas d’exception', async () => {
    const p = await lirePage({ async nbPages() { return 1 }, async texteNatif() { throw new Error('pdftotext absent') }, async ocrPage() { return '' }, async imagePage() { return Buffer.alloc(0) } }, 'x.pdf', 1)
    expect(p.source).toBe('erreur'); expect(p.erreur).toMatch(/pdftotext/)
  })
})
describe('qualité', () => {
  const page = (o: Partial<PageTexte>): PageTexte => ({ ...base(), ...o }); const base = (): PageTexte => ({ n: 1, source: 'ocr', texte: long('mot'), nbDates: 0, nbEspeces: 0 })
  it('OCR avec dates sans espèce = douteux ; natif jamais douteux', () => {
    expect(qualitePage(page({ nbDates: 5, nbEspeces: 0 }))).toBe('douteux')
    expect(qualitePage(page({ nbDates: 5, nbEspeces: 3 }))).toBe('ok')
    expect(qualitePage(page({ source: 'native', nbDates: 5, nbEspeces: 0 }))).toBe('ok')
  })
  it('document : native / ocr_ok / ocr_douteux', () => {
    expect(qualiteDocument([page({ source: 'native' })])).toBe('native')
    expect(qualiteDocument([page({ nbDates: 2, nbEspeces: 1 })])).toBe('ocr_ok')
    expect(qualiteDocument([page({ nbDates: 2, nbEspeces: 0 })])).toBe('ocr_douteux')
  })
  it('agrégé : page en erreur, document vide, majorité de pages douteuses', () => {
    expect(qualitePage(page({ source: 'erreur', texte: '' }))).toBe('douteux')
    expect(qualiteDocument([])).toBe('ocr_douteux')
    expect(qualiteDocument([page({ nbDates: 2, nbEspeces: 1 }), page({ source: 'erreur', texte: '' })])).toBe('ocr_douteux')
    const bruit = page({ texte: long('mot') + ' ' + long('autre'), nbDates: 0, nbEspeces: 0 })
    expect(qualiteDocument([bruit, bruit, page({ nbDates: 2, nbEspeces: 1 })])).toBe('ocr_douteux')
    expect(qualiteDocument([bruit, page({ nbDates: 2, nbEspeces: 1 }), page({ nbDates: 1, nbEspeces: 2 })])).toBe('ocr_ok')
    // Tableau OCR : des pages sans espèce à côté de pages qui en ont → document ok.
    expect(qualiteDocument([page({ nbDates: 5, nbEspeces: 0 }), page({ nbDates: 1, nbEspeces: 3 }), page({ nbDates: 2, nbEspeces: 2 })])).toBe('ocr_ok')
  })
  it('textes réels 54 et 69 : ocr_ok', () => {
    for (const f of ['54-ap', '69-fdc']) {
      const j = JSON.parse(readFileSync(new URL(`./__fixtures__/${f}.texte.json`, import.meta.url), 'utf8'))
      const pages: PageTexte[] = j.pages.map((p: { n: number; texte: string }) => ({ n: p.n, source: 'ocr', texte: p.texte, nbDates: compterDates(p.texte), nbEspeces: compterEspeces(p.texte) }))
      expect(qualiteDocument(pages)).toBe('ocr_ok')
    }
  })
})
describe('run', () => {
  it('délai dépassé : processus tué, rejet explicite', async () => {
    await expect(run('node', ['-e', 'setTimeout(() => {}, 10000)'], 300)).rejects.toThrow(/node : délai dépassé/)
  })
  it('sortie UTF-8 volumineuse non corrompue', async () => {
    const out = await run('node', ['-e', "process.stdout.write('é'.repeat(200000))"])
    expect(out).toBe('é'.repeat(200000))
  })
  it('code de sortie non nul : rejet avec le message', async () => {
    await expect(run('node', ['-e', "console.error('boum'); process.exit(3)"])).rejects.toThrow(/\(3\) : boum/)
  })
})
describe('argsImagePage', () => {
  // Pas de rendu réel en test : seuls les arguments passés à pdftoppm sont vérifiés.
  it('une seule page, 110 dpi, PNG, fichier unique', () => {
    expect(argsImagePage('/tmp/a.pdf', 7, '/tmp/d/p')).toEqual(['-r', '110', '-png', '-f', '7', '-l', '7', '-singlefile', '/tmp/a.pdf', '/tmp/d/p'])
  })
})
