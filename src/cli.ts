// CLI du robot de veille. Secrets lus dans l'environnement (jamais affichés).
import { writeFileSync, mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { lireEnv } from './env.ts'
import { creerTelechargeur } from './http.ts'
import { creerArchiveR2 } from './r2.ts'
import { creerDepotSupabase } from './db.ts'
import { collecter } from './collecte.ts'
import { lireMecaniquement } from './lecture.ts'
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
const log = (l: string) => console.log(l)
const USAGE = 'usage: veille <collecter|lire|sante|bilan|amorcer> [--departements 24,50] [--sans-proxy] [--limite N] [--fichier arretes.json]'

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

async function main() {
  if (commande === 'amorcer') return amorcer()
  if (!['collecter', 'lire', 'sante', 'bilan'].includes(commande)) { console.error(USAGE); process.exit(2) }
  const env = lireEnv()
  if (commande === 'collecter') {
    const depot = creerDepotSupabase(env.supabaseUrl, env.serviceRoleKey)
    const archive = creerArchiveR2(env.r2)
    const http = creerTelechargeur({ proxy: flag('sans-proxy') ? undefined : env.proxy })
    const departements = opt('departements')?.split(',').map(s => s.trim().toUpperCase()).filter(Boolean)
    const stats = await collecter({ depot, archive, http, log }, { departements })
    if (departements?.length && stats.sourcesVisitees === 0) console.error(`Avertissement : aucune source active ne correspond aux départements demandés (${departements.join(', ')})`)
    console.log(JSON.stringify(stats, null, 2)); return
  }
  if (commande === 'lire') {
    const depot = creerDepotSupabase(env.supabaseUrl, env.serviceRoleKey)
    const archive = creerArchiveR2(env.r2)
    const limite = +(opt('limite') ?? 50)
    if (!Number.isInteger(limite) || limite <= 0) { console.error('--limite doit être un entier strictement positif'); process.exit(2) }
    const sb = createClient(env.supabaseUrl, env.serviceRoleKey, { auth: { persistSession: false } }) as any
    const { data, error } = await sb.from('ref_departements').select('code, nom'); if (error) throw new Error(error.message)
    const noms = Object.fromEntries((data ?? []).map((d: any) => [d.code, d.nom]))
    const fichierTemp = async (octets: Buffer) => { const dir = mkdtempSync(join(tmpdir(), 'veille-pdf-')); const chemin = join(dir, 'doc.pdf'); writeFileSync(chemin, octets); return { chemin, liberer: () => rmSync(dir, { recursive: true, force: true }) } }
    const stats = await lireMecaniquement({ depot, archive, outils: outilsPoppler, noms, fichierTemp, log }, { limite })
    console.log(JSON.stringify(stats, null, 2)); return
  }
  // sante | bilan : sources à 3 échecs ou plus et documents découverts sur les 7 derniers jours (plafonnés à 1000 lignes chacun)
  const sb = createClient(env.supabaseUrl, env.serviceRoleKey, { auth: { persistSession: false } }) as any
  const { data: sources } = await sb.from('arretes_sources').select('departement, type_source, url, dernier_statut, echecs_consecutifs').gte('echecs_consecutifs', 3).limit(1000)
  const { data: docs } = await sb.from('arretes_documents').select('statut_traitement, type_detecte').gte('decouvert_le', new Date(Date.now() - 7 * 86400e3).toISOString()).limit(1000)
  const parStatut: Record<string, number> = {}; const parType: Record<string, number> = {}
  for (const d of docs ?? []) { parStatut[d.statut_traitement] = (parStatut[d.statut_traitement] ?? 0) + 1; parType[d.type_detecte] = (parType[d.type_detecte] ?? 0) + 1 }
  console.log(JSON.stringify({ sourcesEnPanne: sources ?? [], documents7j: { parStatut, parType } }, null, 2))
}
main().catch(e => { console.error(e.message); process.exit(1) })
