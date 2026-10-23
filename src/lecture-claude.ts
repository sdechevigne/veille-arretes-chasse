// Étage 3 : lecture par Claude des documents a_lire (dossier minimal, preuves C1, consolidation) et soumission à la RPC,
// qui contrôle (C2-C6) et décide. Raccourcis : indéterminé (aucun appel), ponctuel (objet seul), projet → signé identique.
import type { Archive } from './r2.ts'
import { ERREUR_MAX, PREFIXE_ERREUR_LECTURE, tentativesLecture, type Depot, type DocumentEnBase, type VersionPubliee } from './db.ts'
import type { Lecteur, RequeteLecture, UsageClaude } from './lecteur.ts'
import { decouperArticles } from './articles.ts'
import { construireDossier } from './dossier.ts'
import { comparerProjetSigne } from './projet.ts'
import { validerVocabulaire, type PeriodePayload } from './payload.ts'
import { saisonsDepuisTexte } from './saison.ts'
import { consoliderPeriodes, deptDetecte, payloadDe, zonesNonReprises, type ModeLecture } from './consolidation.ts'
import { controlerC1, enPanne, ImageAbsente, panne, type Lu } from './controle-c1.ts'
import type { PeriodePubliee } from './difference.ts'
import type { Article, PageTexte, PropositionRobot, ResultatSoumission } from './types.ts'

export interface DepsLectureClaude {
  depot: Depot; archive: Archive; lecteur: Lecteur
  /** Consigne chargée une seule fois par l'appelant. */
  consigne: { systeme: string; schema: object }
  noms: Record<string, string>
  now?: () => Date; log?: (l: string) => void
}
export interface OptionsLectureClaude {
  limite: number; echeance?: Date; departements?: string[]
  /** Plafond de tokens du passage (entrée, sortie et cache confondus) : atteint → arrêt avant le document suivant. */
  budgetTokens?: number
}
export interface StatsLectureClaude {
  traites: number; publie: number; publieNote: number; enAttente: number; ignores: number; sansLecture: number; erreurs: number
  /** Documents laissés a_lire faute d'image de page (ImageAbsente) : ni traités, ni en erreur ; repris au passage suivant. */
  attenteImages: number
  arretQuota: boolean; arretBudget: boolean; arretPrecoce: boolean
  /** Entrée hors cache, sortie, écriture et lecture du cache (la CLI compte l'entrée en cache à part). */
  tokens: UsageClaude
  decisions: { documentId: string; departement: string; decision: string }[]
}

/** Taille maximale d'un dossier envoyé à Claude (estimation). */
export const TOKENS_MAX = 40_000

/** Quota de l'abonnement atteint : on arrête le passage, le document en cours reste intact. */
class QuotaAtteint extends Error {}

const TYPES_LISIBLES = ['projet', 'annuel', 'modificatif', 'esod', 'ponctuel'] as const
export type TypeLisible = typeof TYPES_LISIBLES[number]
export const estLisible = (t: string | null): t is TypeLisible => (TYPES_LISIBLES as readonly (string | null)[]).includes(t)
const lirePages = async (archive: Archive, cle: string): Promise<PageTexte[]> => JSON.parse((await archive.lire(cle)).toString('utf8')).pages

export async function lireAvecClaude(deps: DepsLectureClaude, o: OptionsLectureClaude): Promise<StatsLectureClaude> {
  // Journal défaillant : ne doit jamais faire échouer ni re-marquer un document (la trace est un confort, pas un état).
  const log = (l: string) => { try { deps.log?.(l) } catch { /* journal indisponible */ } }
  const now = deps.now ?? (() => new Date())
  const stats: StatsLectureClaude = { traites: 0, publie: 0, publieNote: 0, enAttente: 0, ignores: 0, sansLecture: 0, erreurs: 0, attenteImages: 0, arretQuota: false, arretBudget: false, arretPrecoce: false, tokens: { input: 0, output: 0, cache_creation: 0, cache_read: 0 }, decisions: [] }
  for (const doc of await deps.depot.documentsALire(o.limite, now(), o.departements)) {
    if (o.echeance && now() >= o.echeance) { stats.arretPrecoce = true; log('échéance atteinte : lecture Claude interrompue'); break }
    if (o.budgetTokens !== undefined && totalTokens(stats.tokens) >= o.budgetTokens) {
      stats.arretBudget = true; log(`budget de tokens atteint (${totalTokens(stats.tokens)} / ${o.budgetTokens}) : lecture Claude interrompue`); break
    }
    let r: ResultatSoumission | null
    try {
      r = await lireDocument(deps, doc, stats, log)
    } catch (e) {
      if (e instanceof QuotaAtteint) { stats.arretQuota = true; log(`quota Claude atteint : passage arrêté (${e.message})`); break }
      if (e instanceof ImageAbsente) { stats.attenteImages++; log(`${doc.departement} en attente d’images : ${e.message}, document laissé à lire`); continue }
      stats.traites++; stats.erreurs++
      const message = messageErreur((e as Error).message, tentativesLecture(doc.erreur) + 1)
      log(`${doc.departement} erreur : ${message}`)
      try { await deps.depot.marquerErreur(doc.id, message) } catch (e2) { log(`${doc.departement} : marquerErreur a échoué (${(e2 as Error).message}) après « ${message} »`) }
      continue
    }
    // Hors du try : une fois la proposition enregistrée, plus rien ne doit marquer le document en erreur (doublon au rejeu).
    stats.traites++
    if (!r) continue
    if (r.decision === 'publie') stats.publie++; else if (r.decision === 'publie_note') stats.publieNote++; else stats.enAttente++
    stats.decisions.push({ documentId: doc.id, departement: doc.departement, decision: r.decision })
    log(`${doc.departement} ${r.decision} : ${r.motif}`)
  }
  return stats
}

/** Tokens consommés, tous compteurs confondus. */
export const totalTokens = (u: UsageClaude): number => u.input + u.output + u.cache_creation + u.cache_read

/** Motif d'erreur de lecture Claude : le corps est tronqué AVANT le compteur, qui survit donc toujours à la limite de la colonne
 *  (sans lui, le compteur repartirait à 1 et le document serait relu indéfiniment). */
export function messageErreur(message: string, tentative: number): string {
  const suffixe = ` (tentative ${tentative})`
  return `${PREFIXE_ERREUR_LECTURE} ${message}`.slice(0, ERREUR_MAX - suffixe.length) + suffixe
}

async function lireDocument(deps: DepsLectureClaude, doc: DocumentEnBase, stats: StatsLectureClaude, log: (l: string) => void): Promise<ResultatSoumission | null> {
  const { depot } = deps; const dept = doc.departement; const saison = doc.saison; const type = doc.type_detecte
  // Sans lecture possible (pas une panne rejouable) : en attente d'un opérateur, aucun appel Claude (même sortie, plus bas,
  // pour un payload refusé par la validation).
  if (!estLisible(type) || !doc.texte_r2_key) {
    const motif = type === 'indetermine' ? 'type non déterminé mécaniquement'
      : !estLisible(type) ? `type ${type ?? 'absent'} : pas de lecture Claude` : 'texte extrait absent : lecture Claude impossible'
    await depot.majStatut(doc.id, 'en_attente', motif); stats.sansLecture++; log(`${dept} en attente : ${motif}`); return null
  }
  const pages = await lirePages(deps.archive, doc.texte_r2_key)
  const articles = decouperArticles(pages)
  const notes: string[] = []

  // Saison : celle de l'en-tête doit être celle du document (sinon refus explicite, rejouable après correction).
  const saisons = saisonsDepuisTexte(articles.find(a => a.numero === null)?.texte ?? '')
  if (saisons.length === 1 && saisons[0] !== saison) throw new Error(`saison lue ${saisons[0]} ≠ saison du document ${saison}`)
  if (saisons.length !== 1) notes.push(`${saisons.length ? `plusieurs saisons dans l'en-tête (${saisons.join(', ')})` : "aucune saison dans l'en-tête"} : saison du document retenue`)

  const usage: UsageClaude = { input: 0, output: 0, cache_creation: 0, cache_read: 0 }
  const appeler = async (req: Omit<RequeteLecture, 'systeme' | 'schema'>) => {
    const r = await deps.lecteur.lire({ systeme: deps.consigne.systeme, schema: deps.consigne.schema, ...req })
    if (enPanne(r)) {
      if (r.erreur === 'quota') throw new QuotaAtteint(r.message)
      return r
    }
    for (const k of ['input', 'output', 'cache_creation', 'cache_read'] as const) { usage[k] += r.usage[k]; stats.tokens[k] += r.usage[k] }
    return r
  }
  // Lecture Sonnet ; panne technique (schéma, délai, CLI) → relance unique en Opus, puis erreur.
  const lire = async (texte: string): Promise<Lu> => {
    const r = await appeler({ modele: 'sonnet', texte })
    if (!enPanne(r)) return { sortie: r.sortie, modele: r.modele, relanceOpus: false }
    const r2 = await appeler({ modele: 'opus', texte })
    if (enPanne(r2)) throw new Error(panne(r2))
    return { sortie: r2.sortie, modele: r2.modele, relanceOpus: true }
  }
  const prep = await preparerDossier(deps, { ...doc, type_detecte: type, texte_r2_key: doc.texte_r2_key }, notes, { pages, articles })
  const d = prep.dossier
  // Garde de taille : un dossier trop long n'est jamais envoyé (refus explicite, rejouable).
  if (d.estimationTokens > TOKENS_MAX) throw new Error(`document trop long (${d.estimationTokens} tokens estimés)`)
  if (d.sansArticles) notes.push('document sans article numéroté : texte envoyé entier')

  // Ponctuel (E5) : seul l'objet est lu, pour l'historique ; aucune proposition.
  if (type === 'ponctuel') {
    const { acte } = (await lire(d.texte)).sortie
    await depot.marquerIgnore(doc.id, 'ponctuel sans effet sur les dates', { numero: acte.numero, date: acte.date, objet: acte.objet })
    stats.ignores++; log(`${dept} ignoré : ponctuel (${acte.objet})`); return null
  }
  const { mode, publiee, periodesProjet } = prep
  let lu = await lire(d.texte)
  let c1 = { ok: true, details: [] as string[] }; let doubleLecture = false; let lecturesImage = 0
  if (mode !== 'script_projet_signe') ({ lu, c1, doubleLecture, lecturesImage } = await controlerC1(deps, doc, pages, d, lu, appeler, notes))

  // Consolidation, zones publiées perdues (jamais en silence), payload et refus locaux avant la RPC.
  const conso = consoliderPeriodes(mode, lu.sortie, publiee.periodes, periodesProjet)
  notes.push(...conso.journal)
  const zones = zonesNonReprises(publiee.periodes, conso.periodes)
  if (zones.length) c1 = { ok: false, details: [...c1.details, ...zones] }
  const { acte } = lu.sortie
  if (type === 'projet' && acte.signe) notes.push('projet lu comme signé : statut signé retenu')
  const nom = deps.noms[dept] ?? dept
  const noteDept = deptDetecte(acte.departement_lu, nom).note
  if (noteDept) notes.push(noteDept)
  const payload = payloadDe({ departement: dept, saison, nom, statut: acte.signe ? 'signe' : 'en_attente_signature', acte, url: doc.url, periodes: conso.periodes, notes: lu.sortie.notes, suppressions: lu.sortie.suppressions })
  // Refus de validation : déterministe (une relecture donnerait le même refus) → sorti de la file, en attente d'un opérateur.
  const refus = validerVocabulaire(payload)
  if (refus.length) {
    const motif = `payload refusé : ${refus.join(' ; ')}`
    await depot.majStatut(doc.id, 'en_attente', motif); stats.sansLecture++; log(`${dept} en attente : ${motif}`); return null
  }

  const proposition: PropositionRobot = {
    document_id: doc.id, departement: dept, saison, mode, type_acte: type, payload, acte: { numero: acte.numero, date: acte.date, objet: acte.objet },
    base_arrete_maj: publiee.arrete?.updated_at ?? null, c1,
    lecture: { modele: lu.modele, relance_opus: lu.relanceOpus, double_lecture: doubleLecture, lectures_image: lecturesImage, usage, notes: [lu.sortie.notes, ...notes].filter(Boolean).join('\n') },
    suppression_explicite: conso.suppressionExplicite,
  }
  try {
    return await depot.soumettre(proposition)
  } catch (e) {
    // Réponse perdue après enregistrement : re-marquer le document en erreur provoquerait une seconde proposition au rejeu.
    // Vérification impossible : comportement par défaut (erreur rejouable), l'échec de la vérification est journalisé.
    let existe = false
    try { existe = await depot.propositionExiste(doc.id) } catch (e2) { log(`${dept} : vérification de la proposition impossible (${(e2 as Error).message})`) }
    if (!existe) throw e
    log(`${dept} : soumission en échec (${(e as Error).message}) mais proposition déjà enregistrée : document laissé tel quel`)
    return null
  }
}

export interface DossierPrepare {
  mode: ModeLecture
  /** Version publiée du couple (non consultée pour un ponctuel : vide). */
  publiee: VersionPubliee
  periodesProjet: PeriodePayload[]
  dossier: ReturnType<typeof construireDossier>
}

/** Mode de lecture et dossier qui serait envoyé à Claude pour un document lisible, sans aucun appel Claude.
 *  Partagé entre la lecture et la commande d'inspection `dossier` ; les notes de choix de mode sont ajoutées à `notes`. */
export async function preparerDossier(
  deps: Pick<DepsLectureClaude, 'depot' | 'archive' | 'noms'>,
  doc: Pick<DocumentEnBase, 'departement' | 'saison'> & { type_detecte: TypeLisible; texte_r2_key: string },
  notes: string[],
  texte?: { pages: PageTexte[]; articles: Article[] },
): Promise<DossierPrepare> {
  const dept = doc.departement; const saison = doc.saison; const type = doc.type_detecte
  const pages = texte?.pages ?? await lirePages(deps.archive, doc.texte_r2_key)
  const articles = texte?.articles ?? decouperArticles(pages)
  const construire = (mode: ModeLecture, publiees?: PeriodePubliee[]) =>
    construireDossier({ departement: dept, nom: deps.noms[dept] ?? dept, saison, type, mode, pages, publiees })
  if (type === 'ponctuel') return { mode: 'script_projet_signe', publiee: { arrete: null, periodes: [] }, periodesProjet: [], dossier: construire('script_projet_signe') }

  // Mode : complet, différence (sur la version publiée) ou raccourci projet → signé si les articles sont identiques (E3).
  const publiee = await deps.depot.versionPubliee(dept, saison)
  let mode: ModeLecture = type === 'modificatif' || type === 'esod' ? 'difference' : 'complet'
  if (mode === 'difference' && !publiee.arrete) { mode = 'complet'; notes.push(`${type} : aucune version publiée, lecture complète`) }
  let periodesProjet: PeriodePayload[] = []
  if (type === 'annuel') {
    const projet = await deps.depot.propositionProjet(dept, saison)
    if (projet && comparerProjetSigne(decouperArticles(await lirePages(deps.archive, projet.texte_r2_key)), articles).identique) {
      mode = 'script_projet_signe'; periodesProjet = projet.periodes; notes.push('articles identiques au projet : périodes du projet reprises')
    }
  }
  return { mode, publiee, periodesProjet, dossier: construire(mode, mode === 'difference' ? publiee.periodes : undefined) }
}
