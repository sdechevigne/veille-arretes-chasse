// Étage 2 : lecture mécanique des documents a_extraire (texte, OCR ciblé, découpage, classement, garde).
import { cleArchive, cleImagePage, type Archive } from './r2.ts'
import type { Depot } from './db.ts'
import { lirePage, qualiteDocument, type OutilsPdf } from './pdf.ts'
import { lireSommaire, decouperParEntetes, actesChasse, pagesAOcr, type Acte } from './recueil.ts'
import { classer, extraireMetadonnees, garde } from './classement.ts'
import type { PageTexte } from './types.ts'

export interface DepsLecture { depot: Depot; archive: Archive; outils: OutilsPdf; noms: Record<string, string>; fichierTemp: (octets: Buffer) => Promise<{ chemin: string; liberer: () => void }>; now?: () => Date; log?: (l: string) => void }
export interface OptionsLecture {
  limite?: number; pagesMaxParDocument?: number
  /** Heure limite : vérifiée avant chaque document ; on ne commence pas un document dont la lecture estimée (MS_PAR_PAGE × pages) dépasse le temps restant. */
  echeance?: Date
}
export interface StatsLecture { traites: number; aLire: number; ignores: number; erreurs: number; pagesOcr: number; arretPrecoce: boolean }
const SEUIL_RECUEIL = 30
const PAGES_MAX_PAR_DOCUMENT = 150
const MS_PAR_PAGE = 8000 // estimation prudente (OCR) du temps de lecture d'une page
// Titre « nu » de sommaire (« Arrêté DDT-SEN-2026-45 ») : une fois retirés arrêté, n°, préfectoral, chiffres, tirets et slashs, il ne dit plus rien de l'objet.
const titreNu = (titre: string) => titre.replace(/arr[êe]t[ée]|n\s*°|pr[ée]fectoral/gi, '').replace(/[\d/-]/g, '').replace(/\s+/g, ' ').trim().length < 12
const croissant = (a: number, b: number) => a - b

export async function lireMecaniquement(deps: DepsLecture, o: OptionsLecture = {}): Promise<StatsLecture> {
  const log = deps.log ?? (() => {}); const now = deps.now ?? (() => new Date()); const pagesMax = o.pagesMaxParDocument ?? PAGES_MAX_PAR_DOCUMENT; const stats: StatsLecture = { traites: 0, aLire: 0, ignores: 0, erreurs: 0, pagesOcr: 0, arretPrecoce: false }
  const docs = await deps.depot.documentsParStatut('a_extraire', o.limite ?? 50)
  const tempsRestantMs = () => o.echeance ? o.echeance.getTime() - now().getTime() : Infinity
  for (const doc of docs) {
    if (tempsRestantMs() <= 0) { stats.arretPrecoce = true; log('échéance atteinte : lecture interrompue'); break }
    stats.traites++
    let temp: { chemin: string; liberer: () => void } | null = null
    try {
      temp = await deps.fichierTemp(await deps.archive.lire(doc.r2_key))
      const chemin = temp.chemin
      const nbPages = await deps.outils.nbPages(chemin)
      // Pas de document commencé s'il ne tient pas dans le temps restant : il reste a_extraire pour le prochain passage.
      if (tempsRestantMs() < MS_PAR_PAGE * Math.min(nbPages, pagesMax)) { stats.arretPrecoce = true; stats.traites--; log(`${doc.departement} reporté : ${nbPages} pages, temps restant insuffisant`); continue }
      const lues = new Map<number, PageTexte>()
      const lire = async (n: number) => { if (!lues.has(n)) { const p = await lirePage(deps.outils, chemin, n); if (p.source === 'ocr') stats.pagesOcr++; lues.set(n, p) } return lues.get(n)! }
      let actes: Acte[] | undefined; let retenues: number[]; let motifVide = 'document sans page'
      // Panne d'outil (pdftotext / tesseract) ≠ document sans intérêt : plus de la moitié de pages en erreur → erreur rejouable, jamais un « ignore » silencieux.
      const verifierLecture = () => {
        const pages = [...lues.values()]; const enErreur = pages.filter(p => p.source === 'erreur')
        if (pages.length && enErreur.length > pages.length / 2) throw new Error(`lecture impossible : ${enErreur[0].erreur}`)
      }

      if (nbPages <= SEUIL_RECUEIL) {
        for (let n = 1; n <= nbPages; n++) await lire(n)
        verifierLecture()
        retenues = [...lues.keys()]
      } else {
        for (let n = 1; n <= Math.min(6, nbPages); n++) await lire(n)
        verifierLecture()
        const sommaire = lireSommaire([...lues.values()], nbPages)
        if (sommaire) {
          actes = actesChasse(sommaire, [])
          // Titres nus : on lit leur 1re page pour juger le contenu.
          const nus = actes.filter(a => !a.chasse && titreNu(a.titre))
          for (const a of nus) await lire(a.pageDebut)
          const lus = [...lues.values()]
          actes = actes.map(a => nus.includes(a) ? actesChasse([a], lus)[0] : a)
          log(`${doc.departement} actes écartés : ${actes.filter(a => !a.chasse).map(a => a.titre).join(' | ') || 'aucun'}`)
          retenues = pagesAOcr(actes, nbPages)
          motifVide = `recueil : aucun acte de chasse repéré (${actes.length} actes au sommaire)`
        } else {
          if (nbPages > pagesMax) throw new Error(`document trop long : ${nbPages} pages`)
          for (const n of pagesAOcr(null, nbPages)) await lire(n)
          const pagesEchantillon = [...lues.values()].sort((a, b) => a.n - b.n)
          // Le dernier acte court jusqu'à la fin du document (l'échantillon ne couvre pas toutes les pages).
          actes = actesChasse(decouperParEntetes(pagesEchantillon).map((a, i, tous) => i === tous.length - 1 ? { ...a, pageFin: nbPages } : a), pagesEchantillon)
          retenues = actes.filter(a => a.chasse).flatMap(a => Array.from({ length: a.pageFin - a.pageDebut + 1 }, (_, i) => a.pageDebut + i))
          motifVide = 'échantillon sans acte de chasse'
        }
        retenues = [...new Set(retenues)].sort(croissant)
        if (retenues.length > pagesMax) throw new Error(`document trop long : ${retenues.length} pages à lire`)
        for (const n of retenues) await lire(n)
        verifierLecture()
      }

      const pagesRetenues = retenues.map(n => lues.get(n)!).filter(Boolean).sort((a, b) => a.n - b.n)
      const texte = pagesRetenues.map(p => p.texte).join('\n')
      const titre = doc.titre ?? ''
      if (!retenues.length) { await deps.depot.majLecture(doc.id, { type_detecte: 'hors_sujet', numero_acte: null, date_acte: null, objet: null, qualite_texte: 'ocr_douteux', pages_retenues: [], statut: 'ignore', motif_ignore: motifVide, texte_r2_key: null }); stats.ignores++; log(`${doc.departement} ignoré : ${motifVide}`); continue }
      const g = garde({ departementSource: doc.departement, saisonAttendue: doc.saison }, texte, deps.noms)
      if ('motif' in g) { await deps.depot.majLecture(doc.id, { type_detecte: 'indetermine', numero_acte: null, date_acte: null, objet: null, qualite_texte: qualiteDocument(pagesRetenues), pages_retenues: retenues, statut: 'ignore', motif_ignore: g.motif, texte_r2_key: null }); stats.ignores++; log(`${doc.departement} ignoré : ${g.motif}`); continue }
      const type = classer(titre, texte)
      if (type === 'hors_sujet') { await deps.depot.majLecture(doc.id, { type_detecte: 'hors_sujet', numero_acte: null, date_acte: null, objet: null, qualite_texte: qualiteDocument(pagesRetenues), pages_retenues: retenues, statut: 'ignore', motif_ignore: 'hors sujet (pas de lexique chasse)', texte_r2_key: null }); stats.ignores++; continue }
      const meta = extraireMetadonnees(texte)
      const texte_r2_key = cleArchive(doc.saison, doc.departement, doc.sha256, 'texte.json')
      await deps.archive.deposer(texte_r2_key, Buffer.from(JSON.stringify({ sha256: doc.sha256, pages: pagesRetenues, actes, pagesRetenues: retenues })), 'application/json')
      // Images des pages scannées (OCR / OCR en échec) : la relecture C1 les lit dans R2, la machine de lecture Claude n'a pas poppler. Jamais bloquant.
      for (const p of pagesRetenues.filter(p => p.source !== 'native')) {
        try { await deps.archive.deposer(cleImagePage(doc.saison, doc.departement, doc.sha256, p.n), await deps.outils.imagePage(chemin, p.n), 'image/png') }
        catch (e) { log(`${doc.departement} image page ${p.n} impossible : ${(e as Error).message}`) }
      }
      await deps.depot.majLecture(doc.id, { type_detecte: type, numero_acte: meta.numero_acte, date_acte: meta.date_acte, objet: null, qualite_texte: qualiteDocument(pagesRetenues), pages_retenues: retenues, statut: 'a_lire', texte_r2_key })
      stats.aLire++; log(`${doc.departement} ${type} : ${titre} (${retenues.length} p.)`)
    } catch (e) {
      stats.erreurs++
      try { await deps.depot.marquerErreur(doc.id, (e as Error).message) } catch (e2) { log(`${doc.departement} : marquerErreur a échoué (${(e2 as Error).message}) après « ${(e as Error).message} »`) }
    }
    finally { temp?.liberer() }
  }
  return stats
}
