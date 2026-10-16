// Contrôle C1 d'une lecture Claude : preuves ancrées dans le texte, aiguillage selon la nature des pages en échec.
// Page en texte natif : l'échec est une erreur de lecture, qu'une relance Opus unique peut corriger.
// Page scannée (OCR) : l'échec vient le plus souvent de l'OCR, qu'Opus ne répare pas : la page est relue sur son image.
import type { Archive } from './r2.ts'
import type { DocumentEnBase } from './db.ts'
import type { OutilsPdf } from './pdf.ts'
import type { ReponseLecture, RequeteLecture } from './claude.ts'
import { verifierPreuves } from './preuve.ts'
import { ecartsDoubleLecture } from './consolidation.ts'
import type { LectureClaude, PageTexte } from './types.ts'

export type Lu = { sortie: LectureClaude; modele: string; relanceOpus: boolean }
export type Appel = (req: Omit<RequeteLecture, 'systeme' | 'schema'>) => Promise<ReponseLecture>
export interface DepsC1 { archive: Archive; outils: OutilsPdf; fichierTemp: (octets: Buffer) => Promise<{ chemin: string; liberer: () => void }> }
export interface ResultatC1 { lu: Lu; c1: { ok: boolean; details: string[] }; doubleLecture: boolean; lecturesImage: number }

const PAGES_IMAGE_MAX = 6
type Panne = Extract<ReponseLecture, { ok: false }>
/** Garde explicite : en TS non strict, `!r.ok` ne restreint pas l'union. */
export const enPanne = (r: ReponseLecture): r is Panne => !r.ok
export const panne = (r: Panne) => `claude ${r.erreur} : ${r.message}`

async function imagesPages(deps: DepsC1, r2Key: string, pages: number[]): Promise<{ page: number; png: Buffer }[]> {
  const temp = await deps.fichierTemp(await deps.archive.lire(r2Key))
  try {
    const images: { page: number; png: Buffer }[] = []
    for (const page of pages) images.push({ page, png: await deps.outils.imagePage(temp.chemin, page) })
    return images
  } finally { temp.liberer() }
}

const consigneImages = (pages: number[]) =>
  `Pages ${pages.join(', ')} jointes en image : pour ces pages, l'image fait foi sur le texte OCR (citations toujours recopiées du texte fourni).`

export async function controlerC1(deps: DepsC1, doc: DocumentEnBase, pages: PageTexte[], dossier: { texte: string; pagesIncluses: number[] },
  lu: Lu, appeler: Appel, notes: string[]): Promise<ResultatC1> {
  // Page absente ou d'origine inconnue : traitée comme du texte natif (relance Opus).
  const estOcr = (n: number) => pages.find(p => p.n === n)?.source === 'ocr'
  let v = verifierPreuves(lu.sortie, pages, doc.saison)

  // Phase texte : un échec sur une page native justifie la relance Opus unique (par document), avec le détail des échecs.
  if (v.pagesEnEchec.some(n => !estOcr(n)) && !lu.relanceOpus) {
    const r = await appeler({ modele: 'opus', texte: `${dossier.texte}\n\nVérification précédente : ${v.details.join(' ; ')}` })
    if (enPanne(r)) { lu = { ...lu, relanceOpus: true }; notes.push(`relance Opus après C1 impossible : ${panne(r)}`) }
    else { lu = { sortie: r.sortie, modele: r.modele, relanceOpus: true }; v = verifierPreuves(lu.sortie, pages, doc.saison) }
  }

  // Phase image : pages OCR en échec ou signalées illisibles par Claude, et toutes les pages OCR du dossier si l'OCR est douteux.
  const candidats = [...v.pagesEnEchec, ...(lu.sortie.pages_illisibles ?? []), ...(doc.qualite_texte === 'ocr_douteux' ? dossier.pagesIncluses : [])]
  const cibles = [...new Set(candidats.filter(estOcr))].sort((a, b) => a - b)
  let lecturesImage = 0
  const resultat = (ok: boolean, details: string[]): ResultatC1 => ({ lu, c1: { ok, details }, doubleLecture: lecturesImage > 0, lecturesImage })
  const echec = (detail: string) => resultat(false, [...v.details, detail])
  if (!cibles.length) return resultat(v.ok, v.details)
  if (cibles.length > PAGES_IMAGE_MAX) return echec(`trop de pages à relire en image (${cibles.length})`)

  // Lecture sur image n° 1 : identique à la lecture texte → confirmée ; sinon n° 2, qui doit concorder avec la n° 1.
  const images = await imagesPages(deps, doc.r2_key, cibles)
  const requete = { modele: 'sonnet' as const, texte: `${dossier.texte}\n\n${consigneImages(cibles)}`, images }
  const a = await appeler(requete); lecturesImage++
  if (enPanne(a)) return echec(`lecture sur image impossible : ${panne(a)}`)
  const ecartsTexte = ecartsDoubleLecture(lu.sortie, a.sortie)
  if (ecartsTexte.length) {
    const b = await appeler(requete); lecturesImage++
    if (enPanne(b)) return echec(`lecture sur image impossible : ${panne(b)}`)
    const ecartsImage = ecartsDoubleLecture(a.sortie, b.sortie)
    if (ecartsImage.length) return echec(`lectures divergentes (texte / image) : ${ecartsTexte.join(' ; ')} ; seconde lecture sur image : ${ecartsImage.join(' ; ')}`)
    lu = { ...lu, sortie: a.sortie, modele: a.modele }
  }

  // Lecture confirmée : seuls les échecs portant sur une page relue en image sont levés (tracés) ; les autres demeurent.
  const echecs = verifierPreuves(lu.sortie, pages, doc.saison).echecs
  const leves = echecs.filter(e => cibles.includes(e.page))
  notes.push(...leves.map(e => `confirmé sur image : ${e.detail}`))
  const details = echecs.filter(e => !cibles.includes(e.page)).map(e => e.detail)
  return resultat(details.length === 0, details)
}
