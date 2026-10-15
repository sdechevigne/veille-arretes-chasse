// Contrôle C1 d'une lecture Claude : preuves ancrées dans le texte, relance Opus unique, double lecture sur images.
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
export interface ResultatC1 { lu: Lu; c1: { ok: boolean; details: string[] }; doubleLecture: boolean }

const PAGES_IMAGE_MAX = 6
// Seul échec C1 qu'une relecture sur image peut lever (OCR en colonnes) : il ne justifie pas une relance Opus.
const ECHEC_IMAGE = 'espèce absente de la citation'
const horsImage = (details: string[]) => details.filter(d => !d.endsWith(ECHEC_IMAGE))
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

export async function controlerC1(deps: DepsC1, doc: DocumentEnBase, pages: PageTexte[], dossier: { texte: string; pagesIncluses: number[] },
  lu: Lu, appeler: Appel, notes: string[]): Promise<ResultatC1> {
  let v = verifierPreuves(lu.sortie, pages, doc.saison)
  // Échecs qu'une meilleure lecture du texte peut lever : relance Opus unique, avec le détail des échecs.
  if (horsImage(v.details).length && !lu.relanceOpus) {
    const r = await appeler({ modele: 'opus', texte: `${dossier.texte}\n\nVérification précédente : ${v.details.join(' ; ')}` })
    if (enPanne(r)) { lu = { ...lu, relanceOpus: true }; notes.push(`relance Opus après C1 impossible : ${panne(r)}`) }
    else { lu = { sortie: r.sortie, modele: r.modele, relanceOpus: true }; v = verifierPreuves(lu.sortie, pages, doc.saison) }
  }
  const aRelire = v.aRelire.length ? v.aRelire : doc.qualite_texte === 'ocr_douteux' ? dossier.pagesIncluses : []
  const echec = (detail: string, doubleLecture = false): ResultatC1 => ({ lu, c1: { ok: false, details: [...v.details, detail] }, doubleLecture })
  if (!aRelire.length) return { lu, c1: { ok: v.ok, details: v.details }, doubleLecture: false }
  if (aRelire.length > PAGES_IMAGE_MAX) return echec(`trop de pages à relire en image (${aRelire.length})`)

  // Double lecture : deux lectures Sonnet indépendantes avec les images des pages ; elles doivent concorder.
  const images = await imagesPages(deps, doc.r2_key, aRelire)
  const a = await appeler({ modele: 'sonnet', texte: dossier.texte, images })
  if (enPanne(a)) return echec(`double lecture impossible : ${panne(a)}`)
  const b = await appeler({ modele: 'sonnet', texte: dossier.texte, images })
  if (enPanne(b)) return echec(`double lecture impossible : ${panne(b)}`)
  const ecarts = ecartsDoubleLecture(a.sortie, b.sortie)
  if (ecarts.length) return echec(`double lecture divergente : ${ecarts.join(' ; ')}`, true)
  // Concordantes : la lecture sur image fait foi ; l'espèce absente d'une citation OCR n'est plus un échec, mais reste tracée.
  const tous = verifierPreuves(a.sortie, pages, doc.saison).details
  const details = horsImage(tous)
  notes.push(...tous.filter(d => !details.includes(d)).map(d => `levé par la double lecture : ${d}`))
  return { lu: { ...lu, sortie: a.sortie }, c1: { ok: details.length === 0, details }, doubleLecture: true }
}
