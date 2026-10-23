// Rattrapage des images de pages scannées : documents déjà a_lire dont les pages OCR / en erreur n'ont pas encore leur PNG dans R2
// (la lecture mécanique les dépose depuis qu'elle sait le faire ; la relecture C1 les lit sans poppler).
import { cleImagePage, type Archive } from './r2.ts'
import type { Depot, DocumentEnBase } from './db.ts'
import type { OutilsPdf } from './pdf.ts'
import type { PageTexte } from './types.ts'

export interface DepsImagesPages {
  depot: Depot; archive: Archive; outils: OutilsPdf
  fichierTemp: (octets: Buffer) => Promise<{ chemin: string; liberer: () => void }>
  now?: () => Date; log?: (l: string) => void
}
export interface OptionsImagesPages {
  /** Documents traités (ayant au moins une image manquante) ; les documents déjà complets ne comptent pas. */
  limite: number
  /** Heure limite : vérifiée avant chaque document. */
  echeance?: Date
}
/** `documents` : documents traités ; `images` : PNG déposés ; `erreurs` : documents où une panne passagère (lecture ou dépôt R2,
 *  délai) a échoué, repris au passage suivant ; `sortis` : documents dont une image ne pourra jamais être produite (rendu
 *  impossible), sortis de la file vers en_attente (à traiter à la main). Jamais une exception. */
export interface StatsImagesPages { documents: number; images: number; erreurs: number; sortis: number }
/** Plafond de la file lue (la file a_lire reste petite) : le filtrage des documents complets se fait côté robot. */
const FILE_MAX = 1000

/** Image d'une page scannée pas encore produite : aucune lecture Claude n'est lancée (le contrôle C1 ne pourrait pas relire la
 *  page), le document reste à lire et sera repris au passage suivant, une fois l'image produite. Ni une erreur, ni un C1 rouge. */
export class ImageAbsente extends Error {
  constructor(readonly page: number) { super(`image de la page ${page} absente (à produire par images-pages)`) }
}

/** Pages scannées (OCR, ou OCR en échec) dont l'image n'est pas dans R2 : source unique de ce qui doit être produit (ici) et de
 *  ce qui empêche la lecture Claude (garde avant tout appel). */
export async function pagesSansImage(archive: Archive, doc: Pick<DocumentEnBase, 'saison' | 'departement' | 'sha256'>, pages: PageTexte[]): Promise<number[]> {
  const manquantes: number[] = []
  for (const p of pages.filter(p => p.source !== 'native')) if (!(await archive.existe(cleImagePage(doc.saison, doc.departement, doc.sha256, p.n)))) manquantes.push(p.n)
  return manquantes
}

/** Rendu coupé par le délai (machine chargée) : passager, retenté au passage suivant. Tout autre échec de rendu est déterministe. */
const estPassager = (message: string) => /délai dépassé/.test(message)
/** Première ligne du message d'échec, bornée (le motif tient dans la colonne erreur). */
const causeAbregee = (message: string) => (message.split('\n')[0] || 'cause inconnue').slice(0, 120)

export async function produireImagesPages(deps: DepsImagesPages, o: OptionsImagesPages): Promise<StatsImagesPages> {
  const log = deps.log ?? (() => {}); const now = deps.now ?? (() => new Date())
  const stats: StatsImagesPages = { documents: 0, images: 0, erreurs: 0, sortis: 0 }
  for (const doc of await deps.depot.documentsParStatut('a_lire', FILE_MAX)) {
    if (stats.documents >= o.limite) break
    if (o.echeance && now() >= o.echeance) { log('échéance atteinte : images de pages interrompues'); break }
    if (!doc.texte_r2_key) continue
    let temp: { chemin: string; liberer: () => void } | null = null
    let compte = false
    try {
      const pages: PageTexte[] = JSON.parse((await deps.archive.lire(doc.texte_r2_key)).toString('utf8')).pages
      const manquantes = await pagesSansImage(deps.archive, doc, pages)
      if (!manquantes.length) continue
      stats.documents++; compte = true
      temp = await deps.fichierTemp(await deps.archive.lire(doc.r2_key))
      let echec = false; let rendu: string | null = null
      for (const n of manquantes) {
        let png: Buffer
        try { png = await deps.outils.imagePage(temp.chemin, n) }
        catch (e) {
          const message = (e as Error).message
          if (estPassager(message)) { echec = true; log(`${doc.departement} image page ${n} impossible : ${message}`); continue }
          rendu = `image de la page ${n} impossible à produire : ${causeAbregee(message)}`; break
        }
        try { await deps.archive.deposer(cleImagePage(doc.saison, doc.departement, doc.sha256, n), png, 'image/png'); stats.images++ }
        catch (e) { echec = true; log(`${doc.departement} image page ${n} non déposée : ${(e as Error).message}`) }
      }
      // Rendu impossible (pdftoppm en échec, page hors du PDF, PDF corrompu) : déterministe, le document ne serait jamais lu
      // (garde de la lecture Claude) → sorti de la file, en attente d'un opérateur, avec le motif.
      if (rendu) {
        try { await deps.depot.majStatut(doc.id, 'en_attente', rendu); stats.sortis++; log(`${doc.departement} en attente : ${rendu}`) }
        catch (e) { stats.erreurs++; log(`${doc.departement} : majStatut a échoué (${(e as Error).message}) après « ${rendu} »`) }
      } else if (echec) stats.erreurs++
    } catch (e) {
      if (!compte) stats.documents++
      stats.erreurs++; log(`${doc.departement} images de pages impossibles : ${(e as Error).message}`)
    } finally { temp?.liberer() }
  }
  return stats
}
