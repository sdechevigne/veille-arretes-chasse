// Étage 1 : visite des sources, découverte des PDF, empreinte, archive, santé des sources.
import { extraireLiens, pagesRaaAVisiter, titreDocument, type Lien } from './liens.ts'
import { sha256 } from './empreinte.ts'
import { cleArchive, type Archive } from './r2.ts'
import { DoublonShaError, type Depot } from './db.ts'
import { saisonCourante, saisonDepuisTexte } from './saison.ts'
import type { Source, Telechargeur, Telechargement } from './types.ts'

export interface DepsCollecte { depot: Depot; archive: Archive; http: Telechargeur; now?: () => Date; log?: (ligne: string) => void }
export interface OptionsCollecte {
  departements?: string[]; profondeurMax?: number; joursRevisiteUrl?: number; maxPagesParSource?: number
  /** Heure limite : vérifiée avant chaque source ; dépassée → arrêt propre (`stats.arretPrecoce`), sources restantes non touchées. */
  echeance?: Date
  /** Écarte les sources dont l'hôte (`new URL(url).hostname`) satisfait le prédicat (appliqué après le filtre départements). */
  exclureHotes?: (hote: string) => boolean
}
export interface StatsCollecte { sourcesVisitees: number; sourcesEnEchec: number; pagesLues: number; pdfVus: number; pdfNouveaux: number; pdfIgnores: number; sourcesEcartees: number; arretPrecoce: boolean; erreurs: string[] }

const estPdf = (t: Telechargement) => t.contentType === 'application/pdf' || t.octets.subarray(0, 5).toString() === '%PDF-'
interface Parcours { visitees: Set<string>; pdfs: number; pagesSuivies: number; plafondSignale: boolean }
const pageEnEchec = (t: Telechargement) => t.statut !== 200 || !!t.erreur
const statutEchec = (t: Telechargement) => t.statut !== 0 && !t.erreur ? `http_${t.statut}` : 'erreur_reseau'
const hoteDe = (url: string) => { try { return new URL(url).hostname } catch { return '' } }
const melanger = <T>(a: T[]) => a.map(x => [Math.random(), x] as const).sort((p, q) => p[0] - q[0]).map(p => p[1])

export async function collecter(deps: DepsCollecte, o: OptionsCollecte = {}): Promise<StatsCollecte> {
  const now = deps.now ?? (() => new Date()); const log = deps.log ?? (() => {})
  const profondeurMax = o.profondeurMax ?? 3; const joursRevisite = o.joursRevisiteUrl ?? 30; const maxPages = o.maxPagesParSource ?? 100
  const stats: StatsCollecte = { sourcesVisitees: 0, sourcesEnEchec: 0, pagesLues: 0, pdfVus: 0, pdfNouveaux: 0, pdfIgnores: 0, sourcesEcartees: 0, arretPrecoce: false, erreurs: [] }
  const urlsVues = await deps.depot.urlsVuesDepuis(joursRevisite)
  let sources = await deps.depot.sourcesActives()
  if (o.departements?.length) sources = sources.filter(s => o.departements!.includes(s.departement))
  if (o.exclureHotes) {
    const avant = sources.length
    sources = sources.filter(s => !o.exclureHotes!(hoteDe(s.url)))
    stats.sourcesEcartees = avant - sources.length
  }

  for (const source of melanger(sources)) {
    if (o.echeance && now() >= o.echeance) { stats.arretPrecoce = true; log('échéance atteinte : collecte interrompue'); break }
    stats.sourcesVisitees++
    try {
      const rep = await deps.http.telecharger(source.url)
      if (pageEnEchec(rep)) {
        await deps.depot.majSanteSource(source.id, false, statutEchec(rep))
        stats.sourcesEnEchec++
        log(`${source.departement} ${source.type_source} : ${rep.statut} ${rep.erreur ?? ''}`)
        continue
      }
      if (estPdf(rep)) { // source pointant directement un PDF
        stats.pdfVus++
        await traiterPdf(source, { url: source.url, texte: '' }, rep)
        await deps.depot.majSanteSource(source.id, true, 'ok')
        continue
      }
      stats.pagesLues++
      const parcours: Parcours = { visitees: new Set([source.url]), pdfs: 0, pagesSuivies: 0, plafondSignale: false }
      const statut = await parcourir(source, rep.octets.toString('utf8'), source.url, 0, parcours)
      await deps.depot.majSanteSource(source.id, statut === 'ok', statut)
      if (statut !== 'ok') stats.sourcesEnEchec++
    } catch (e) {
      stats.sourcesEnEchec++; stats.erreurs.push(`${source.departement}/${source.type_source} : ${(e as Error).message}`)
      try { await deps.depot.majSanteSource(source.id, false, 'erreur_reseau') } catch (e2) { stats.erreurs.push(`${source.departement} santé : ${(e2 as Error).message}`) }
    }
  }
  return stats

  // Parcourt une page (et, pour les RAA, ses sous-pages d'année/mois + pagination). Renvoie le statut de santé de la source
  // (calculé à la page racine) : `ok` dès qu'un PDF a été vu ou qu'au moins une sous-page a été lue en 200 (un mois sans PDF
  // en début de mois n'est pas un échec).
  async function parcourir(source: Source, html: string, urlPage: string, profondeur: number, p: Parcours): Promise<'ok' | 'aucun_pdf' | 'structure_changee'> {
    const liens = extraireLiens(html, urlPage)
    if (!liens.pdfs.length && !liens.sousPages.length && !liens.pagination.length) return profondeur === 0 ? 'structure_changee' : 'aucun_pdf'
    for (const lien of liens.pdfs) { p.pdfs++; await traiterLienPdf(source, lien) }
    if (source.type_source === 'prefecture_raa') {
      // Sous-pages (année → mois) : un niveau de plus ; pagination d'une page à contenu : même niveau (page sœur).
      const suivantes = [
        ...(profondeur < profondeurMax ? pagesRaaAVisiter(liens, now()).map(u => ({ u, niveau: profondeur + 1 })) : []),
        ...(liens.pdfs.length || liens.sousPages.length ? liens.pagination.map(u => ({ u, niveau: profondeur })) : []),
      ]
      for (const { u, niveau } of suivantes) {
        if (p.visitees.has(u)) continue
        if (p.visitees.size >= maxPages) {
          if (!p.plafondSignale) { p.plafondSignale = true; stats.erreurs.push(`${source.departement} parcours interrompu : plafond de ${maxPages} pages atteint`) }
          break
        }
        p.visitees.add(u)
        const rep = await deps.http.telecharger(u)
        if (pageEnEchec(rep)) { stats.erreurs.push(`${source.departement} page ${u} : ${rep.statut} ${rep.erreur ?? ''}`.trim()); continue }
        stats.pagesLues++; p.pagesSuivies++
        await parcourir(source, rep.octets.toString('utf8'), u, niveau, p)
      }
    }
    return p.pdfs || p.pagesSuivies ? 'ok' : 'aucun_pdf'
  }

  async function traiterLienPdf(source: Source, lien: Lien) {
    stats.pdfVus++
    if (urlsVues.has(lien.url)) { stats.pdfIgnores++; return }
    try {
      const rep = await deps.http.telecharger(lien.url)
      if (rep.statut !== 200 || rep.erreur) { stats.erreurs.push(`${source.departement} pdf ${lien.url} : ${rep.statut} ${rep.erreur ?? ''}`.trim()); return }
      if (!estPdf(rep)) { stats.pdfIgnores++; return }
      await traiterPdf(source, lien, rep)
    } catch (e) { stats.erreurs.push(`${source.departement} pdf ${lien.url} : ${(e as Error).message}`) }
  }

  async function traiterPdf(source: Source, lien: Lien, rep: Telechargement) {
    const sha = sha256(rep.octets)
    if ((await deps.depot.shaConnus([sha])).has(sha)) { stats.pdfIgnores++; urlsVues.add(lien.url); return }
    const titre = titreDocument(lien) // texte du lien, sinon nom de fichier de l'URL
    const saison = saisonDepuisTexte(titre) ?? saisonCourante(now())
    const r2_key = cleArchive(saison, source.departement, sha, 'pdf')
    await deps.archive.deposer(r2_key, rep.octets, 'application/pdf')
    try {
      await deps.depot.creerDocument({ departement: source.departement, saison, source_id: source.id, url: lien.url, titre, sha256: sha, r2_key, taille_octets: rep.octets.length })
    } catch (e) {
      if (e instanceof DoublonShaError) { stats.pdfIgnores++; urlsVues.add(lien.url); return } // même contenu déjà inséré (course ou autre source)
      throw e
    }
    urlsVues.add(lien.url); stats.pdfNouveaux++; log(`${source.departement} nouveau : ${titre}`)
  }
}
