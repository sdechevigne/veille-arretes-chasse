// Découpage du texte d'un arrêté en articles (un article peut courir sur plusieurs pages). Module pur.
import { compterDatesLarges } from './dates.ts'
import type { Article, PageTexte } from './types.ts'

const RE_ARTICLE = /^\s*article\s+(\d+|1er|premier)\b/i

const numeroDe = (brut: string): string => (/^(1er|premier)$/i.test(brut) ? '1' : brut)

/** Article accompagné de son texte page par page (un segment par page traversée, dans l'ordre). */
export interface ArticlePagine extends Article { segments: { page: number; texte: string }[] }

// Coupe sur chaque ligne « Article N ». Ce qui précède le premier article forme l'en-tête (omis s'il est vide) ;
// ce qui suit le dernier (signature) reste rattaché au dernier article. Les segments joints par « \n » redonnent
// exactement `texte` : ils servent à situer une citation sur sa page (marqueurs du dossier Claude).
export function decouperArticlesPagines(pages: PageTexte[]): ArticlePagine[] {
  const articles: ArticlePagine[] = []
  let courant: ArticlePagine = { numero: null, titre: 'en-tête', pageDebut: pages[0]?.n ?? 1, texte: '', segments: [] }
  const ajouter = (n: number, ligne: string) => {
    const dernier = courant.segments[courant.segments.length - 1]
    if (dernier?.page === n) dernier.texte += `\n${ligne}`
    else courant.segments.push({ page: n, texte: ligne })
  }
  const clore = () => {
    courant.texte = courant.segments.map(s => s.texte).join('\n')
    if (courant.numero !== null || courant.texte.trim()) articles.push(courant)
  }
  for (const p of pages) {
    for (const ligne of p.texte.split('\n')) {
      const m = RE_ARTICLE.exec(ligne)
      if (m) {
        clore()
        courant = { numero: numeroDe(m[1]), titre: ligne.trim(), pageDebut: p.n, texte: '', segments: [] }
      }
      ajouter(p.n, ligne)
    }
  }
  clore()
  return articles
}

export const decouperArticles = (pages: PageTexte[]): Article[] =>
  decouperArticlesPagines(pages).map(({ segments: _segments, ...a }) => a)

// Articles porteurs d'au moins une date (année facultative) ; l'en-tête (numero null) est toujours gardé.
export const articlesDates = <T extends Article>(articles: T[]): T[] =>
  articles.filter(a => a.numero === null || compterDatesLarges(a.texte) > 0)
