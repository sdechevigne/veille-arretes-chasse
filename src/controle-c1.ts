// Contrôle C1 d'une lecture Claude : preuves ancrées dans le texte, aiguillage selon la nature des pages en échec.
// Page en texte natif : l'échec est une erreur de lecture, qu'une relance Opus unique peut corriger.
// Page scannée (OCR, ou OCR en échec) : l'échec vient le plus souvent de l'OCR, qu'Opus ne répare pas : la page est relue sur son image.
import { cleImagePage, type Archive } from './r2.ts'
import type { DocumentEnBase } from './db.ts'
import type { ReponseLecture, RequeteLecture } from './lecteur.ts'
import { levableSurImage, verifierPreuves } from './preuve.ts'
import { comparerLectures } from './consolidation.ts'
import type { LectureClaude, PageTexte } from './types.ts'

export type Lu = { sortie: LectureClaude; modele: string; relanceOpus: boolean }
export type Appel = (req: Omit<RequeteLecture, 'systeme' | 'schema'>) => Promise<ReponseLecture>
export interface DepsC1 { archive: Archive }
export interface ResultatC1 { lu: Lu; c1: { ok: boolean; details: string[] }; doubleLecture: boolean; lecturesImage: number }

const PAGES_IMAGE_MAX = 6
type Panne = Extract<ReponseLecture, { ok: false }>
/** Garde explicite : en TS non strict, `!r.ok` ne restreint pas l'union. */
export const enPanne = (r: ReponseLecture): r is Panne => !r.ok
export const panne = (r: Panne) => `claude ${r.erreur} : ${r.message}`

/** Images des pages lues dans R2 (produites par la lecture mécanique ou `images-pages`). Leur présence est vérifiée avant toute
 *  lecture Claude (garde `pagesSansImage` de la lecture) : une image disparue entre-temps fait échouer la lecture (rejouable). */
async function imagesPages(deps: DepsC1, doc: DocumentEnBase, pages: number[]): Promise<{ page: number; png: Buffer }[]> {
  const images: { page: number; png: Buffer }[] = []
  for (const page of pages) images.push({ page, png: await deps.archive.lire(cleImagePage(doc.saison, doc.departement, doc.sha256, page)) })
  return images
}

const consigneImages = (pages: number[]) =>
  `Pages ${pages.join(', ')} jointes en image : pour ces pages, l'image fait foi sur le texte OCR (citations toujours recopiées du texte fourni).`

export async function controlerC1(deps: DepsC1, doc: DocumentEnBase, pages: PageTexte[], dossier: { texte: string; pagesIncluses: number[] },
  lu: Lu, appeler: Appel, notes: string[]): Promise<ResultatC1> {
  // Page à relire sur image : OCR, ou OCR en échec (`erreur`, texte inexploitable : Opus n'y peut rien).
  // Page absente ou d'origine inconnue : traitée comme du texte natif (relance Opus).
  const sourceDe = (n: number) => pages.find(p => p.n === n)?.source
  const surImage = (n: number) => sourceDe(n) === 'ocr' || sourceDe(n) === 'erreur'
  let v = verifierPreuves(lu.sortie, pages, doc.saison)

  // Phase texte : un échec sur une page native justifie la relance Opus unique (par document), avec le détail des échecs.
  if (v.pagesEnEchec.some(n => !surImage(n)) && !lu.relanceOpus) {
    const r = await appeler({ modele: 'opus', texte: `${dossier.texte}\n\nVérification précédente : ${v.details.join(' ; ')}` })
    if (enPanne(r)) { lu = { ...lu, relanceOpus: true }; notes.push(`relance Opus après C1 impossible : ${panne(r)}`) }
    else { lu = { sortie: r.sortie, modele: r.modele, relanceOpus: true }; v = verifierPreuves(lu.sortie, pages, doc.saison) }
  }

  // Pages natives déclarées illisibles : texte exact, rien à relire en image (tracé).
  for (const n of new Set(lu.sortie.pages_illisibles ?? [])) if (sourceDe(n) === 'native') notes.push(`page ${n} déclarée illisible (texte natif), non relue en image`)
  let lecturesImage = 0
  // C1 vert : renvois aux dates générales et espèces prouvées par un extrait de la lecture retenue sont tracés dans les notes.
  const resultat = (ok: boolean, details: string[]): ResultatC1 => {
    if (ok) notes.push(...verifierPreuves(lu.sortie, pages, doc.saison).notes)
    return { lu, c1: { ok, details }, doubleLecture: lecturesImage > 0, lecturesImage }
  }
  // Échec persistant sur une page native : C1 reste rouge quoi qu'il arrive, aucune relecture sur image (dépense inutile).
  if (v.pagesEnEchec.some(n => !surImage(n))) return resultat(false, v.details)

  // Phase image : pages OCR en échec ou signalées illisibles par Claude, et toutes les pages OCR du dossier si l'OCR est douteux.
  const candidats = [...v.pagesEnEchec, ...(lu.sortie.pages_illisibles ?? []), ...(doc.qualite_texte === 'ocr_douteux' ? dossier.pagesIncluses : [])]
  const cibles = [...new Set(candidats.filter(surImage))].sort((a, b) => a - b)
  const echec = (detail: string) => resultat(false, [...v.details, detail])
  if (!cibles.length) return resultat(v.ok, v.details)
  if (cibles.length > PAGES_IMAGE_MAX) return echec(`trop de pages à relire en image (${cibles.length})`)

  // Lecture sur image n° 1 : identique à la lecture texte → confirmée ; sinon n° 2, qui doit concorder avec la n° 1.
  // Comparaison sur espèce, sous-type, mode et dates ; restriction et article différents ne font qu'une note.
  const images = await imagesPages(deps, doc, cibles)
  const requete = { modele: 'sonnet' as const, texte: `${dossier.texte}\n\n${consigneImages(cibles)}`, images }
  const a = await appeler(requete)
  if (enPanne(a)) return echec(`lecture sur image impossible : ${panne(a)}`)
  lecturesImage++
  const texteImage = comparerLectures(lu.sortie, a.sortie)
  // Page sans texte (OCR en échec, texte vide) : le texte n'a rien pu confirmer, seules deux lectures sur image concordantes valent.
  const sansTexte = (e: { page: number }) => cibles.includes(e.page) && sourceDe(e.page) === 'erreur'
  const resteSansTexte = () => verifierPreuves(lu.sortie, pages, doc.saison).echecs.some(e => sansTexte(e) && !levableSurImage(e))
  let confirmeeParDeuxImages = false
  if (texteImage.ecarts.length || resteSansTexte()) {
    const b = await appeler(requete)
    if (enPanne(b)) return echec(`lecture sur image impossible : ${panne(b)}`)
    lecturesImage++
    const imageImage = comparerLectures(a.sortie, b.sortie)
    if (imageImage.ecarts.length) {
      return echec(texteImage.ecarts.length
        ? `lectures divergentes (texte / image) : ${texteImage.ecarts.join(' ; ')} ; seconde lecture sur image : ${imageImage.ecarts.join(' ; ')}`
        : `lectures divergentes (image / image) : ${imageImage.ecarts.join(' ; ')}`)
    }
    confirmeeParDeuxImages = true
    notes.push(...imageImage.secondaires.map(d => `lectures sur image, restriction ou article différents : ${d}`))
    if (texteImage.ecarts.length) lu = { ...lu, sortie: a.sortie, modele: a.modele }
  } else notes.push(...texteImage.secondaires.map(d => `lectures texte / image, restriction ou article différents : ${d}`))

  // Lecture confirmée : seuls les échecs d'une page relue en image qu'un OCR abîmé explique sont levés (tracés) ;
  // une citation inventée (similarité < 0,5) et les échecs des autres pages demeurent. Page sans texte : deux images concordantes suffisent.
  const echecs = verifierPreuves(lu.sortie, pages, doc.saison).echecs
  const leve = (e: (typeof echecs)[number]) => cibles.includes(e.page) && (levableSurImage(e) || (confirmeeParDeuxImages && sansTexte(e)))
  notes.push(...echecs.filter(leve).map(e => (levableSurImage(e) ? `confirmé sur image : ${e.detail}` : `page ${e.page} sans texte : confirmée par deux lectures sur image : ${e.detail}`)))
  const details = echecs.filter(e => !leve(e)).map(e => e.detail)
  return resultat(details.length === 0, details)
}
