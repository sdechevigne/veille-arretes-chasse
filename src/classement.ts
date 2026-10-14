// Classement d'un document par motifs textuels, métadonnées d'en-tête, garde département / saison.
import { parleDeChasse } from './lexique.ts'
import { saisonsDepuisTexte } from './saison.ts'
import type { TypeDetecte } from './types.ts'

const MOIS: Record<string, string> = { janvier: '01', fevrier: '02', mars: '03', avril: '04', mai: '05', juin: '06', juillet: '07', aout: '08', septembre: '09', octobre: '10', novembre: '11', decembre: '12' }
// Abréviations de mois fréquentes dans les blocs de signature (« 6 AVR. 2026 »).
const MOIS_ABREGES: Record<string, string> = { janv: '01', fevr: '02', avr: '04', juil: '07', sept: '09', oct: '10', nov: '11', dec: '12' }
// Sans accents, apostrophes typographiques ramenées à « ' » (l’arrêté OCR/PDF utilise ’).
const sansAccents = (s: string) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[’‘´`]/g, "'")
const tete = (texte: string, n = 40) => texte.split('\n').map(l => l.trim()).filter(Boolean).slice(0, n).join('\n')

// Bloc de signature : « Fait à Nancy, le 12 mai 2026 ». L'OCR écrit aussi « Nancy,le », « Fait, le » (lieu absent) ; la ligne commence par « Fait ».
const DEBUT_SIGNATURE = String.raw`^[ \t]*fait(?: a [^\n,]{2,60})?[ \t]*,?[ \t]*le\s+`
const RE_BLOC_SIGNE = new RegExp(DEBUT_SIGNATURE + String.raw`[^\d\n]{0,2}\d`, 'm')
// Le dispositif commence à la ligne « ARRÊTE » seule : un « signé » dans les visas (qui citent d'autres actes) ne compte pas.
const RE_DISPOSITIF = /^[ \t]*arrete[ \t]*:?[ \t]*$/m

export function classer(titre: string, texte: string): TypeDetecte {
  const t = sansAccents(`${titre}\n${tete(texte)}`).toLowerCase(); const tout = sansAccents(texte).toLowerCase()
  // Objet de l'acte = titre + lignes avant le premier « VU » : les visas citent d'autres arrêtés (« modifiant l'arrêté… », « animaux nuisibles »).
  const objet = t.split(/^\s*(?:vu|considerant)\b/m)[0]
  if (!parleDeChasse(`${titre}\n${texte}`)) return 'hors_sujet'
  const dispositif = RE_DISPOSITIF.exec(tout)
  const signe = RE_BLOC_SIGNE.test(tout) || (dispositif !== null && /\bsigne\b/.test(tout.slice(dispositif.index)))
  if (/projet d'?arrete|consultation du public|participation du public/.test(objet) && !signe) return 'projet'
  if (/modifiant l'?arrete|portant modification|arrete modificatif|prolongation|prorogation/.test(objet)) return 'modificatif'
  if (/susceptibles d'?occasionner des degats|\besod\b|nuisibles/.test(objet)) return 'esod'
  if (/ouverture/.test(t) && /cloture|fermeture/.test(t) && /chasse/.test(t)) return 'annuel'
  if (/battue administrative|destruction|chasse particuliere|restriction|incendie|peste porcine|louveterie|tir de nuit|tirs? de defense/.test(t)) return 'ponctuel'
  return 'indetermine'
}

const ALT_MOIS = [...Object.keys(MOIS), ...Object.keys(MOIS_ABREGES)].join('|')
const numeroMois = (m: string) => MOIS[m] ?? MOIS_ABREGES[m]
// Signature lisible : « le 12 mai 2026 », « le 2 3 JUIN 2026 » (jour coupé par l'OCR), « le {6 AVR. 2026 » (jour incertain), « le 12/05/2026 ».
const RE_SIGNATURE = new RegExp(DEBUT_SIGNATURE + String.raw`(?:([^\d\n]?)(\d)\s?(\d)?\s*(?:er)?\s+(${ALT_MOIS})\.?\s+(20\d\d)|(\d{2})/(\d{2})/(20\d\d))`, 'gm')
const RE_DATE_ISO = new RegExp(String.raw`(\d{1,2})(?:er)?\s+(${ALT_MOIS})\.?\s+(20\d\d)|(\d{2})/(\d{2})/(20\d\d)`, 'g')

function datesDe(norm: string): string[] {
  return [...norm.matchAll(RE_DATE_ISO)].map(m => m[1] ? `${m[3]}-${numeroMois(m[2])}-${m[1].padStart(2, '0')}` : `${m[6]}-${m[5]}-${m[4]}`)
}

// date_acte = dernière signature lisible, sinon null (jamais une date de visa). Une signature antérieure à une date de l'en-tête est incohérente → null.
export function extraireMetadonnees(texte: string): { numero_acte: string | null; date_acte: string | null } {
  const t = tete(texte)
  const num = [...t.matchAll(/\bn\s*[°º]\s*[:.]?\s*([A-Z0-9][A-Z0-9/._-]{0,39}(?:\s-\s[A-Z0-9][A-Z0-9/._-]*)?)/gi)].map(m => m[1].replace(/\.+$/, '')).find(n => /\d/.test(n))
  const norm = sansAccents(texte).toLowerCase()
  let signature: string | null = null
  for (const s of norm.matchAll(RE_SIGNATURE)) {
    if (s[4]) signature = s[1] && !s[3] ? null : `${s[5]}-${numeroMois(s[4])}-${(s[2] + (s[3] ?? '')).padStart(2, '0')}`
    else signature = `${s[8]}-${s[7]}-${s[6]}`
  }
  if (signature && datesDe(sansAccents(t).toLowerCase()).some(d => d > signature!)) signature = null
  return { numero_acte: num ?? null, date_acte: signature }
}

// Codes de tous les départements nommés dans l'en-tête (« Préfet de la Loire, Préfet du Rhône »), dans l'ordre d'apparition.
export function departementsDuTexte(texte: string, noms: Record<string, string>): string[] {
  const t = sansAccents(tete(texte)).toLowerCase()
  const trouves: { code: string; pos: number }[] = []
  for (const [code, nom] of Object.entries(noms)) {
    const motif = sansAccents(nom).toLowerCase().replace(/[-\s]+/g, '[-\\s]+')
    const re = new RegExp(`(prefet(?:ure)?\\s+(?:de\\s+la\\s+|de\\s+l'|de\\s+|du\\s+|des\\s+|d')?|departement\\s+(?:de\\s+la\\s+|de\\s+l'|de\\s+|du\\s+|des\\s+|d')?|^|\\n)${motif}(?![a-z-])`, 'm')
    const m = re.exec(t); if (m) trouves.push({ code, pos: m.index })
  }
  return trouves.sort((a, b) => a.pos - b.pos).map(x => x.code)
}
export const departementDuTexte = (texte: string, noms: Record<string, string>): string | null => departementsDuTexte(texte, noms)[0] ?? null

export function garde(doc: { departementSource: string; saisonAttendue: string }, texte: string, noms: Record<string, string>): { ok: true } | { ok: false; motif: string } {
  const deps = departementsDuTexte(texte, noms)
  if (deps.length && !deps.includes(doc.departementSource)) return { ok: false, motif: `département lu ${deps.join(', ')} (${deps.map(d => noms[d]).join(', ')}) ≠ source ${doc.departementSource}` }
  const saisons = saisonsDepuisTexte(texte); const [a] = doc.saisonAttendue.split('-').map(Number)
  if (saisons.length && saisons.every(s => Math.abs(+s.split('-')[0] - a) > 1)) return { ok: false, motif: `saison lue ${saisons.join(', ')} hors ${doc.saisonAttendue} ± 1` }
  return { ok: true }
}
