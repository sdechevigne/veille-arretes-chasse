// Normalisation du texte OCR et recherche tolérante d'une citation. Module pur.
export function normaliser(t: string): string {
  return t.toLowerCase().normalize('NFD').replace(/\p{M}/gu, '')
    .replace(/[’‘ʼ`´]/g, "'")
    .replace(/\b(\d+)er\b/g, '$1')
    .replace(/\s+/g, ' ').trim()
}

function bigrammes(t: string): Map<string, number> {
  const m = new Map<string, number>()
  for (let i = 0; i < t.length - 1; i++) { const b = t.slice(i, i + 2); m.set(b, (m.get(b) ?? 0) + 1) }
  return m
}

// Ratio de Dice (0-1) sur les bigrammes des textes normalisés.
export function similarite(a: string, b: string): number {
  const x = normaliser(a), y = normaliser(b)
  if (x === y) return 1
  const bx = bigrammes(x), by = bigrammes(y)
  const total = Math.max(x.length - 1, 0) + Math.max(y.length - 1, 0)
  if (total === 0) return 0
  let commun = 0
  for (const [k, n] of bx) commun += Math.min(n, by.get(k) ?? 0)
  return (2 * commun) / total
}

const SEUIL_CITATION = 0.85
const PAS_FENETRE = 5

// ok = sous-chaîne exacte (score 1) ou meilleure fenêtre glissante de même longueur à ≥ 0,85.
export function trouverCitation(citation: string, page: string): { ok: boolean; score: number } {
  const c = normaliser(citation), p = normaliser(page)
  if (!c) return { ok: false, score: 0 }
  if (p.includes(c)) return { ok: true, score: 1 }
  let meilleur = 0
  const dernier = Math.max(p.length - c.length, 0)
  for (let i = 0; ; i += PAS_FENETRE) {
    const debut = Math.min(i, dernier)
    meilleur = Math.max(meilleur, similarite(c, p.slice(debut, debut + c.length)))
    if (debut >= dernier) break
  }
  return { ok: meilleur >= SEUIL_CITATION, score: meilleur }
}
