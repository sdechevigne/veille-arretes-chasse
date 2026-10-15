// Raccourci projet → signé : si seules les mentions variables changent, la lecture du projet vaut pour l'arrêté signé. Module pur.
import { articlesDates } from './articles.ts'
import { normaliser } from './texte.ts'
import type { Article } from './types.ts'

// Mentions qui diffèrent naturellement entre un projet et l'arrêté signé (appliquées sur du texte déjà normalisé).
const MENTIONS_VARIABLES: RegExp[] = [
  /projet d'arrete/g,
  /consultation du public/g,
  /\bn\s*°\s*[\w/.-]*/g,
  /\bvu l'avis[^;]{0,300};?/g,
]

// Début du bloc de signature : une ligne « Fait à <lieu>, le <date> » (lieu et date vides dans un projet).
// Tout ce qui suit (lieu, date, nom du signataire) diffère par nature entre projet et signé. Ancré en début de ligne
// pour ne jamais couper un article à cause d'un « fait à … le » dans une phrase.
const RE_SIGNATURE = /^[ \t]*fait\s+(?:à|a)\s[^,.]{0,40},?\s*\ble\b/im

const sansSignature = (a: Article): Article => {
  const m = RE_SIGNATURE.exec(a.texte)
  return m ? { ...a, texte: a.texte.slice(0, m.index) } : a
}

const texteComparable = (t: string): string =>
  MENTIONS_VARIABLES.reduce((acc, re) => acc.replace(re, ' '), normaliser(t)).replace(/\s+/g, ' ').trim()

// Articles numérotés indexés par numéro : texte comparable et caractère daté (la date est jugée hors bloc de signature).
function indexer(articles: Article[]): Map<string, { texte: string; date: boolean }> {
  const coupes = articles.map(sansSignature)
  const dates = new Set(articlesDates(coupes))
  const m = new Map<string, { texte: string; date: boolean }>()
  for (const a of coupes) {
    if (a.numero === null) continue
    const prec = m.get(a.numero)
    m.set(a.numero, { texte: `${prec?.texte ?? ''} ${texteComparable(a.texte)}`.trim(), date: (prec?.date ?? false) || dates.has(a) })
  }
  return m
}

// Un numéro présent d'un seul côté (daté ou non) est différent ; les textes ne sont comparés que si l'article est daté
// d'au moins un côté (l'en-tête, qui diffère par nature, n'entre pas dans la comparaison).
export function comparerProjetSigne(projet: Article[], signe: Article[]): { identique: boolean; articlesDifferents: string[] } {
  const p = indexer(projet), s = indexer(signe)
  const numeros = [...new Set([...p.keys(), ...s.keys()])].sort((a, b) => Number(a) - Number(b))
  let compares = 0
  const articlesDifferents = numeros.filter(n => {
    const x = p.get(n), y = s.get(n)
    if (!x || !y) return true
    if (!x.date && !y.date) return false
    compares++
    return x.texte !== y.texte
  })
  // Aucun article daté comparé : rien ne prouve l'identité → lecture complète.
  return { identique: compares > 0 && articlesDifferents.length === 0, articlesDifferents }
}
