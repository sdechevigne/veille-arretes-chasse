// Lexique de repérage : dates françaises, espèces du vocabulaire, mots-clés chasse. Tolérant aux fautes OCR courantes.
const MOIS = 'janvier|f[ée]vrier|mars|avril|mai|juin|juillet|ao[uû]t|septembre|octobre|novembre|d[ée]cembre'
export const RE_DATE_FR = new RegExp(String.raw`\b\d{1,2}(?:er|"|’|')?\s+(?:${MOIS})\b(?:\s+|[\s\S]{0,40}?)20\d\d\b|\b\d{2}[/-]\d{2}[/-]20\d\d\b`, 'gi')
export const compterDates = (t: string) => (t.match(RE_DATE_FR) ?? []).length

export const ESPECES_RECHERCHE: Record<string, RegExp> = {
  sanglier: /\bsangliers?\b/i, chevreuil: /\bchevreuils?\b/i, cerf: /(?<![\p{L}-])cerfs?(?![\p{L}-])/iu, daim: /\bdaims?\b/i, mouflon: /\bmouflons?\b/i,
  chamois: /\bchamois\b/i, isard: /\bisards?\b/i, lievre: /(?<![\p{L}])li[eéè]vres?(?![\p{L}])/iu, lapin: /\blapins?\b/i, faisan: /\bfaisans?\b/i,
  perdrix: /\bperdrix\b/i, caille: /\bcailles?\b/i, canard: /\bcanards?\b/i, palombe: /\bpalombes?\b|\bpigeons? ramiers?\b/i,
  becasse: /(?<![\p{L}])b[eé]casses?(?![\p{L}])/iu, renard: /\brenards?\b/i, blaireau: /\bblaireaux?\b/i, corbeau: /\bcorbeaux?\b/i,
  corneille: /\bcorneilles?\b/i, pie: /(?<![\p{L}-])pies?(?![\p{L}-])/iu, geai: /\bgeais?\b/i, etourneau: /(?<![\p{L}])[eé]tourneaux?(?![\p{L}])/iu,
  belette: /\bbelettes?\b/i, fouine: /\bfouines?\b/i, martre: /\bmartres?\b/i, putois: /\bputois\b/i,
  ragondin: /\bragondins?\b/i, rat_musque: /(?<![\p{L}])rats?\s+musqu[eé]s?(?![\p{L}])/iu,
}
export const compterEspeces = (t: string) => Object.values(ESPECES_RECHERCHE).filter(re => re.test(t)).length

export const RE_LEXIQUE_CHASSE = /\b(chasse|chasseurs?|gibier|sangliers?|chevreuils?|cerfs?|battues?|esod|nuisibles?|v[eé]nerie|louveterie|plan de chasse|pi[eé]geage)\b/i
export const parleDeChasse = (t: string) => RE_LEXIQUE_CHASSE.test(t)
