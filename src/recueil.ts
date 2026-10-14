// Découpage d'un recueil des actes administratifs (RAA) en actes : par sommaire si possible, sinon par en-têtes.
import { parleDeChasse } from './lexique.ts'
import type { PageTexte } from './types.ts'

export interface Acte { titre: string; pageDebut: number; pageFin: number; chasse: boolean }
const RE_LIGNE_SOMMAIRE = /^(.{15,}?)[\s.…_-]{2,}(\d{1,3})\s*$/
const RE_ENTETE = /^\s*(ARR[ÊE]T[ÉE]\s*(PR[ÉE]FECTORAL|N\s*°|n\s*°|INTER)|Arr[êe]t[ée]\s+(n\s*°|pr[ée]fectoral|portant|relatif|modifiant))/im

export function lireSommaire(pagesSommaire: PageTexte[], nbPagesTotal: number): Acte[] | null {
  const entrees: { titre: string; page: number }[] = []
  for (const p of pagesSommaire.slice(0, 6)) {
    for (const ligne of p.texte.split('\n')) {
      const m = RE_LIGNE_SOMMAIRE.exec(ligne.trim()); if (!m) continue
      const page = +m[2]; if (page < 1 || page > nbPagesTotal) continue
      if (entrees.length && page < entrees[entrees.length - 1].page) continue // ordre croissant exigé
      entrees.push({ titre: m[1].replace(/[\s.…_-]+$/, '').trim(), page })
    }
  }
  if (entrees.length < 3) return null
  return entrees.map((e, i) => ({ titre: e.titre, pageDebut: e.page, pageFin: (entrees[i + 1]?.page ?? nbPagesTotal + 1) - 1, chasse: false }))
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
