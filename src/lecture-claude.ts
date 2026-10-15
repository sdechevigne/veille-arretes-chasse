// Étage 3 : lecture par Claude des documents a_lire (dossier minimal, preuves C1, consolidation) et soumission à la RPC,
// qui contrôle (C2-C6) et décide. Raccourcis : indéterminé (aucun appel), ponctuel (objet seul), projet → signé identique.
import type { Archive } from './r2.ts'
import { PREFIXE_ERREUR_LECTURE, tentativesLecture, type Depot, type DocumentEnBase } from './db.ts'
import type { OutilsPdf } from './pdf.ts'
import type { Lecteur, RequeteLecture, UsageClaude } from './claude.ts'
import { decouperArticles } from './articles.ts'
import { construireDossier } from './dossier.ts'
import { comparerProjetSigne } from './projet.ts'
import { validerVocabulaire, type PeriodePayload } from './payload.ts'
import { saisonsDepuisTexte } from './saison.ts'
import { consoliderPeriodes, payloadDe, zonesNonReprises, type ModeLecture } from './consolidation.ts'
import { controlerC1, enPanne, panne, type Lu } from './controle-c1.ts'
import type { PeriodePubliee } from './difference.ts'
import type { PageTexte, PropositionRobot } from './types.ts'

export interface DepsLectureClaude {
  depot: Depot; archive: Archive; lecteur: Lecteur; outils: OutilsPdf
  /** Consigne chargée une seule fois par l'appelant. */
  consigne: { systeme: string; schema: object }
  noms: Record<string, string>
  fichierTemp: (octets: Buffer) => Promise<{ chemin: string; liberer: () => void }>
  now?: () => Date; log?: (l: string) => void
}
export interface OptionsLectureClaude { limite: number; echeance?: Date }
export interface StatsLectureClaude {
  traites: number; publie: number; publieNote: number; enAttente: number; ignores: number; sansLecture: number; erreurs: number
  arretQuota: boolean; arretPrecoce: boolean; tokens: { input: number; output: number }
  decisions: { documentId: string; departement: string; decision: string }[]
}

const TOKENS_MAX = 40_000

/** Quota de l'abonnement atteint : on arrête le passage, le document en cours reste intact. */
class QuotaAtteint extends Error {}

const lirePages = async (archive: Archive, cle: string): Promise<PageTexte[]> => JSON.parse((await archive.lire(cle)).toString('utf8')).pages

export async function lireAvecClaude(deps: DepsLectureClaude, o: OptionsLectureClaude): Promise<StatsLectureClaude> {
  const log = deps.log ?? (() => {}); const now = deps.now ?? (() => new Date())
  const stats: StatsLectureClaude = { traites: 0, publie: 0, publieNote: 0, enAttente: 0, ignores: 0, sansLecture: 0, erreurs: 0, arretQuota: false, arretPrecoce: false, tokens: { input: 0, output: 0 }, decisions: [] }
  for (const doc of await deps.depot.documentsALire(o.limite, now())) {
    if (o.echeance && now() >= o.echeance) { stats.arretPrecoce = true; log('échéance atteinte : lecture Claude interrompue'); break }
    try {
      await lireDocument(deps, doc, stats, log)
      stats.traites++
    } catch (e) {
      if (e instanceof QuotaAtteint) { stats.arretQuota = true; log(`quota Claude atteint : passage arrêté (${e.message})`); break }
      stats.traites++; stats.erreurs++
      const message = `${PREFIXE_ERREUR_LECTURE} ${(e as Error).message} (tentative ${tentativesLecture(doc.erreur) + 1})`
      log(`${doc.departement} erreur : ${message}`)
      try { await deps.depot.marquerErreur(doc.id, message) } catch (e2) { log(`${doc.departement} : marquerErreur a échoué (${(e2 as Error).message}) après « ${message} »`) }
    }
  }
  return stats
}

async function lireDocument(deps: DepsLectureClaude, doc: DocumentEnBase, stats: StatsLectureClaude, log: (l: string) => void): Promise<void> {
  const { depot } = deps; const dept = doc.departement; const saison = doc.saison; const type = doc.type_detecte
  if (type === 'indetermine') { await depot.majStatut(doc.id, 'en_attente', 'type non déterminé mécaniquement'); stats.sansLecture++; log(`${dept} en attente : type non déterminé`); return }
  if (!doc.texte_r2_key || !type || type === 'hors_sujet') throw new Error(`document non lisible (type ${type ?? 'absent'}, texte ${doc.texte_r2_key ? 'présent' : 'absent'})`)
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
    for (const k of ['input', 'output', 'cache_creation', 'cache_read'] as const) usage[k] += r.usage[k]
    stats.tokens.input += r.usage.input; stats.tokens.output += r.usage.output
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
  const dossier = (typeDossier: Parameters<typeof construireDossier>[0]['type'], mode: ModeLecture, publiees?: PeriodePubliee[]) => {
    const d = construireDossier({ departement: dept, nom: deps.noms[dept] ?? dept, saison, type: typeDossier, mode, pages, publiees })
    if (d.estimationTokens > TOKENS_MAX) throw new Error(`document trop long (${d.estimationTokens} tokens estimés)`)
    if (d.sansArticles) notes.push('document sans article numéroté : texte envoyé entier')
    return d
  }

  // Ponctuel (E5) : seul l'objet est lu, pour l'historique ; aucune proposition.
  if (type === 'ponctuel') {
    const { acte } = (await lire(dossier('ponctuel', 'script_projet_signe').texte)).sortie
    await depot.marquerIgnore(doc.id, 'ponctuel sans effet sur les dates', { numero: acte.numero, date: acte.date, objet: acte.objet })
    stats.ignores++; log(`${dept} ignoré : ponctuel (${acte.objet})`); return
  }

  // Mode : complet, différence (sur la version publiée) ou raccourci projet → signé si les articles sont identiques (E3).
  const publiee = await depot.versionPubliee(dept, saison)
  let mode: ModeLecture = type === 'modificatif' || type === 'esod' ? 'difference' : 'complet'
  if (mode === 'difference' && !publiee.arrete) { mode = 'complet'; notes.push(`${type} : aucune version publiée, lecture complète`) }
  let periodesProjet: PeriodePayload[] = []
  if (type === 'annuel') {
    const projet = await depot.propositionProjet(dept, saison)
    if (projet && comparerProjetSigne(decouperArticles(await lirePages(deps.archive, projet.texte_r2_key)), articles).identique) {
      mode = 'script_projet_signe'; periodesProjet = projet.periodes; notes.push('articles identiques au projet : périodes du projet reprises')
    }
  }
  const d = dossier(type, mode, mode === 'difference' ? publiee.periodes : undefined)
  let lu = await lire(d.texte)
  let c1 = { ok: true, details: [] as string[] }; let doubleLecture = false
  if (mode !== 'script_projet_signe') ({ lu, c1, doubleLecture } = await controlerC1(deps, doc, pages, d, lu, appeler, notes))

  // Consolidation, zones publiées perdues (jamais en silence), payload et refus locaux avant la RPC.
  const conso = consoliderPeriodes(mode, lu.sortie, publiee.periodes, periodesProjet)
  notes.push(...conso.journal)
  const zones = zonesNonReprises(publiee.periodes, conso.periodes)
  if (zones.length) c1 = { ok: false, details: [...c1.details, ...zones] }
  const { acte } = lu.sortie
  if (type === 'projet' && acte.signe) notes.push('projet lu comme signé : statut signé retenu')
  const payload = payloadDe({ departement: dept, saison, nom: deps.noms[dept] ?? dept, statut: acte.signe ? 'signe' : 'en_attente_signature', acte, url: doc.url, periodes: conso.periodes, notes: '' })
  const refus = validerVocabulaire(payload)
  if (refus.length) throw new Error(`payload refusé : ${refus.join(' ; ')}`)

  const proposition: PropositionRobot = {
    document_id: doc.id, departement: dept, saison, mode, type_acte: type, payload, acte: { numero: acte.numero, date: acte.date, objet: acte.objet },
    base_arrete_maj: publiee.arrete?.updated_at ?? null, c1,
    lecture: { modele: lu.modele, relance_opus: lu.relanceOpus, double_lecture: doubleLecture, usage, notes: [lu.sortie.notes, ...notes].filter(Boolean).join('\n') },
    suppression_explicite: conso.suppressionExplicite,
  }
  const r = await depot.soumettre(proposition)
  if (r.decision === 'publie') stats.publie++; else if (r.decision === 'publie_note') stats.publieNote++; else stats.enAttente++
  stats.decisions.push({ documentId: doc.id, departement: dept, decision: r.decision })
  log(`${dept} ${r.decision} : ${r.motif}`)
}
