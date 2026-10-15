// Raccourci projet → signé : si seules les mentions variables changent, la lecture du projet vaut pour l'arrêté signé. Module pur.
import { articlesDates } from './articles.ts'
import { normaliser } from './texte.ts'
import type { Article } from './types.ts'

// Mentions qui diffèrent naturellement entre un projet et l'arrêté signé (appliquées sur du texte déjà normalisé).
const MENTIONS_VARIABLES: RegExp[] = [
  /projet d'arrete/g,
  /consultation du public/g,
  /\bn\s*°\s*[\w/.-]*/g,
  /\bfait a [^,.]{1,40},?\s*le\s+(?:\d{1,2}\s+[a-z]+\s+\d{4}|\d{2}[/-]\d{2}[/-]\d{4}|[.…_]+)?/g,
  /\bvu l'avis[^;]{0,300};?/g,
]

const texteComparable = (t: string): string =>
  MENTIONS_VARIABLES.reduce((acc, re) => acc.replace(re, ' '), normaliser(t)).replace(/\s+/g, ' ').trim()

// Articles datés (hors en-tête, qui diffère par nature) indexés par numéro.
function indexer(articles: Article[]): Map<string, string> {
  const m = new Map<string, string>()
  for (const a of articlesDates(articles)) if (a.numero !== null) m.set(a.numero, `${m.get(a.numero) ?? ''} ${texteComparable(a.texte)}`.trim())
  return m
}

export function comparerProjetSigne(projet: Article[], signe: Article[]): { identique: boolean; articlesDifferents: string[] } {
  const p = indexer(projet), s = indexer(signe)
  const numeros = [...new Set([...p.keys(), ...s.keys()])].sort((a, b) => Number(a) - Number(b))
  const articlesDifferents = numeros.filter(n => !p.has(n) || !s.has(n) || p.get(n) !== s.get(n))
  // Aucun article daté comparé : rien ne prouve l'identité → lecture complète.
  return { identique: numeros.length > 0 && articlesDifferents.length === 0, articlesDifferents }
}
