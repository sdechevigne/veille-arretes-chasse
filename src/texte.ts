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

// Dice sur deux textes DÉJÀ normalisés.
function diceNormalise(x: string, y: string): number {
  if (x === y) return 1
  const total = Math.max(x.length - 1, 0) + Math.max(y.length - 1, 0)
  if (total === 0) return 0
  const by = bigrammes(y); let commun = 0
  for (const [k, n] of bigrammes(x)) commun += Math.min(n, by.get(k) ?? 0)
  return (2 * commun) / total
}

// Ratio de Dice (0-1) sur les bigrammes des textes normalisés.
export function similarite(a: string, b: string): number { return diceNormalise(normaliser(a), normaliser(b)) }

const SEUIL_CITATION = 0.9
// Marge (en caractères) autour de la meilleure fenêtre pour la vérification des nombres : une faute d'OCR qui
// ajoute ou retire une lettre décale la fenêtre et pourrait en couper le dernier chiffre.
const MARGE_NOMBRES = 4

const nombresDe = (t: string): Map<string, number> => {
  const m = new Map<string, number>()
  for (const n of t.match(/\d+/g) ?? []) m.set(n, (m.get(n) ?? 0) + 1)
  return m
}

// ok = sous-chaîne exacte (score 1) ou meilleure fenêtre glissante (pas de 1) de même longueur à ≥ 0,9 ET
// portant tous les nombres de la citation (un chiffre, un jour ou une année altéré ne passe jamais).
export function trouverCitation(citation: string, page: string): { ok: boolean; score: number } {
  const c = normaliser(citation), p = normaliser(page)
  if (!c) return { ok: false, score: 0 }
  if (p.includes(c)) return { ok: true, score: 1 }
  const L = Math.min(c.length, p.length)
  if (L < 2) return { ok: false, score: 0 }
  const cible = bigrammes(c)
  const fenetre = new Map<string, number>()
  let commun = 0
  const ajouter = (b: string) => { const n = fenetre.get(b) ?? 0; if (n < (cible.get(b) ?? 0)) commun++; fenetre.set(b, n + 1) }
  const retirer = (b: string) => { const n = fenetre.get(b)!; if (n <= (cible.get(b) ?? 0)) commun--; fenetre.set(b, n - 1) }
  for (let i = 0; i < L - 1; i++) ajouter(p.slice(i, i + 2))
  const bigrammesCitation = c.length - 1
  const score = () => (2 * commun) / (bigrammesCitation + L - 1)
  let meilleur = score(), debut = 0
  for (let i = 1; i + L <= p.length; i++) {
    retirer(p.slice(i - 1, i + 1)); ajouter(p.slice(i + L - 2, i + L))
    const s = score()
    if (s > meilleur) { meilleur = s; debut = i }
  }
  if (meilleur < SEUIL_CITATION) return { ok: false, score: meilleur }
  const presents = nombresDe(p.slice(Math.max(debut - MARGE_NOMBRES, 0), debut + L + MARGE_NOMBRES))
  for (const [n, k] of nombresDe(c)) if ((presents.get(n) ?? 0) < k) return { ok: false, score: meilleur }
  return { ok: true, score: meilleur }
}
