// Dossier minimal envoyé à Claude : identité, en-tête réduit, articles datés avec repères de page. Module pur.
// Le texte des articles n'est jamais retouché : les citations de Claude doivent en être des sous-chaînes exactes (C1).
import { articlesDates, decouperArticlesPagines, type ArticlePagine } from './articles.ts'
import type { PeriodePubliee } from './difference.ts'
import type { PageTexte } from './types.ts'

export interface EntreeDossier {
  departement: string; nom: string; saison: string
  type: 'projet' | 'annuel' | 'modificatif' | 'esod'
  mode: 'complet' | 'difference' | 'script_projet_signe'
  pages: PageTexte[]; publiees?: PeriodePubliee[]; articlesCibles?: string[]
}

const LIMITE_ENTETE = 1500
// Ratio caractères / token mesuré en phase 1 sur du français OCR.
const CARACTERES_PAR_TOKEN = 3.2

// Visas : une ligne « Vu … » et ses lignes de suite, jusqu'à une ligne vide ou le début d'un autre bloc.
const RE_VISA = /^\s*vu\b/i
const RE_FIN_VISA = /^\s*(?:consid[ée]rant|sur (?:la )?proposition|arr[êe]te\b)/i

// En-tête sans visas, repères de page compris, tronqué à LIMITE_ENTETE ; renvoie aussi les pages réellement montrées.
function entete(a: ArticlePagine): { texte: string; pages: number[] } {
  let corps = '', dansVisa = false
  const debuts: { page: number; position: number }[] = []
  for (const s of a.segments) {
    const gardees = s.texte.split('\n').filter(l => {
      if (RE_VISA.test(l)) return !(dansVisa = true)
      if (!dansVisa) return true
      // La ligne vide qui clôt un visa part avec lui (sinon les visas retirés laissent des blancs en série).
      if (!l.trim()) return (dansVisa = false)
      return !(dansVisa = !RE_FIN_VISA.test(l))
    }).join('\n')
    if (!gardees.trim()) continue
    if (corps) corps += `\n--- page ${s.page} ---\n`
    debuts.push({ page: s.page, position: corps.length })
    corps += gardees
  }
  const pages = debuts.filter(x => x.position < LIMITE_ENTETE).map(x => x.page)
  return { texte: corps.length > LIMITE_ENTETE ? `${corps.slice(0, LIMITE_ENTETE)}\n[…]` : corps, pages }
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

export function construireDossier(d: EntreeDossier): { texte: string; pagesIncluses: number[]; estimationTokens: number } {
  const articles = decouperArticlesPagines(d.pages)
  const tete = articles.find(a => a.numero === null)
  const numerotes = articles.filter(a => a.numero !== null)
  // Le dernier article porte le bloc de signature (« Fait à … le … », signataire) : toujours montré, pour juger `acte.signe`.
  const dernier = numerotes[numerotes.length - 1]
  const cibles = d.articlesCibles ? new Set(d.articlesCibles) : null
  const retenus = d.mode === 'script_projet_signe' ? [dernier]
    : [...articlesDates(numerotes).filter(a => !cibles || cibles.has(a.numero)), dernier]
  const blocs = [...new Set(retenus.filter(Boolean))].map(article)

  const parties = [`Département ${d.departement} (${d.nom}), saison ${d.saison}, type ${d.type}, mode ${d.mode}`]
  const pages: number[] = []
  if (tete) {
    const e = entete(tete)
    if (e.texte) { parties.push(`=== En-tête (page ${e.pages[0]}) ===\n${e.texte}`); pages.push(...e.pages) }
  }
  for (const b of blocs) { parties.push(b.texte); pages.push(...b.pages) }
  if (d.mode === 'difference') parties.push(['=== Périodes actuellement publiées ===', ...(d.publiees ?? []).map(lignePubliee)].join('\n'))

  const texte = parties.join('\n\n')
  return {
    texte,
    pagesIncluses: [...new Set(pages)].sort((a, b) => a - b),
    estimationTokens: Math.ceil(texte.length / CARACTERES_PAR_TOKEN),
  }
}
