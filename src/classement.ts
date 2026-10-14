// Classement d'un document par motifs textuels, métadonnées d'en-tête, garde département / saison.
import { parleDeChasse } from './lexique.ts'
import { saisonDepuisTexte } from './saison.ts'
import type { TypeDetecte } from './types.ts'

const MOIS: Record<string, string> = { janvier: '01', fevrier: '02', mars: '03', avril: '04', mai: '05', juin: '06', juillet: '07', aout: '08', septembre: '09', octobre: '10', novembre: '11', decembre: '12' }
// Abréviations de mois fréquentes dans les blocs de signature (« 6 AVR. 2026 »).
const MOIS_ABREGES: Record<string, string> = { janv: '01', fevr: '02', avr: '04', juil: '07', sept: '09', oct: '10', nov: '11', dec: '12' }
// Sans accents, apostrophes typographiques ramenées à « ' » (l’arrêté OCR/PDF utilise ’).
const sansAccents = (s: string) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[’‘´`]/g, "'")
const tete = (texte: string, n = 40) => texte.split('\n').map(l => l.trim()).filter(Boolean).slice(0, n).join('\n')

export function classer(titre: string, texte: string): TypeDetecte {
  const t = sansAccents(`${titre}\n${tete(texte)}`).toLowerCase(); const tout = sansAccents(texte).toLowerCase()
  // Objet de l'acte = titre + lignes avant le premier « VU » : les visas citent d'autres arrêtés (« modifiant l'arrêté… », « animaux nuisibles »).
  const objet = t.split(/^\s*(?:vu|considerant)\b/m)[0]
  if (!parleDeChasse(`${titre}\n${texte}`)) return 'hors_sujet'
  // « Fait à Nancy, le … » : l'OCR écrit « Nancy,le », « Fait, le » (lieu absent) ; la ligne commence par « Fait ».
  const signe = /^\s*fait(?: a [^\n,]{2,60})?\s*,\s*le\s/m.test(tout) || /\bsigne\b/.test(tout) || /le prefet,?\s*\n\s*[A-Z][a-zé-]+ [A-Z]/m.test(texte)
  if (/projet d'?arrete|consultation du public|participation du public/.test(objet) && !signe) return 'projet'
  if (/modifiant l'?arrete|portant modification|arrete modificatif/.test(objet)) return 'modificatif'
  if (/susceptibles d'?occasionner des degats|\besod\b|nuisibles/.test(objet)) return 'esod'
  if (/ouverture/.test(t) && /cloture|fermeture/.test(t) && /chasse/.test(t)) return 'annuel'
  if (/battue administrative|destruction|chasse particuliere|restriction|incendie|peste porcine|louveterie|tir de nuit|tirs? de defense/.test(t)) return 'ponctuel'
  return 'indetermine'
}

const ALT_MOIS = [...Object.keys(MOIS), ...Object.keys(MOIS_ABREGES)].join('|')
// Signature : « Fait à Nancy, le 12 mai 2026 », mais aussi les sorties OCR « Nancy,le {6 AVR. 2026 » (signe parasite
// devant le jour) et « Fait, le 2 3 JUIN 2026 » (jour coupé en deux chiffres), ou « le 12/05/2026 ».
const RE_SIGNATURE = new RegExp(String.raw`^\s*fait(?: a [^\n,]{2,60})?\s*,\s*le\s+(?:\D?(\d)\s?(\d)?\s*(?:er)?\s+(${ALT_MOIS})\.?\s+(20\d\d)|(\d{2})/(\d{2})/(20\d\d))`, 'gm')
const numeroMois = (m: string) => MOIS[m] ?? MOIS_ABREGES[m]

export function extraireMetadonnees(texte: string): { numero_acte: string | null; date_acte: string | null } {
  const t = tete(texte)
  const num = /\bn\s*[°º]\s*[:.]?\s*([A-Z0-9][A-Z0-9/._-]{2,39}(?:\s-\s[A-Z0-9][A-Z0-9/._-]*)?)/i.exec(t)
  const norm = sansAccents(texte).toLowerCase()
  let signature: string | null = null; let s: RegExpExecArray | null
  while ((s = RE_SIGNATURE.exec(norm))) signature = s[3] ? `${s[4]}-${numeroMois(s[3])}-${(s[1] + (s[2] ?? '')).padStart(2, '0')}` : `${s[7]}-${s[6]}-${s[5]}`
  let premiere: string | null = null
  const re = new RegExp(String.raw`(\d{1,2})(?:er)?\s+(${Object.keys(MOIS).join('|')})\s+(20\d\d)|(?:le\s+)?(\d{2})/(\d{2})/(20\d\d)`, 'i')
  const m = re.exec(sansAccents(t).toLowerCase())
  if (m) premiere = m[1] ? `${m[3]}-${MOIS[m[2]]}-${m[1].padStart(2, '0')}` : `${m[6]}-${m[5]}-${m[4]}`
  return { numero_acte: num ? num[1] : null, date_acte: signature ?? premiere }
}

export function departementDuTexte(texte: string, noms: Record<string, string>): string | null {
  const t = sansAccents(tete(texte)).toLowerCase().replace(/[’']/g, "'")
  const candidats = Object.entries(noms).map(([code, nom]) => ({ code, nom: sansAccents(nom).toLowerCase() })).sort((a, b) => b.nom.length - a.nom.length)
  for (const c of candidats) { const re = new RegExp(`(prefet(?:ure)?\\s+(?:de\\s+|du\\s+|des\\s+|de\\s+la\\s+|de\\s+l')?|departement\\s+(?:de\\s+|du\\s+|des\\s+|de\\s+la\\s+|de\\s+l')?|^|\\n)${c.nom.replace(/[-\s]+/g, '[-\\s]+')}(?![a-z-])`, 'm'); if (re.test(t)) return c.code }
  return null
}

export function garde(doc: { departementSource: string; saisonAttendue: string }, texte: string, noms: Record<string, string>): { ok: true } | { ok: false; motif: string } {
  const dep = departementDuTexte(texte, noms)
  if (dep && dep !== doc.departementSource) return { ok: false, motif: `département lu ${dep} (${noms[dep]}) ≠ source ${doc.departementSource}` }
  const s = saisonDepuisTexte(texte)
  if (s) { const [a] = doc.saisonAttendue.split('-').map(Number); const [b] = s.split('-').map(Number); if (Math.abs(a - b) > 1) return { ok: false, motif: `saison lue ${s} hors ${doc.saisonAttendue} ± 1` } }
  return { ok: true }
}
