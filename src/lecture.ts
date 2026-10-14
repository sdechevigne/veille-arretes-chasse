// Étage 2 : lecture mécanique des documents a_extraire (texte, OCR ciblé, découpage, classement, garde).
import { cleArchive, type Archive } from './r2.ts'
import type { Depot } from './db.ts'
import { lirePage, qualiteDocument, type OutilsPdf } from './pdf.ts'
import { lireSommaire, decouperParEntetes, actesChasse, pagesAOcr, type Acte } from './recueil.ts'
import { classer, extraireMetadonnees, garde } from './classement.ts'
import type { PageTexte } from './types.ts'

export interface DepsLecture { depot: Depot; archive: Archive; outils: OutilsPdf; noms: Record<string, string>; fichierTemp: (octets: Buffer) => Promise<{ chemin: string; liberer: () => void }>; log?: (l: string) => void }
export interface OptionsLecture { limite?: number; pagesMaxParDocument?: number }
export interface StatsLecture { traites: number; aLire: number; ignores: number; erreurs: number; pagesOcr: number }
const SEUIL_RECUEIL = 30

export async function lireMecaniquement(deps: DepsLecture, o: OptionsLecture = {}): Promise<StatsLecture> {
  const log = deps.log ?? (() => {}); const stats: StatsLecture = { traites: 0, aLire: 0, ignores: 0, erreurs: 0, pagesOcr: 0 }
  const docs = await deps.depot.documentsParStatut('a_extraire', o.limite ?? 50)
  for (const doc of docs) {
    stats.traites++
    let temp: { chemin: string; liberer: () => void } | null = null
    try {
      temp = await deps.fichierTemp(await deps.archive.lire(doc.r2_key))
      const chemin = temp.chemin
      const nbPages = await deps.outils.nbPages(chemin)
      const lues = new Map<number, PageTexte>()
      const lire = async (n: number) => { if (!lues.has(n)) { const p = await lirePage(deps.outils, chemin, n); if (p.source === 'ocr') stats.pagesOcr++; lues.set(n, p) } return lues.get(n)! }
      let actes: Acte[] | undefined; let retenues: number[]

      if (nbPages <= SEUIL_RECUEIL) {
        for (let n = 1; n <= nbPages; n++) await lire(n)
        retenues = [...lues.keys()]
      } else {
        for (let n = 1; n <= Math.min(6, nbPages); n++) await lire(n)
        const sommaire = lireSommaire([...lues.values()], nbPages)
        if (sommaire) {
          actes = actesChasse(sommaire, [])
          retenues = pagesAOcr(actes, nbPages)
        } else {
          for (const n of pagesAOcr(null, nbPages)) await lire(n)
          const pagesEchantillon = [...lues.values()].sort((a, b) => a.n - b.n)
          actes = actesChasse(decouperParEntetes(pagesEchantillon), pagesEchantillon)
          retenues = actes.filter(a => a.chasse).flatMap(a => Array.from({ length: a.pageFin - a.pageDebut + 1 }, (_, i) => a.pageDebut + i))
        }
        if (retenues.length > (o.pagesMaxParDocument ?? 400)) throw new Error(`document trop long : ${retenues.length} pages à lire`)
        for (const n of retenues) await lire(n)
      }

      const pagesRetenues = retenues.map(n => lues.get(n)!).filter(Boolean).sort((a, b) => a.n - b.n)
      const texte = pagesRetenues.map(p => p.texte).join('\n')
      const titre = doc.titre ?? ''
      const g = garde({ departementSource: doc.departement, saisonAttendue: doc.saison }, texte, deps.noms)
      if ('motif' in g) { await deps.depot.majLecture(doc.id, { type_detecte: 'indetermine', numero_acte: null, date_acte: null, objet: null, qualite_texte: qualiteDocument(pagesRetenues), pages_retenues: retenues, statut: 'ignore', motif_ignore: g.motif, texte_r2_key: null }); stats.ignores++; log(`${doc.departement} ignoré : ${g.motif}`); continue }
      const type = classer(titre, texte)
      if (type === 'hors_sujet' || !retenues.length) { await deps.depot.majLecture(doc.id, { type_detecte: 'hors_sujet', numero_acte: null, date_acte: null, objet: null, qualite_texte: qualiteDocument(pagesRetenues), pages_retenues: retenues, statut: 'ignore', motif_ignore: 'hors sujet (pas de lexique chasse)', texte_r2_key: null }); stats.ignores++; continue }
      const meta = extraireMetadonnees(texte)
      const texte_r2_key = cleArchive(doc.saison, doc.departement, doc.sha256, 'texte.json')
      await deps.archive.deposer(texte_r2_key, Buffer.from(JSON.stringify({ sha256: doc.sha256, pages: pagesRetenues, actes, pagesRetenues: retenues })), 'application/json')
      await deps.depot.majLecture(doc.id, { type_detecte: type, numero_acte: meta.numero_acte, date_acte: meta.date_acte, objet: null, qualite_texte: qualiteDocument(pagesRetenues), pages_retenues: retenues, statut: 'a_lire', texte_r2_key })
      stats.aLire++; log(`${doc.departement} ${type} : ${titre} (${retenues.length} p.)`)
    } catch (e) { stats.erreurs++; await deps.depot.marquerErreur(doc.id, (e as Error).message) }
    finally { temp?.liberer() }
  }
  return stats
}
