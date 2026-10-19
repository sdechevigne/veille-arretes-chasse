// Rattrapage des images de pages scannées : documents déjà a_lire dont les pages OCR / en erreur n'ont pas encore leur PNG dans R2
// (la lecture mécanique les dépose depuis qu'elle sait le faire ; la relecture C1 les lit sans poppler).
import { cleImagePage, type Archive } from './r2.ts'
import type { Depot } from './db.ts'
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
/** `documents` : documents traités ; `images` : PNG déposés ; `erreurs` : documents où une lecture, un rendu ou un dépôt a échoué (jamais une exception). */
export interface StatsImagesPages { documents: number; images: number; erreurs: number }
/** Plafond de la file lue (la file a_lire reste petite) : le filtrage des documents complets se fait côté robot. */
const FILE_MAX = 1000

export async function produireImagesPages(deps: DepsImagesPages, o: OptionsImagesPages): Promise<StatsImagesPages> {
  const log = deps.log ?? (() => {}); const now = deps.now ?? (() => new Date())
  const stats: StatsImagesPages = { documents: 0, images: 0, erreurs: 0 }
  for (const doc of await deps.depot.documentsParStatut('a_lire', FILE_MAX)) {
    if (stats.documents >= o.limite) break
    if (o.echeance && now() >= o.echeance) { log('échéance atteinte : images de pages interrompues'); break }
    if (!doc.texte_r2_key) continue
    let temp: { chemin: string; liberer: () => void } | null = null
    let compte = false
    try {
      const pages: PageTexte[] = JSON.parse((await deps.archive.lire(doc.texte_r2_key)).toString('utf8')).pages
      const manquantes: number[] = []
      for (const p of pages.filter(p => p.source !== 'native')) if (!(await deps.archive.existe(cleImagePage(doc.saison, doc.departement, doc.sha256, p.n)))) manquantes.push(p.n)
      if (!manquantes.length) continue
      stats.documents++; compte = true
      temp = await deps.fichierTemp(await deps.archive.lire(doc.r2_key))
      let echec = false
      for (const n of manquantes) {
        try { await deps.archive.deposer(cleImagePage(doc.saison, doc.departement, doc.sha256, n), await deps.outils.imagePage(temp.chemin, n), 'image/png'); stats.images++ }
        catch (e) { echec = true; log(`${doc.departement} image page ${n} impossible : ${(e as Error).message}`) }
      }
      if (echec) stats.erreurs++
    } catch (e) {
      if (!compte) stats.documents++
      stats.erreurs++; log(`${doc.departement} images de pages impossibles : ${(e as Error).message}`)
    } finally { temp?.liberer() }
  }
  return stats
}
