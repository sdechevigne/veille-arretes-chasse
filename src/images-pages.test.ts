import { describe, it, expect } from 'vitest'
import { produireImagesPages } from './images-pages.ts'
import { creerDepotMemoire } from './db.ts'
import { creerArchiveMemoire, cleArchive, cleImagePage } from './r2.ts'
import type { OutilsPdf } from './pdf.ts'

const page = (n: number, source: 'native' | 'ocr' | 'erreur') => ({ n, source, texte: 'x', nbDates: 0, nbEspeces: 0 })
const SAISON = '2026-2027'
const NOW = new Date('2026-10-19T10:00:00Z')

async function monter(nb: number, pages = [page(1, 'ocr'), page(2, 'native')]) {
  const depot = creerDepotMemoire(); const archive = creerArchiveMemoire()
  const shas: string[] = []
  for (let i = 0; i < nb; i++) {
    const sha = String.fromCharCode(97 + i).repeat(64); shas.push(sha)
    const r2_key = cleArchive(SAISON, '54', sha, 'pdf'); archive.objets.set(r2_key, Buffer.from(`%PDF-${i}`))
    const id = await depot.creerDocument({ departement: '54', saison: SAISON, source_id: null, url: `https://x/${i}.pdf`, titre: 'AP', sha256: sha, r2_key, taille_octets: 5 })
    const texte_r2_key = cleArchive(SAISON, '54', sha, 'texte.json'); archive.objets.set(texte_r2_key, Buffer.from(JSON.stringify({ sha256: sha, pages })))
    await depot.majLecture(id, { type_detecte: 'annuel', numero_acte: null, date_acte: null, objet: null, qualite_texte: 'ocr_ok', pages_retenues: pages.map(p => p.n), statut: 'a_lire', texte_r2_key })
    Object.assign(depot.etat.documents.find(d => d.id === id)!, { decouvert_le: `2026-10-0${i + 1}T00:00:00Z` })
  }
  const rendues: number[] = []; const liberes: string[] = []; const journal: string[] = []
  const outils: OutilsPdf = { async nbPages() { return 2 }, async texteNatif() { return '' }, async ocrPage() { return '' }, async imagePage(_pdf, n) { rendues.push(n); return Buffer.from(`png${n}`) } }
  const fichierTemp = async (o: Buffer) => ({ chemin: `/tmp/fake-${o.toString()}`, liberer: () => { liberes.push(o.toString()) } })
  const lancer = (opts: { limite?: number; echeance?: Date } = {}, o = outils) => produireImagesPages({ depot, archive, outils: o, fichierTemp, now: () => NOW, log: l => journal.push(l) }, { limite: 10, ...opts })
  return { depot, archive, shas, rendues, liberes, journal, lancer, outils }
}

describe('produireImagesPages', () => {
  it('rend seulement l’image manquante des pages scannées, une fois le PDF téléchargé par document', async () => {
    const m = await monter(2)
    m.archive.objets.set(cleImagePage(SAISON, '54', m.shas[0], 1), Buffer.from('deja'))
    const stats = await m.lancer()
    expect(stats).toEqual({ documents: 1, images: 1, erreurs: 0, sortis: 0 })
    expect(m.rendues).toEqual([1])
    expect(m.archive.objets.get(cleImagePage(SAISON, '54', m.shas[1], 1))).toEqual(Buffer.from('png1'))
    expect(m.archive.objets.get(cleImagePage(SAISON, '54', m.shas[0], 1))).toEqual(Buffer.from('deja'))
    expect(m.archive.objets.has(cleImagePage(SAISON, '54', m.shas[1], 2))).toBe(false)
    expect(m.liberes).toEqual(['%PDF-1'])
    // Rejeu : plus rien à produire.
    expect(await m.lancer()).toEqual({ documents: 0, images: 0, erreurs: 0, sortis: 0 })
    expect(m.rendues).toEqual([1])
  })

  it('pages ocr et erreur rendues, native jamais ; seuls les documents a_lire sont visés', async () => {
    const m = await monter(2, [page(1, 'native'), page(2, 'erreur'), page(3, 'ocr')])
    m.depot.etat.documents[1].statut_traitement = 'publie'
    expect(await m.lancer()).toEqual({ documents: 1, images: 2, erreurs: 0, sortis: 0 })
    expect(m.rendues).toEqual([2, 3])
  })

  it('--limite : compte les documents traités, pas ceux déjà complets', async () => {
    const m = await monter(3)
    m.archive.objets.set(cleImagePage(SAISON, '54', m.shas[0], 1), Buffer.from('deja'))
    expect(await m.lancer({ limite: 1 })).toEqual({ documents: 1, images: 1, erreurs: 0, sortis: 0 })
    expect(m.archive.objets.has(cleImagePage(SAISON, '54', m.shas[1], 1))).toBe(true)
    expect(m.archive.objets.has(cleImagePage(SAISON, '54', m.shas[2], 1))).toBe(false)
  })

  // Échec de rendu (pdftoppm, page hors du PDF, PDF corrompu) : déterministe, l'image ne sera jamais produite → le document
  // sort de la file (en_attente, à traiter à la main) au lieu de rester a_lire indéfiniment ; le suivant continue.
  it('rendu impossible : document en_attente avec le motif, compté sortis, jamais repris ; le suivant continue', async () => {
    const m = await monter(2)
    const casse = { ...m.outils, async imagePage(pdf: string, n: number) { if (pdf.endsWith('%PDF-0')) throw new Error('pdftoppm : code 1\nSyntax Error: Couldn\'t read xref table'); return Buffer.from(`png${n}`) } }
    const stats = await m.lancer({}, casse)
    expect(stats).toEqual({ documents: 2, images: 1, erreurs: 0, sortis: 1 })
    expect(m.depot.etat.documents[0]).toMatchObject({ statut_traitement: 'en_attente', erreur: 'image de la page 1 impossible à produire : pdftoppm : code 1' })
    expect(m.depot.etat.documents[1].statut_traitement).toBe('a_lire')
    expect(m.journal.join('\n')).toMatch(/54.*image de la page 1 impossible à produire/)
    expect(m.liberes).toEqual(['%PDF-0', '%PDF-1'])
    expect(await m.lancer({}, casse)).toEqual({ documents: 0, images: 0, erreurs: 0, sortis: 0 })
  })

  it('rendu coupé par le délai (machine chargée) : passager, erreur comptée, document repris', async () => {
    const m = await monter(1)
    const lent = { ...m.outils, async imagePage(): Promise<Buffer> { throw new Error('pdftoppm : délai dépassé') } }
    expect(await m.lancer({}, lent)).toEqual({ documents: 1, images: 0, erreurs: 1, sortis: 0 })
    expect(m.depot.etat.documents[0].statut_traitement).toBe('a_lire')
  })

  it('dépôt R2 en échec : passager, erreur comptée, document toujours a_lire et repris le lendemain', async () => {
    const m = await monter(1)
    const deposer = m.archive.deposer.bind(m.archive)
    m.archive.deposer = async () => { throw new Error('R2 : 503') }
    expect(await m.lancer()).toEqual({ documents: 1, images: 0, erreurs: 1, sortis: 0 })
    expect(m.depot.etat.documents[0]).toMatchObject({ statut_traitement: 'a_lire', erreur: null })
    m.archive.deposer = deposer
    expect(await m.lancer()).toEqual({ documents: 1, images: 1, erreurs: 0, sortis: 0 })
  })

  it('PDF absent de l’archive : erreur comptée sans exception', async () => {
    const m = await monter(1)
    m.archive.objets.delete(cleArchive(SAISON, '54', m.shas[0], 'pdf'))
    expect(await m.lancer()).toEqual({ documents: 1, images: 0, erreurs: 1, sortis: 0 })
  })

  it('échéance dépassée : aucun document commencé', async () => {
    const m = await monter(1)
    expect(await m.lancer({ echeance: new Date('2026-10-19T09:00:00Z') })).toEqual({ documents: 0, images: 0, erreurs: 0, sortis: 0 })
    expect(m.rendues).toEqual([])
  })
})
