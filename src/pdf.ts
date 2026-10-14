// Lecture d'un PDF page par page : couche texte (pdftotext -layout) sinon OCR (pdftoppm 300 dpi + tesseract fra).
import { spawn } from 'node:child_process'
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { compterDates, compterEspeces } from './lexique.ts'
import type { PageTexte, QualiteTexte } from './types.ts'

export interface OutilsPdf { nbPages(pdf: string): Promise<number>; texteNatif(pdf: string, page: number): Promise<string>; ocrPage(pdf: string, page: number): Promise<string> }

export const DELAI_COMMANDE_MS = 120_000

// Lance une commande ; sortie lue en UTF-8 (pas de caractère accentué coupé entre deux paquets) ; tuée si elle dépasse `delaiMs`.
export function run(cmd: string, args: string[], delaiMs = DELAI_COMMANDE_MS): Promise<string> {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args); let out = ''; let err = ''; let fini = false
    p.stdout.setEncoding('utf8'); p.stderr.setEncoding('utf8')
    p.stdout.on('data', d => { out += d }); p.stderr.on('data', d => { err += d })
    const terminer = (f: () => void) => { if (fini) return; fini = true; clearTimeout(minuteur); f() }
    const minuteur = setTimeout(() => terminer(() => { p.kill('SIGKILL'); reject(new Error(`${cmd} : délai dépassé`)) }), delaiMs)
    p.on('error', e => terminer(() => reject(e)))
    p.on('close', code => terminer(() => code === 0 ? resolve(out) : reject(new Error(`${cmd} (${code}) : ${err.trim().split('\n')[0]}`))))
  })
}

export const creerOutilsPoppler = (delaiMs = DELAI_COMMANDE_MS): OutilsPdf => ({
  async nbPages(pdf) { const m = /Pages:\s+(\d+)/.exec(await run('pdfinfo', [pdf], delaiMs)); if (!m) throw new Error('pdfinfo : nombre de pages introuvable'); return +m[1] },
  async texteNatif(pdf, n) { return run('pdftotext', ['-f', String(n), '-l', String(n), '-layout', pdf, '-'], delaiMs) },
  async ocrPage(pdf, n) {
    const tmp = mkdtempSync(join(tmpdir(), 'veille-ocr-'))
    try {
      await run('pdftoppm', ['-f', String(n), '-l', String(n), '-r', '300', '-gray', '-png', pdf, join(tmp, 'p')], delaiMs)
      const png = readdirSync(tmp).find(f => f.endsWith('.png')); if (!png) throw new Error('pdftoppm : aucune image produite')
      return await run('tesseract', [join(tmp, png), '-', '-l', 'fra', '--psm', '6'], delaiMs)
    } finally { rmSync(tmp, { recursive: true, force: true }) }
  },
})
export const outilsPoppler: OutilsPdf = creerOutilsPoppler()

const nbMots = (t: string) => (t.match(/[\p{L}']{2,}/gu) ?? []).length

export async function lirePage(outils: OutilsPdf, pdf: string, n: number): Promise<PageTexte> {
  try {
    let texte = await outils.texteNatif(pdf, n); let source: PageTexte['source'] = 'native'
    if (nbMots(texte) < 30) { texte = await outils.ocrPage(pdf, n); source = 'ocr' }
    return { n, source, texte, nbDates: compterDates(texte), nbEspeces: compterEspeces(texte) }
  } catch (e) { return { n, source: 'erreur', texte: '', nbDates: 0, nbEspeces: 0, erreur: (e as Error).message } }
}

export function qualitePage(p: PageTexte): 'ok' | 'douteux' {
  if (p.source === 'erreur') return 'douteux'
  if (p.source !== 'ocr') return 'ok'
  if (p.nbDates > 0 && p.nbEspeces === 0) return 'douteux'
  if (p.nbDates === 0 && p.nbEspeces === 0 && nbMots(p.texte) > 50) return 'douteux'
  return 'ok'
}
// Qualité agrégée du document : des dates sans aucune espèce sur l'ensemble, une page en erreur, ou plus de la moitié de pages douteuses → douteux.
export function qualiteDocument(pages: PageTexte[]): QualiteTexte {
  if (!pages.length) return 'ocr_douteux'
  if (pages.every(p => p.source === 'native')) return 'native'
  const somme = (cle: 'nbDates' | 'nbEspeces') => pages.reduce((t, p) => t + p[cle], 0)
  const erreurs = pages.filter(p => p.source === 'erreur').length
  const douteuses = pages.filter(p => qualitePage(p) === 'douteux').length
  if ((somme('nbDates') > 0 && somme('nbEspeces') === 0) || erreurs > 0 || douteuses > pages.length / 2) return 'ocr_douteux'
  return 'ocr_ok'
}
