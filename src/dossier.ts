// Dossier minimal envoyé à Claude : identité, en-tête réduit, articles datés avec repères de page. Module pur.
// Le texte des articles n'est jamais retouché : les citations de Claude doivent en être des sous-chaînes exactes (C1).
import { articlesDates, decouperArticlesPagines, type ArticlePagine } from './articles.ts'
import type { PeriodePubliee } from './difference.ts'
import type { PageTexte } from './types.ts'

export interface EntreeDossier {
  departement: string; nom: string; saison: string
  type: 'projet' | 'annuel' | 'modificatif' | 'esod' | 'ponctuel'
  mode: 'complet' | 'difference' | 'script_projet_signe'
  pages: PageTexte[]; publiees?: PeriodePubliee[]; articlesCibles?: string[]
}

const LIMITE_ENTETE = 1500
// Ratio caractères / token mesuré en phase 1 sur du français OCR.
const CARACTERES_PAR_TOKEN = 3.2

// Visas : une ligne « Vu … » et ses lignes de suite. Une ligne de suite commence par une minuscule, un chiffre ou une
// ponctuation, ou prolonge une ligne de visa coupée en pleine phrase (« … de Monsieur Emmanuel » / « DUPONT, … »).
// Le visa s'arrête à une ligne vide (retirée avec lui) ou à toute autre ligne (« Après avis… », « Considérant… »).
const RE_VISA = /^\s*vu\b/i
const RE_SUITE_VISA = /^\s*[\p{Ll}\d(«"'’]/u
const RE_FIN_PHRASE = /[;,.:]\s*$/
const RE_FIN_VISA = /^\s*(?:consid[ée]rant|sur (?:la )?proposition|arr[êe]te\b|apr[èe]s avis)/i
// Remplace chaque passage retiré (visas, troncature) : les lignes de part et d'autre ne se suivent pas dans l'acte.
const COUPURE = '[…]'

// En-tête sans visas (un `[…]` par suite de lignes retirées), repères de page compris, tronqué à `limite` (null : entier)
// sans couper un repère ; renvoie aussi les pages dont le contenu est effectivement montré.
function entete(a: ArticlePagine, limite: number | null): { texte: string; pages: number[] } {
  let corps = '', dansVisa = false, derniereRetiree = ''
  const debuts: { page: number; repere: number; contenu: number }[] = []
  for (const s of a.segments) {
    const lignes: string[] = []
    let precRetiree = false
    for (const l of s.texte.split('\n')) {
      let retirer: boolean
      if (RE_VISA.test(l)) retirer = dansVisa = true
      else if (dansVisa && !l.trim()) { dansVisa = false; retirer = true }
      else if (dansVisa && !RE_FIN_VISA.test(l) && (RE_SUITE_VISA.test(l) || !RE_FIN_PHRASE.test(derniereRetiree))) retirer = true
      else retirer = dansVisa = false
      if (retirer) { derniereRetiree = l; if (!precRetiree) lignes.push(COUPURE) } else lignes.push(l)
      precRetiree = retirer
    }
    if (lignes.every(l => l === COUPURE || !l.trim())) continue
    const repere = corps.length
    if (corps) corps += `\n--- page ${s.page} ---\n`
    debuts.push({ page: s.page, repere, contenu: corps.length })
    corps += lignes.join('\n')
  }
  if (limite === null || corps.length <= limite) return { texte: corps, pages: debuts.map(x => x.page) }
  // Coupure tombant dans un repère de page (ou juste après, sans contenu) : on coupe avant le repère.
  const coupe = debuts.find(x => x.repere < limite && limite <= x.contenu)?.repere ?? limite
  return { texte: `${corps.slice(0, coupe)}\n${COUPURE}`, pages: debuts.filter(x => x.contenu < coupe).map(x => x.page) }
}

// Article complet, repère « --- page P --- » à chaque changement de page (segments vides omis).
const article = (a: ArticlePagine): { texte: string; pages: number[] } => {
  const segments = a.segments.filter((s, i) => i === 0 || s.texte.trim())
  return {
    texte: [`=== Article ${a.numero} (page ${a.pageDebut}) ===`, ...segments.map((s, i) => (i ? `--- page ${s.page} ---\n` : '') + s.texte)].join('\n'),
    pages: segments.map(s => s.page),
  }
}

const tiret = (v: string | null | undefined): string => v ?? '-'
const lignePubliee = (p: PeriodePubliee): string =>
  `${p.espece_code} | ${tiret(p.sous_type)} | ${p.mode_chasse || 'tous_modes'} | ${p.date_ouverture} → ${p.date_fermeture} | ${tiret(p.source_article)}`

export function construireDossier(d: EntreeDossier): { texte: string; pagesIncluses: number[]; estimationTokens: number; sansArticles: boolean } {
  const articles = decouperArticlesPagines(d.pages)
  const tete = articles.find(a => a.numero === null)
  const numerotes = articles.filter(a => a.numero !== null)
  // Aucun « Article N » : tout le texte est dans l'en-tête, envoyé sans troncature (sinon les périodes seraient perdues).
  const sansArticles = numerotes.length === 0
  // Le dernier article porte le bloc de signature (« Fait à … le … », signataire) : toujours montré, pour juger `acte.signe`.
  const dernier = numerotes[numerotes.length - 1]
  const cibles = d.articlesCibles ? new Set(d.articlesCibles) : null
  const retenus = d.mode === 'script_projet_signe' ? [dernier]
    : [...articlesDates(numerotes).filter(a => !cibles || cibles.has(a.numero)), dernier]
  const blocs = [...new Set(retenus.filter(Boolean))].map(article)

  const parties = [`Département ${d.departement} (${d.nom}), saison ${d.saison}, type ${d.type}, mode ${d.mode}`]
  const pages: number[] = []
  if (tete) {
    const e = entete(tete, sansArticles ? null : LIMITE_ENTETE)
    if (e.texte) { parties.push(`=== En-tête (page ${e.pages[0]}) ===\n${e.texte}`); pages.push(...e.pages) }
  }
  for (const b of blocs) { parties.push(b.texte); pages.push(...b.pages) }
  if (d.mode === 'difference') parties.push(['=== Périodes actuellement publiées ===', ...(d.publiees ?? []).map(lignePubliee)].join('\n'))

  const texte = parties.join('\n\n')
  return {
    texte,
    pagesIncluses: [...new Set(pages)].sort((a, b) => a - b),
    estimationTokens: Math.ceil(texte.length / CARACTERES_PAR_TOKEN),
    sansArticles,
  }
}
