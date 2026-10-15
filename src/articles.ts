// Découpage du texte d'un arrêté en articles (un article peut courir sur plusieurs pages). Module pur.
import { compterDates } from './lexique.ts'
import type { Article, PageTexte } from './types.ts'

const RE_ARTICLE = /^\s*article\s+(\d+|1er|premier)\b/i

const numeroDe = (brut: string): string => (/^(1er|premier)$/i.test(brut) ? '1' : brut)

// Coupe sur chaque ligne « Article N ». Ce qui précède le premier article forme l'en-tête (omis s'il est vide) ;
// ce qui suit le dernier (signature) reste rattaché au dernier article.
export function decouperArticles(pages: PageTexte[]): Article[] {
  const articles: Article[] = []
  let courant: Article = { numero: null, titre: 'en-tête', pageDebut: pages[0]?.n ?? 1, texte: '' }
  const lignes: string[] = []
  const clore = () => {
    courant.texte = lignes.splice(0).join('\n')
    if (courant.numero !== null || courant.texte.trim()) articles.push(courant)
  }
  for (const p of pages) {
    for (const ligne of p.texte.split('\n')) {
      const m = RE_ARTICLE.exec(ligne)
      if (m) {
        clore()
        courant = { numero: numeroDe(m[1]), titre: ligne.trim(), pageDebut: p.n, texte: '' }
      }
      lignes.push(ligne)
    }
  }
  clore()
  return articles
}

// Articles porteurs d'au moins une date ; l'en-tête (numero null) est toujours gardé.
export const articlesDates = (articles: Article[]): Article[] =>
  articles.filter(a => a.numero === null || compterDates(a.texte) > 0)
