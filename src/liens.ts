// Extraction des liens utiles sur une page de préfecture (gabarit DSFR : fr-card__link, fr-link, fr-pagination__link).
// Pas de parseur DOM : les pages sont régulières, des expressions suffisent et restent lisibles.
export interface Lien { url: string; texte: string }
export interface Liens { pdfs: Lien[]; sousPages: Lien[]; pagination: string[] }

const RE_A = /<a\b([^>]*)href="([^"]+)"([^>]*)>([\s\S]*?)<\/a>/gi
const MOIS = ['janvier', 'fevrier', 'mars', 'avril', 'mai', 'juin', 'juillet', 'aout', 'septembre', 'octobre', 'novembre', 'decembre']

const sansAccents = (s: string) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
const texteBrut = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim()

function absolue(href: string, base: string): string | null {
  if (!href || href.startsWith('#') || /^(javascript|mailto|tel):/i.test(href)) return null
  try { return new URL(href.trim(), base).href } catch { return null }
}
const estPdf = (url: string) => /\.pdf(\?|$)/i.test(url) || /\/contenu\/telechargement\//i.test(url)
const estPartage = (url: string) => /twitter\.com|facebook\.com|linkedin\.com/i.test(url)

export function extraireLiens(html: string, urlPage: string): Liens {
  const pdfs: Lien[] = []; const sousPages: Lien[] = []; const pagination: string[] = []
  const vus = new Set<string>()
  for (const m of html.matchAll(RE_A)) {
    const attrs = `${m[1]} ${m[3]}`; const url = absolue(m[2], urlPage); if (!url || estPartage(url)) continue
    const texte = texteBrut(m[4])
    if (/fr-pagination__link/.test(attrs)) { if (!/aria-current/.test(attrs) && !pagination.includes(url)) pagination.push(url); continue }
    if (estPdf(url)) { if (!vus.has(url)) { vus.add(url); pdfs.push({ url, texte }) }; continue }
    // Carte de sous-page : lien `fr-card__link` (pages d'année) ou lien nu dans le titre de carte `fr-card__title` (racines).
    const dansTitreCarte = /fr-card__title[^>]*>\s*$/.test(html.slice(Math.max(0, m.index - 200), m.index))
    if (/fr-card__link/.test(attrs) || dansTitreCarte) { if (!vus.has(url)) { vus.add(url); sousPages.push({ url, texte }) } }
  }
  return { pdfs, sousPages, pagination }
}

// Sous-pages à suivre (texte de la carte et dernier segment d'URL, accents ignorés ; le chemin parent ne compte pas) :
// - une carte qui nomme un mois est retenue seulement pour le mois courant ou précédent (et, si elle cite une année, la bonne) ;
// - une carte sans mois est retenue si elle cite l'année courante (ou celle du mois précédent en janvier).
export function pagesRaaAVisiter(liens: Liens, now: Date): string[] {
  const annee = now.getUTCFullYear(); const mois = now.getUTCMonth()
  const precedent = (mois + 11) % 12
  const anneePrecedent = mois === 0 ? annee - 1 : annee
  const cibles = [{ mois: precedent, annee: anneePrecedent }, { mois, annee }]
  const out: string[] = []
  for (const s of liens.sousPages) {
    const cle = sansAccents(`${s.texte} ${decodeURIComponent(new URL(s.url).pathname.split('/').pop() ?? '')}`)
    const annees = [...cle.matchAll(/(?<![0-9])(20\d\d)(?![0-9])/g)].map(a => +a[1])
    const moisNomme = MOIS.findIndex(m => new RegExp(`(^|[^a-z])${m}([^a-z]|$)`).test(cle))
    const retenu = moisNomme >= 0
      ? cibles.some(c => c.mois === moisNomme && (annees.length === 0 || annees.includes(c.annee)))
      : annees.some(a => a === annee || a === anneePrecedent)
    if (retenu && !out.includes(s.url)) out.push(s.url)
  }
  return out
}

export function titreDocument(lien: Lien): string {
  let t = lien.texte.replace(/^t[ée]l[ée]charger\s+/i, '')
  t = t.replace(/\s+PDF\s*-\s*[\d,.]+\s*[KM]b\s*-\s*\d{2}\/\d{2}\/\d{4}\s*$/i, '')
  t = t.replace(/\s*\(?PDF\)?\s*$/i, '')
  if (!t) t = decodeURIComponent(lien.url.split('/').pop() ?? '').replace(/\.pdf$/i, '')
  return t.trim()
}
