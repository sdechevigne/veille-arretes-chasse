import { describe, it, expect } from 'vitest'
import { lirePage, qualitePage, qualiteDocument } from './pdf.ts'
import type { OutilsPdf } from './pdf.ts'
import type { PageTexte } from './types.ts'

const outils = (natif: string, ocr: string): OutilsPdf => ({ async nbPages() { return 1 }, async texteNatif() { return natif }, async ocrPage() { return ocr } })
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
    const p = await lirePage({ async nbPages() { return 1 }, async texteNatif() { throw new Error('pdftotext absent') }, async ocrPage() { return '' } }, 'x.pdf', 1)
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
})
