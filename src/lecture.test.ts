import { describe, it, expect } from 'vitest'
import { lireMecaniquement } from './lecture.ts'
import { creerDepotMemoire } from './db.ts'
import { creerArchiveMemoire, cleImagePage } from './r2.ts'
import type { OutilsPdf } from './pdf.ts'

const NOMS = { '54': 'Meurthe-et-Moselle', '50': 'Manche', '36': 'Indre' }
const fichierTemp = async (o: Buffer) => ({ chemin: `/tmp/fake-${o.length}`, liberer: () => {} })
function outilsFactices(pages: string[], natif = true): OutilsPdf & { ocr: number[] } {
  const ocr: number[] = []
  return { ocr, async nbPages() { return pages.length }, async texteNatif(_, n) { return natif ? pages[n - 1] : '' }, async ocrPage(_, n) { ocr.push(n); return pages[n - 1] }, async imagePage() { return Buffer.alloc(0) } }
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
    const outils: OutilsPdf = { async nbPages() { if (++n === 1) throw new Error('pdfinfo cassé'); return 1 }, async texteNatif() { return `PRÉFET DE MEURTHE-ET-MOSELLE arrêté ouverture clôture chasse 2026-2027 ${long('vv')}` }, async ocrPage() { return '' }, async imagePage() { return Buffer.alloc(0) } }
    const stats = await lireMecaniquement({ depot, archive, outils, noms: NOMS, fichierTemp })
    expect(stats.erreurs).toBe(1); expect(stats.aLire).toBe(1); expect((depot.etat.documents[0] as any).erreur).toMatch(/pdfinfo/)
  })
  it('panne d’outil (toutes les pages en erreur) → erreur rejouable, pas ignore', async () => {
    const depot = creerDepotMemoire(); const archive = creerArchiveMemoire()
    const k = `arretes/2026-2027/54/${'f'.repeat(64)}.pdf`; archive.objets.set(k, Buffer.from('%PDF-'))
    await depot.creerDocument({ departement: '54', saison: '2026-2027', source_id: null, url: 'https://x/f.pdf', titre: 'AP', sha256: 'f'.repeat(64), r2_key: k, taille_octets: 5 })
    const outils: OutilsPdf = { async nbPages() { return 3 }, async texteNatif() { throw new Error('pdftotext introuvable') }, async ocrPage() { throw new Error('tesseract introuvable') }, async imagePage() { return Buffer.alloc(0) } }
    const stats = await lireMecaniquement({ depot, archive, outils, noms: NOMS, fichierTemp })
    const doc = depot.etat.documents[0] as any
    expect(stats.erreurs).toBe(1); expect(doc.statut_traitement).toBe('erreur'); expect(doc.erreur).toMatch(/lecture impossible.*(tesseract|pdftotext)/)
  })
  it('1200 pages sans sommaire → document trop long, aucun OCR', async () => {
    const { doc, stats, outils } = await docTest(Array.from({ length: 1200 }, (_, i) => `page ${i + 1} ${long('texte')}`))
    expect(stats.erreurs).toBe(1); expect(doc.statut_traitement).toBe('erreur'); expect(doc.erreur).toMatch(/document trop long : 1200 pages/); expect(outils.ocr).toEqual([])
  })
  it('sommaire : acte à titre nu retenu si sa 1re page parle de chasse ; actes écartés journalisés', async () => {
    const pages = Array.from({ length: 40 }, (_, i) => `page ${i + 1} ${long('texte')}`)
    pages[0] = `RECUEIL DES ACTES ADMINISTRATIFS 50-2026-160\nSOMMAIRE\nArrêté DDT-SEN-2026-45 ........ 10\nArrêté portant réglementation de la pêche ........ 20\nArrêté portant médaille ........ 30\n${long('s')}`
    for (let n = 10; n <= 19; n++) pages[n - 1] = `PRÉFET DE LA MANCHE\nArrêté DDT-SEN-2026-45 ouverture et clôture de la chasse 2026-2027\nsanglier ${long('a')}`
    const journal: string[] = []
    const depot = creerDepotMemoire(); const archive = creerArchiveMemoire()
    const sha = 'a'.repeat(64); const r2_key = `arretes/2026-2027/50/${sha}.pdf`; archive.objets.set(r2_key, Buffer.from('%PDF-'))
    await depot.creerDocument({ departement: '50', saison: '2026-2027', source_id: null, url: 'https://x/a.pdf', titre: 'RAA', sha256: sha, r2_key, taille_octets: 5 })
    const stats = await lireMecaniquement({ depot, archive, outils: outilsFactices(pages, false), noms: NOMS, fichierTemp, log: l => journal.push(l) })
    const doc = depot.etat.documents[0] as any
    expect(stats.aLire).toBe(1); expect(doc.pages_retenues).toEqual([10, 11, 12, 13, 14, 15, 16, 17, 18, 19])
    expect(journal.join('\n')).toMatch(/actes écartés.*pêche.*médaille/)
  })
  it('recueil sans aucun acte de chasse → ignore avec motif dédié', async () => {
    const pages = Array.from({ length: 40 }, (_, i) => `page ${i + 1} ${long('texte')}`)
    pages[0] = `RECUEIL DES ACTES ADMINISTRATIFS 50-2026-160\nSOMMAIRE\nArrêté portant réglementation de la pêche ........ 10\nArrêté portant médaille ........ 20\nArrêté portant nomination ........ 30\n${long('s')}`
    const { doc, stats } = await docTest(pages, true, '50')
    expect(stats.ignores).toBe(1); expect(doc.statut_traitement).toBe('ignore'); expect(doc.erreur).toMatch(/recueil : aucun acte de chasse repéré \(3 actes au sommaire\)/)
  })
  it('échec de marquerErreur : la boucle continue et l’erreur est comptée', async () => {
    const depot = creerDepotMemoire(); const archive = creerArchiveMemoire()
    for (const c of ['1', '2']) { const k = `arretes/2026-2027/54/${c.repeat(64)}.pdf`; archive.objets.set(k, Buffer.from('%PDF-')); await depot.creerDocument({ departement: '54', saison: '2026-2027', source_id: null, url: `https://x/${c}.pdf`, titre: 'AP', sha256: c.repeat(64), r2_key: k, taille_octets: 5 }) }
    depot.marquerErreur = async () => { throw new Error('base injoignable') }
    const outils: OutilsPdf = { async nbPages() { throw new Error('pdfinfo cassé') }, async texteNatif() { return '' }, async ocrPage() { return '' }, async imagePage() { return Buffer.alloc(0) } }
    const journal: string[] = []
    const stats = await lireMecaniquement({ depot, archive, outils, noms: NOMS, fichierTemp, log: l => journal.push(l) })
    expect(stats).toMatchObject({ traites: 2, erreurs: 2 }); expect(journal.join('\n')).toMatch(/base injoignable/)
  })
  it('échéance déjà passée : aucun document commencé, arrêt précoce', async () => {
    const depot = creerDepotMemoire(); const archive = creerArchiveMemoire()
    const k = `arretes/2026-2027/54/${'9'.repeat(64)}.pdf`; archive.objets.set(k, Buffer.from('%PDF-'))
    await depot.creerDocument({ departement: '54', saison: '2026-2027', source_id: null, url: 'https://x/9.pdf', titre: 'AP', sha256: '9'.repeat(64), r2_key: k, taille_octets: 5 })
    const outils = outilsFactices(['x'])
    const stats = await lireMecaniquement({ depot, archive, outils, noms: NOMS, fichierTemp, now: () => new Date('2026-09-14T10:00:00Z') }, { echeance: new Date('2026-09-14T09:00:00Z') })
    expect(stats).toMatchObject({ traites: 0, arretPrecoce: true }); expect((depot.etat.documents[0] as any).statut_traitement).toBe('a_extraire')
  })
  it('échéance proche : document de 3 pages (24 s estimées, 10 s restantes) non commencé, reste a_extraire', async () => {
    const depot = creerDepotMemoire(); const archive = creerArchiveMemoire()
    const k = `arretes/2026-2027/54/${'8'.repeat(64)}.pdf`; archive.objets.set(k, Buffer.from('%PDF-'))
    await depot.creerDocument({ departement: '54', saison: '2026-2027', source_id: null, url: 'https://x/8.pdf', titre: 'AP', sha256: '8'.repeat(64), r2_key: k, taille_octets: 5 })
    const outils = outilsFactices([`PRÉFET DE MEURTHE-ET-MOSELLE arrêté ouverture clôture chasse 2026-2027 ${long('v')}`, 'b', 'c'], false)
    const stats = await lireMecaniquement({ depot, archive, outils, noms: NOMS, fichierTemp, now: () => new Date('2026-09-14T10:00:00Z') }, { echeance: new Date('2026-09-14T10:00:10Z') })
    expect(stats).toMatchObject({ traites: 0, aLire: 0, erreurs: 0, arretPrecoce: true }); expect(outils.ocr).toEqual([])
    expect((depot.etat.documents[0] as any).statut_traitement).toBe('a_extraire')
  })
  it('échéance large : lecture normale, arretPrecoce faux', async () => {
    const { stats } = await docTest([`PRÉFET DE MEURTHE-ET-MOSELLE\nARRÊTÉ N° 1 ouverture et clôture de la chasse 2026-2027 ${long('vu')}`])
    expect(stats.arretPrecoce).toBe(false)
  })
  describe('images des pages scannées', () => {
    const SHA = 'c'.repeat(64)
    const cle = (n: number) => cleImagePage('2026-2027', '54', SHA, n)
    const ENTETE = `PRÉFET DE MEURTHE-ET-MOSELLE\nARRÊTÉ N° 1 ouverture et clôture de la chasse 2026-2027 ${long('vu')}`
    // Page 1 native ; page 2 scannée (OCR) ; page 3 : natif vide et OCR en échec (source erreur).
    const outilsScan = (imagePage: OutilsPdf['imagePage']): OutilsPdf => ({
      async nbPages() { return 3 }, async texteNatif(_, n) { return n === 1 ? ENTETE : '' },
      async ocrPage(_, n) { if (n === 3) throw new Error('tesseract cassé'); return `sanglier chevreuil du 01/06/2026 au 28/02/2027 ${long('x')}` }, imagePage,
    })
    async function lireScan(imagePage: OutilsPdf['imagePage']) {
      const depot = creerDepotMemoire(); const archive = creerArchiveMemoire(); const journal: string[] = []
      const r2_key = `arretes/2026-2027/54/${SHA}.pdf`; archive.objets.set(r2_key, Buffer.from('%PDF-'))
      await depot.creerDocument({ departement: '54', saison: '2026-2027', source_id: null, url: 'https://x/a.pdf', titre: 'AP ouverture 2026-2027', sha256: SHA, r2_key, taille_octets: 5 })
      const stats = await lireMecaniquement({ depot, archive, outils: outilsScan(imagePage), noms: NOMS, fichierTemp, log: l => journal.push(l) })
      return { archive, journal, stats, doc: depot.etat.documents[0] as any }
    }
    it('pages ocr et erreur déposées en PNG à côté du texte ; page native jamais', async () => {
      const { archive, doc, stats } = await lireScan(async (_, n) => Buffer.from(`png${n}`))
      expect(stats).toMatchObject({ aLire: 1, erreurs: 0 }); expect(doc.statut_traitement).toBe('a_lire')
      expect(archive.objets.get(cle(2))).toEqual(Buffer.from('png2')); expect(archive.objets.get(cle(3))).toEqual(Buffer.from('png3'))
      expect(archive.objets.has(cle(1))).toBe(false)
    })
    it('échec de rendu : journalisé, jamais bloquant (texte déposé, document a_lire)', async () => {
      const { archive, doc, journal, stats } = await lireScan(async (_, n) => { if (n === 2) throw new Error('pdftoppm cassé'); return Buffer.from(`png${n}`) })
      expect(stats).toMatchObject({ aLire: 1, erreurs: 0 }); expect(doc.statut_traitement).toBe('a_lire')
      expect(archive.objets.has(doc.texte_r2_key)).toBe(true)
      expect(archive.objets.has(cle(2))).toBe(false); expect(archive.objets.has(cle(3))).toBe(true)
      expect(journal.join('\n')).toMatch(/54 image page 2 impossible : pdftoppm cassé/)
    })
  })
})
