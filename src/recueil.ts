// Découpage d'un recueil des actes administratifs (RAA) en actes : par sommaire si possible, sinon par en-têtes.
import { parleDeChasse } from './lexique.ts'
import type { PageTexte } from './types.ts'

export interface Acte { titre: string; pageDebut: number; pageFin: number; chasse: boolean }
// Ligne de sommaire : titre, séparateur (points de suite, espaces, tirets…) puis numéro de page en fin de ligne.
const RE_LIGNE_SOMMAIRE = /^(.+?)[\s.…_-]+(\d{1,3})\s*$/
const RE_MOT_SOMMAIRE = /\bsommaire\b/
const RE_ENTETE = /^\s*(ARR[ÊE]T[ÉE]\s*(PR[ÉE]FECTORAL|N\s*°|n\s*°|INTER)|Arr[êe]t[ée]\s+(n\s*°|pr[ée]fectoral|portant|relatif|modifiant))/im
const sansAccents = (s: string) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '')

// Lit le sommaire (lignes après le mot « SOMMAIRE »). Un titre sur deux lignes (la 2e commence en minuscule) est recollé ;
// une entrée dont la page décroît est ignorée, les suivantes continuent.
export function lireSommaire(pagesSommaire: PageTexte[], nbPagesTotal: number): Acte[] | null {
  const entrees: { titre: string; page: number }[] = []
  let dansSommaire = false; let enAttente: string | null = null
  for (const p of pagesSommaire.slice(0, 6)) {
    for (const brute of p.texte.split('\n')) {
      const ligne = brute.trim()
      if (!dansSommaire) { if (RE_MOT_SOMMAIRE.test(sansAccents(ligne).toLowerCase())) dansSommaire = true; continue }
      if (!ligne) continue
      const m = RE_LIGNE_SOMMAIRE.exec(ligne)
      if (!m) { enAttente = enAttente && /^\p{Ll}/u.test(ligne) ? `${enAttente} ${ligne}` : ligne; continue }
      let titre = m[1].replace(/[\s.…_-]+$/, '').trim()
      if (enAttente && /^\p{Ll}/u.test(titre)) titre = `${enAttente} ${titre}`
      enAttente = null
      const page = +m[2]
      if (titre.length < 15 || page < 1 || page > nbPagesTotal) continue
      if (entrees.length && page < entrees[entrees.length - 1].page) continue
      entrees.push({ titre, page })
    }
  }
  if (entrees.length < 3) return null
  return entrees.map((e, i) => ({ titre: e.titre, pageDebut: e.page, pageFin: Math.max(e.page, (entrees[i + 1]?.page ?? nbPagesTotal + 1) - 1), chasse: false }))
}

export function decouperParEntetes(pages: PageTexte[]): Acte[] {
  const debuts = pages.filter(p => RE_ENTETE.test(p.texte.split('\n').slice(0, 15).join('\n'))).map(p => p.n)
  if (!debuts.length) return pages.length ? [{ titre: pages[0].texte.split('\n').find(l => l.trim()) ?? '', pageDebut: pages[0].n, pageFin: pages[pages.length - 1].n, chasse: false }] : []
  const dernier = pages[pages.length - 1].n
  return debuts.map((d, i) => { const p = pages.find(p => p.n === d)!; return { titre: p.texte.split('\n').map(l => l.trim()).filter(Boolean).slice(0, 3).join(' '), pageDebut: d, pageFin: (debuts[i + 1] ?? dernier + 1) - 1, chasse: false } })
}

export function actesChasse(actes: Acte[], pages: PageTexte[]): Acte[] {
  return actes.map(a => ({ ...a, chasse: parleDeChasse(a.titre) || pages.some(p => p.n >= a.pageDebut && p.n <= a.pageFin && parleDeChasse(p.texte)) }))
}

export function pagesAOcr(sommaire: Acte[] | null, nbPages: number): number[] {
  if (sommaire) return sommaire.filter(a => a.chasse).flatMap(a => Array.from({ length: a.pageFin - a.pageDebut + 1 }, (_, i) => a.pageDebut + i))
  if (nbPages <= 60) return Array.from({ length: nbPages }, (_, i) => i + 1)
  const out = [1, 2, 3, 4, 5, 6]; for (let n = 9; n <= nbPages; n += 3) out.push(n); return out
}
