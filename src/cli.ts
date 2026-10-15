// CLI du robot de veille. Secrets lus dans l'environnement (jamais affichés).
import { writeFileSync, mkdtempSync, rmSync, readFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { lireEnv, lireManta, type Env } from './env.ts'
import { creerTelechargeur } from './http.ts'
import { creerArchiveR2 } from './r2.ts'
import { creerDepotSupabase, toutesLesPages, type DocumentEnBase } from './db.ts'
import { collecter } from './collecte.ts'
import { lireMecaniquement } from './lecture.ts'
import { lireAvecClaude, preparerDossier, estLisible, TOKENS_MAX } from './lecture-claude.ts'
import { creerLecteurClaude } from './claude.ts'
import { chargerConsigne } from './consigne.ts'
import { corpsNotificationLecture, notifierManta } from './manta.ts'
import { syntheseBilan, texteBilan } from './bilan.ts'
import { outilsPoppler } from './pdf.ts'
import { deriverSources, sqlAmorcage, type ArreteUrl } from './amorcage.ts'
import { createClient } from '@supabase/supabase-js'

const [,, commande, ...reste] = process.argv
/** Valeur d'une option `--nom valeur` ; absente → undefined ; valeur manquante ou commençant par `--` → arrêt (code 2). */
const opt = (nom: string) => {
  const i = reste.indexOf(`--${nom}`); if (i < 0) return undefined
  const valeur = reste[i + 1]
  if (valeur === undefined || valeur.startsWith('--')) { console.error(`--${nom} attend une valeur`); process.exit(2) }
  return valeur
}
const flag = (nom: string) => reste.includes(`--${nom}`)
/** `--budget-min n` (entier > 0) → heure limite = maintenant + n minutes ; absent → aucun budget. */
const echeanceBudget = (): Date | undefined => {
  const brut = opt('budget-min'); if (brut === undefined) return undefined
  const n = +brut
  if (!Number.isInteger(n) || n <= 0) { console.error('--budget-min doit être un entier strictement positif'); process.exit(2) }
  return new Date(Date.now() + n * 60_000)
}
/** `--departements 24,50` → codes en majuscules ; absent → undefined (tous). */
const departementsOpt = () => opt('departements')?.split(',').map(s => s.trim().toUpperCase()).filter(Boolean)
/** `--limite n` (entier > 0), `defaut` si absent. */
const limiteOpt = (defaut: number) => {
  const limite = +(opt('limite') ?? defaut)
  if (!Number.isInteger(limite) || limite <= 0) { console.error('--limite doit être un entier strictement positif'); process.exit(2) }
  return limite
}
const log = (l: string) => console.log(l)
/** Journal sur stderr : commandes dont stdout ne porte que le JSON final (lu par le workflow). */
const logErr = (l: string) => console.error(l)
const USAGE = 'usage: veille <collecter|lire|lire-claude|dossier|notifier|sante|bilan|amorcer> [--departements 24,50] [--sans-proxy] [--limite N] [--budget-min N] [--fichier f.json] [--id uuid] [--notifier] [--etat etat/dernier-bilan.json]'
const RE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const clientSupabase = (env: Env) => createClient(env.supabaseUrl, env.serviceRoleKey, { auth: { persistSession: false } }) as any
/** Noms des départements par code (dossier envoyé à Claude, texte extrait). */
async function nomsDepartements(sb: any): Promise<Record<string, string>> {
  const { data, error } = await sb.from('ref_departements').select('code, nom'); if (error) throw new Error(error.message)
  return Object.fromEntries((data ?? []).map((d: any) => [d.code, d.nom]))
}
const fichierTemp = async (octets: Buffer) => { const dir = mkdtempSync(join(tmpdir(), 'veille-pdf-')); const chemin = join(dir, 'doc.pdf'); writeFileSync(chemin, octets); return { chemin, liberer: () => rmSync(dir, { recursive: true, force: true }) } }

const SAISON_AMORCAGE = '2026-2027'

/** Amorçage : arrêtés généraux de la saison (fichier JSON ou base), SQL d'insertion imprimé sur la sortie standard. */
async function amorcer() {
  const fichier = opt('fichier')
  let arretes: ArreteUrl[]
  if (fichier) {
    arretes = JSON.parse(readFileSync(fichier, 'utf8'))
  } else {
    const env = lireEnv()
    const sb = createClient(env.supabaseUrl, env.serviceRoleKey, { auth: { persistSession: false } }) as any
    const { data, error } = await sb.from('arretes').select('departement, url_source').eq('saison', SAISON_AMORCAGE).eq('type_arrete', 'prefectoral_general').order('departement')
    if (error) throw new Error(error.message)
    arretes = data ?? []
  }
  process.stdout.write(sqlAmorcage(deriverSources(arretes)))
}

/** Notification de fin de lecture Claude, depuis le JSON de `lire-claude` (illisible → notification courte) ; seul le webhook Manta est requis. */
async function notifier() {
  const fichier = opt('fichier'); if (!fichier) { console.error('--fichier attendu (sortie JSON de lire-claude)'); process.exit(2) }
  const corps = corpsNotificationLecture(readFileSync(fichier, 'utf8'))
  const manta = lireManta()
  if (!manta) { console.error('webhook Manta non configuré : notification ignorée'); return }
  await notifierManta(manta, corps)
}

/** Lecture Claude : stdout = statistiques JSON seules (lues par le workflow), journal sur stderr ; code 0 même au quota. */
async function lireClaude(env: Env) {
  if (!env.claude) { console.error('CLAUDE_CODE_OAUTH_TOKEN absent : lecture Claude impossible'); process.exit(2) }
  const limite = limiteOpt(40)
  const echeance = echeanceBudget()
  const departements = departementsOpt()
  const consigne = chargerConsigne()
  const sb = clientSupabase(env)
  const stats = await lireAvecClaude({
    depot: creerDepotSupabase(env.supabaseUrl, env.serviceRoleKey), archive: creerArchiveR2(env.r2), lecteur: creerLecteurClaude(env.claude.token),
    outils: outilsPoppler, consigne, noms: await nomsDepartements(sb), fichierTemp, log: logErr,
  }, { limite, echeance, departements })
  // Reste de la file (message de quota) : information d'appoint, son échec n'invalide pas le passage.
  let restantsALire: number | undefined
  if (stats.arretQuota) {
    let q = sb.from('arretes_documents').select('id', { count: 'exact', head: true }).eq('statut_traitement', 'a_lire')
    if (departements?.length) q = q.in('departement', departements)
    const { count, error } = await q
    if (error) console.error(`comptage de la file impossible : ${error.message}`); else restantsALire = count ?? undefined
  }
  console.log(JSON.stringify({ ...stats, restantsALire }, null, 2))
}

/** Inspection : dossier qui serait envoyé à Claude pour un document (mode, estimation, texte), sans appel Claude. */
async function dossier(env: Env) {
  const id = opt('id'); if (!id || !RE_UUID.test(id)) { console.error('--id <uuid> attendu'); process.exit(2) }
  const sb = clientSupabase(env)
  const { data: doc, error } = await sb.from('arretes_documents').select('*').eq('id', id).maybeSingle() as { data: DocumentEnBase | null; error: { message: string } | null }
  if (error) throw new Error('dossier : ' + error.message)
  if (!doc) throw new Error(`document introuvable : ${id}`)
  const type = doc.type_detecte
  if (!estLisible(type)) throw new Error(`type ${type ?? 'absent'} : aucune lecture Claude pour ce document`)
  if (!doc.texte_r2_key) throw new Error('texte extrait absent : aucune lecture Claude pour ce document')
  const notes: string[] = []
  const p = await preparerDossier({ depot: creerDepotSupabase(env.supabaseUrl, env.serviceRoleKey), archive: creerArchiveR2(env.r2), noms: await nomsDepartements(sb) },
    { ...doc, type_detecte: type, texte_r2_key: doc.texte_r2_key }, notes)
  const d = p.dossier
  const entete = [
    `# document ${doc.id} — ${doc.departement} ${doc.saison} — ${type} (statut ${doc.statut_traitement})`,
    `# mode : ${p.mode}`,
    `# estimation : ${d.estimationTokens} tokens (limite ${TOKENS_MAX}${d.estimationTokens > TOKENS_MAX ? ' : DÉPASSÉE, le document serait refusé' : ''})`,
    `# pages incluses : ${d.pagesIncluses.join(', ') || '-'}${d.sansArticles ? ' (sans article numéroté : texte entier)' : ''}`,
    ...notes.map(n => `# note : ${n}`),
  ]
  console.log(`${entete.join('\n')}\n---\n${d.texte}`)
}

/** Bilan hebdomadaire (comptes seulement ; propositions annulées exclues) : stdout, fichier d'état commité (`--etat`), notification Manta (`--notifier`). */
async function bilan(env: Env) {
  const sb = clientSupabase(env)
  const depuis = new Date(Date.now() - 7 * 86400e3).toISOString()
  const { count: sourcesEnPanne, error: errSources } = await sb.from('arretes_sources').select('id', { count: 'exact', head: true }).gte('echecs_consecutifs', 3)
  if (errSources) throw new Error('bilan : ' + errSources.message)
  const documents = await toutesLesPages<{ statut_traitement: string; type_detecte: string | null }>('bilan/documents', (de, a) =>
    sb.from('arretes_documents').select('statut_traitement, type_detecte').gte('decouvert_le', depuis).order('id').range(de, a))
  const propositions = await toutesLesPages<{ decision: string; usage: Record<string, number> | null }>('bilan/propositions', (de, a) =>
    sb.from('arretes_propositions').select('decision, usage:lecture->usage').is('annulee_le', null).gte('created_at', depuis).order('id').range(de, a))
  const synthese = syntheseBilan({ maintenant: new Date(), sourcesEnPanne: sourcesEnPanne ?? 0, documents, propositions: propositions.map(p => ({ decision: p.decision, lecture: { usage: p.usage ?? undefined } })) })
  const json = JSON.stringify(synthese, null, 2)
  const etat = opt('etat')
  if (etat) { mkdirSync(dirname(etat), { recursive: true }); writeFileSync(etat, json + '\n') }
  if (flag('notifier')) {
    if (env.manta) await notifierManta(env.manta, { type: 'bilan', texte: texteBilan(synthese), donnees: synthese })
    else console.error('webhook Manta non configuré : notification ignorée')
  }
  console.log(json)
}

async function main() {
  if (commande === 'amorcer') return amorcer()
  if (commande === 'notifier') return notifier()
  if (!['collecter', 'lire', 'lire-claude', 'dossier', 'sante', 'bilan'].includes(commande)) { console.error(USAGE); process.exit(2) }
  const env = lireEnv()
  if (commande === 'lire-claude') return lireClaude(env)
  if (commande === 'dossier') return dossier(env)
  if (commande === 'bilan') return bilan(env)
  if (commande === 'collecter') {
    const depot = creerDepotSupabase(env.supabaseUrl, env.serviceRoleKey)
    const archive = creerArchiveR2(env.r2)
    // Sans proxy (option explicite ou secret absent), les sites .gouv.fr (géoblocage) échoueraient tous : on les écarte au lieu de les compter en panne.
    const sansProxy = flag('sans-proxy') || !env.proxy
    const http = creerTelechargeur({ proxy: sansProxy ? undefined : env.proxy })
    const departements = departementsOpt()
    const echeance = echeanceBudget()
    const stats = await collecter({ depot, archive, http, log }, { departements, echeance, exclureHotes: sansProxy ? h => h.endsWith('.gouv.fr') : undefined })
    if (sansProxy) console.error(`${stats.sourcesEcartees} sources .gouv.fr écartées (pas de proxy)`)
    if (departements?.length && stats.sourcesVisitees === 0) console.error(`Avertissement : aucune source active ne correspond aux départements demandés (${departements.join(', ')})`)
    console.log(JSON.stringify(stats, null, 2)); return
  }
  if (commande === 'lire') {
    const depot = creerDepotSupabase(env.supabaseUrl, env.serviceRoleKey)
    const archive = creerArchiveR2(env.r2)
    const limite = limiteOpt(50)
    const echeance = echeanceBudget()
    const noms = await nomsDepartements(clientSupabase(env))
    const stats = await lireMecaniquement({ depot, archive, outils: outilsPoppler, noms, fichierTemp, log }, { limite, echeance })
    console.log(JSON.stringify(stats, null, 2)); return
  }
  // sante : sources à 3 échecs ou plus et documents découverts sur les 7 derniers jours (plafonnés à 1000 lignes chacun)
  const sb = clientSupabase(env)
  const { data: sources, error: errSources } = await sb.from('arretes_sources').select('departement, type_source, url, dernier_statut, echecs_consecutifs').gte('echecs_consecutifs', 3).limit(1000)
  if (errSources) throw new Error('sante : ' + errSources.message)
  const { data: docs, error: errDocs } = await sb.from('arretes_documents').select('statut_traitement, type_detecte').gte('decouvert_le', new Date(Date.now() - 7 * 86400e3).toISOString()).limit(1000)
  if (errDocs) throw new Error('sante : ' + errDocs.message)
  const parStatut: Record<string, number> = {}; const parType: Record<string, number> = {}
  for (const d of docs ?? []) { parStatut[d.statut_traitement] = (parStatut[d.statut_traitement] ?? 0) + 1; const type = d.type_detecte ?? 'non_detecte'; parType[type] = (parType[type] ?? 0) + 1 }
  console.log(JSON.stringify({ sourcesEnPanne: sources ?? [], documents7j: { parStatut, parType } }, null, 2))
}
main().catch(e => { console.error(e.message); process.exit(1) })
