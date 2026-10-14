import { describe, it, expect } from 'vitest'
import { lireMecaniquement } from './lecture.ts'
import { creerDepotMemoire } from './db.ts'
import { creerArchiveMemoire } from './r2.ts'
import type { OutilsPdf } from './pdf.ts'

const NOMS = { '54': 'Meurthe-et-Moselle', '50': 'Manche', '36': 'Indre' }
const fichierTemp = async (o: Buffer) => ({ chemin: `/tmp/fake-${o.length}`, liberer: () => {} })
function outilsFactices(pages: string[], natif = true): OutilsPdf & { ocr: number[] } {
  const ocr: number[] = []
  return { ocr, async nbPages() { return pages.length }, async texteNatif(_, n) { return natif ? pages[n - 1] : '' }, async ocrPage(_, n) { ocr.push(n); return pages[n - 1] } }
}
async function docTest(texte: string[], natif = true, dept = '54') {
  const depot = creerDepotMemoire(); const archive = creerArchiveMemoire()
  const sha = 'c'.repeat(64); const r2_key = `arretes/2026-2027/${dept}/${sha}.pdf`
  archive.objets.set(r2_key, Buffer.from('%PDF-'))
  await depot.creerDocument({ departement: dept, saison: '2026-2027', source_id: null, url: 'https://x/a.pdf', titre: 'AP ouverture 2026-2027', sha256: sha, r2_key, taille_octets: 5 })
  const outils = outilsFactices(texte, natif)
  const stats = await lireMecaniquement({ depot, archive, outils, noms: NOMS, fichierTemp })
  return { depot, archive, outils, stats, doc: depot.etat.documents[0] as any }
}
const long = (s: string) => Array(40).fill(s).join(' ')

describe('lireMecaniquement', () => {
  it('arrêté isolé natif : toutes les pages, a_lire, métadonnées, texte archivé', async () => {
    const { doc, stats, archive } = await docTest([`PRÉFET DE MEURTHE-ET-MOSELLE\nARRÊTÉ N° 2026/DDT/12\nouverture et clôture de la chasse campagne 2026-2027\n${long('vu')}`, `Article 1 : sanglier, chevreuil, dates fixées à l annexe ${long('xx')}`, `Fait à Nancy, le 12 mai 2026\nLe Préfet ${long('yy')}`])
    expect(stats).toMatchObject({ traites: 1, aLire: 1, ignores: 0, erreurs: 0, pagesOcr: 0 })
    expect(doc.statut_traitement).toBe('a_lire'); expect(doc.type_detecte).toBe('annuel'); expect(doc.qualite_texte).toBe('native')
    expect(doc.numero_acte).toBe('2026/DDT/12'); expect(doc.date_acte).toBe('2026-05-12'); expect(doc.pages_retenues).toEqual([1, 2, 3])
    expect(doc.texte_r2_key).toBe(`arretes/2026-2027/54/${'c'.repeat(64)}.texte.json`)
    const t = JSON.parse(archive.objets.get(doc.texte_r2_key)!.toString()); expect(t.pages).toHaveLength(3)
  })
  it('arrêté scanné : OCR de chaque page, ocr_ok si espèces repérées', async () => {
    const { doc, stats, outils } = await docTest([`PRÉFET DE MEURTHE-ET-MOSELLE\nARRÊTÉ N° 1 ouverture et clôture de la chasse 2026-2027 ${long('vu')}`, `sanglier chevreuil du 01/06/2026 au 28/02/2027 ${long('x')}`], false)
    expect(outils.ocr).toEqual([1, 2]); expect(stats.pagesOcr).toBe(2); expect(doc.qualite_texte).toBe('ocr_ok')
  })
  it('hors sujet → ignore ; mauvais département → ignore avec motif', async () => {
    const a = await docTest([`PRÉFET DE MEURTHE-ET-MOSELLE\nArrêté portant réglementation de la pêche ${long('vu')}`])
    expect(a.doc.statut_traitement).toBe('ignore'); expect(a.stats.ignores).toBe(1)
    const b = await docTest([`PRÉFET DE L'INDRE\nArrêté ouverture et clôture de la chasse 2026-2027 ${long('vu')}`])
    expect(b.doc.statut_traitement).toBe('ignore'); expect(b.doc.erreur).toMatch(/département/)
  })
  it('recueil avec sommaire : seules les pages des actes chasse sont lues', async () => {
    const pages = Array.from({ length: 40 }, (_, i) => `page ${i + 1} ${long('texte')}`)
    pages[0] = `RECUEIL DES ACTES ADMINISTRATIFS 50-2026-160\nSOMMAIRE\nArrêté portant ouverture et clôture de la chasse 2026-2027 ........ 10\nArrêté portant réglementation de la pêche ........ 20\nArrêté portant médaille ........ 30\n${long('s')}`
    for (let n = 10; n <= 19; n++) pages[n - 1] = `PRÉFET DE LA MANCHE\nArrêté portant ouverture et clôture de la chasse 2026-2027\nsanglier du 1er juin 2026 ${long('a')}`
    const { doc, outils } = await docTest(pages, false, '50')
    expect(outils.ocr).toEqual([1, 2, 3, 4, 5, 6, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19])
    expect(doc.pages_retenues).toEqual([10, 11, 12, 13, 14, 15, 16, 17, 18, 19]); expect(doc.type_detecte).toBe('annuel'); expect(doc.statut_traitement).toBe('a_lire')
  })
  it('exception outil → erreur, le suivant continue', async () => {
    const depot = creerDepotMemoire(); const archive = creerArchiveMemoire()
    for (const s of ['d', 'e']) { const k = `arretes/2026-2027/54/${s.repeat(64)}.pdf`; archive.objets.set(k, Buffer.from('%PDF-')); await depot.creerDocument({ departement: '54', saison: '2026-2027', source_id: null, url: `https://x/${s}.pdf`, titre: 'AP', sha256: s.repeat(64), r2_key: k, taille_octets: 5 }) }
    let n = 0
    const outils: OutilsPdf = { async nbPages() { if (++n === 1) throw new Error('pdfinfo cassé'); return 1 }, async texteNatif() { return `PRÉFET DE MEURTHE-ET-MOSELLE arrêté ouverture clôture chasse 2026-2027 ${long('vv')}` }, async ocrPage() { return '' } }
    const stats = await lireMecaniquement({ depot, archive, outils, noms: NOMS, fichierTemp })
    expect(stats.erreurs).toBe(1); expect(stats.aLire).toBe(1); expect((depot.etat.documents[0] as any).erreur).toMatch(/pdfinfo/)
  })
})
