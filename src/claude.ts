// Lecteur Claude : lance la CLI `claude -p` (abonnement, jeton OAuth) avec une sortie JSON imposée par schéma.
// Le jeton ne transite que par l'environnement du processus fils ; le prompt système passe par un fichier 0600 supprimé ensuite.
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { expurger } from './http.ts'
import { DELAI_LECTURE_MS, validerSortie } from './lecteur.ts'
import type { Lecteur, ReponseLecture, RequeteLecture } from './lecteur.ts'
import type { LectureClaude } from './types.ts'

// Distinct de `Exec` de http.ts (curl) : ici stdin, environnement et délai.
export type ExecClaude = (args: string[], stdin: string, env: Record<string, string>, delaiMs: number) => Promise<{ code: number; stdout: string; stderr: string }>

export class DelaiDepasse extends Error {
  constructor(delaiMs: number) { super(`claude : délai dépassé (${delaiMs} ms)`); this.name = 'DelaiDepasse' }
}

// Lance la CLI ; tuée si elle dépasse `delaiMs` (rejet DelaiDepasse). Un échec de lancement donne un code 1 avec la raison en stderr.
export const execClaude: ExecClaude = (args, stdin, env, delaiMs) => new Promise((resolve, reject) => {
  const p = spawn('claude', args, { env, stdio: ['pipe', 'pipe', 'pipe'] }); let out = ''; let err = ''; let fini = false
  p.stdout.setEncoding('utf8'); p.stderr.setEncoding('utf8')
  p.stdout.on('data', d => { out += d }); p.stderr.on('data', d => { err += d })
  const terminer = (f: () => void) => { if (fini) return; fini = true; clearTimeout(minuteur); f() }
  const minuteur = setTimeout(() => terminer(() => { p.kill('SIGKILL'); reject(new DelaiDepasse(delaiMs)) }), delaiMs)
  p.on('error', e => terminer(() => resolve({ code: 1, stdout: out, stderr: [err, String(e)].filter(Boolean).join('\n') })))
  p.on('close', code => terminer(() => resolve({ code: code ?? 1, stdout: out, stderr: err })))
  p.stdin.on('error', () => { /* le processus a pu se terminer avant la fin de l'écriture : « close » rapporte le résultat */ })
  p.stdin.end(stdin)
})

const estQuota = (t: string) => /rate limit|429|usage limit/i.test(t)
const COURT = 500
const abreger = (t: string) => (t.length > COURT ? `${t.slice(0, COURT)}…` : t)

// Ligne `result` de la sortie stream-json (les autres lignes, JSON ou non, sont ignorées).
function ligneResultat(stdout: string): any | undefined {
  let res: any
  for (const l of stdout.split('\n')) {
    const t = l.trim(); if (!t.startsWith('{')) continue
    try { const o = JSON.parse(t); if (o?.type === 'result') res = o } catch { /* ligne non JSON */ }
  }
  return res
}

function messageUtilisateur(req: RequeteLecture): string {
  const content: object[] = [{ type: 'text', text: req.texte }]
  for (const im of req.images ?? []) {
    content.push({ type: 'text', text: `Image de la page ${im.page} :` })
    content.push({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: im.png.toString('base64') } })
  }
  return JSON.stringify({ type: 'user', message: { role: 'user', content } }) + '\n'
}

// Variables du robot (et jetons tiers) qui n'ont rien à faire dans le processus fils (la CLI n'a besoin que de son jeton et de l'environnement système).
// ANTHROPIC_* : une clé d'API ferait basculer la CLI hors de l'abonnement ; GITHUB_TOKEN / GH_TOKEN : jeton du dépôt (runner).
const SECRETS_ROBOT = /^(SUPABASE_|R2_|MANTA_|HIDEME_|ANTHROPIC_)|^(VEILLE_PROXY_URL|GITHUB_TOKEN|GH_TOKEN)$/
export function envFils(source: NodeJS.ProcessEnv, token: string): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(source)) if (v !== undefined && !SECRETS_ROBOT.test(k)) env[k] = v
  env.CLAUDE_CODE_OAUTH_TOKEN = token
  return env
}

// `envSource` et `dossierTemp` sont injectables pour les tests. `lire` ne rejette jamais : toute panne devient une ReponseLecture en échec.
export function creerLecteurClaude(token: string, exec: ExecClaude = execClaude, envSource: NodeJS.ProcessEnv = process.env, dossierTemp: string = tmpdir()): Lecteur {
  const echec = (erreur: 'quota' | 'schema' | 'timeout' | 'cli', message: string): ReponseLecture => ({ ok: false, erreur, message: abreger(expurger(message.trim(), undefined, token)) })
  return {
    async lire(req) {
      const delaiMs = req.delaiMs ?? DELAI_LECTURE_MS
      let dossier: string | undefined
      try {
        dossier = mkdtempSync(join(dossierTemp, 'veille-claude-'))
        const fichier = join(dossier, 'systeme.md')
        writeFileSync(fichier, req.systeme, { mode: 0o600 })
        // La CLI refuse le méta-schéma « $schema » (« no schema with key or ref ») : retiré de l'argument ; Ajv valide sur le schéma complet.
        const { $schema: _meta, ...schemaCli } = req.schema as Record<string, unknown>
        const args = ['-p', '--model', req.modele, '--system-prompt-file', fichier, '--tools', '', '--strict-mcp-config', '--setting-sources', '', '--no-session-persistence',
          '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--json-schema', JSON.stringify(schemaCli)]
        let r: { code: number; stdout: string; stderr: string }
        try { r = await exec(args, messageUtilisateur(req), envFils(envSource, token), delaiMs) } catch (e: any) {
          if (e instanceof DelaiDepasse || e?.code === 'ETIMEDOUT') return echec('timeout', `délai de ${delaiMs} ms dépassé`)
          return echec('cli', String(e?.message ?? e))
        }
        const res = ligneResultat(r.stdout)
        if (res?.is_error) {
          const texte = [res.result, res.error, res.subtype].filter(t => typeof t === 'string').join(' ')
          if (estQuota(texte + ' ' + r.stderr)) return echec('quota', texte || r.stderr)
          if (/structured_output/i.test(String(res.subtype))) return echec('schema', `sortie structurée refusée par la CLI : ${res.subtype}`)
          return echec('cli', texte || r.stderr || `is_error (code ${r.code})`)
        }
        if (r.code !== 0) return echec(estQuota(r.stderr) ? 'quota' : 'cli', r.stderr.trim() || `code de sortie ${r.code}`)
        if (!res) return echec('cli', 'aucune ligne « result » dans la sortie de la CLI')
        const sortie = res.structured_output
        if (sortie === undefined || sortie === null) return echec('schema', 'structured_output absent')
        const invalide = validerSortie(req.schema, sortie)
        if (invalide) return echec('schema', invalide)
        const u = res.usage ?? {}
        return { ok: true, sortie: sortie as LectureClaude, modele: typeof res.model === 'string' ? res.model : req.modele,
          usage: { input: u.input_tokens ?? 0, output: u.output_tokens ?? 0, cache_creation: u.cache_creation_input_tokens ?? 0, cache_read: u.cache_read_input_tokens ?? 0 } }
      } catch (e: any) {
        return echec('cli', String(e?.message ?? e))
      } finally { if (dossier) rmSync(dossier, { recursive: true, force: true }) }
    },
  }
}
