// Lecteur Claude : lance la CLI `claude -p` (abonnement, jeton OAuth) avec une sortie JSON imposée par schéma.
// Le jeton ne transite que par l'environnement du processus fils ; le prompt système passe par un fichier 0600 supprimé ensuite.
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import Ajv2020 from 'ajv/dist/2020.js'
import type { ValidateFunction } from 'ajv/dist/2020.js'
import { expurger } from './http.ts'
import type { LectureClaude } from './types.ts'

export interface RequeteLecture { modele: 'sonnet' | 'opus'; systeme: string; schema: object; texte: string; images?: { page: number; png: Buffer }[]; delaiMs?: number }
export interface UsageClaude { input: number; output: number; cache_creation: number; cache_read: number }
export type ReponseLecture =
  | { ok: true; sortie: LectureClaude; usage: UsageClaude; modele: string }
  | { ok: false; erreur: 'quota' | 'schema' | 'timeout' | 'cli'; message: string }
export interface Lecteur { lire(req: RequeteLecture): Promise<ReponseLecture> }

// Distinct de `Exec` de http.ts (curl) : ici stdin, environnement et délai.
export type ExecClaude = (args: string[], stdin: string, env: Record<string, string>, delaiMs: number) => Promise<{ code: number; stdout: string; stderr: string }>

export const DELAI_LECTURE_MS = 240_000

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
  p.on('error', e => terminer(() => resolve({ code: 1, stdout: out, stderr: String(e) })))
  p.on('close', code => terminer(() => resolve({ code: code ?? 1, stdout: out, stderr: err })))
  p.stdin.on('error', () => { /* le processus a pu se terminer avant la fin de l'écriture : « close » rapporte le résultat */ })
  p.stdin.end(stdin)
})

const ajv = new Ajv2020({ allErrors: true, strict: false })
const validateurs = new WeakMap<object, ValidateFunction>()
function validateur(schema: object): ValidateFunction {
  let v = validateurs.get(schema); if (!v) { v = ajv.compile(schema); validateurs.set(schema, v) }
  return v
}

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

export function creerLecteurClaude(token: string, exec: ExecClaude = execClaude): Lecteur {
  const echec = (erreur: 'quota' | 'schema' | 'timeout' | 'cli', message: string): ReponseLecture => ({ ok: false, erreur, message: abreger(expurger(message.trim(), undefined, token)) })
  return {
    async lire(req) {
      const delaiMs = req.delaiMs ?? DELAI_LECTURE_MS
      const dossier = mkdtempSync(join(tmpdir(), 'veille-claude-'))
      try {
        const fichier = join(dossier, 'systeme.md')
        writeFileSync(fichier, req.systeme, { mode: 0o600 })
        const args = ['-p', '--model', req.modele, '--system-prompt-file', fichier, '--tools', '', '--strict-mcp-config', '--setting-sources', '', '--no-session-persistence',
          '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--json-schema', JSON.stringify(req.schema)]
        const env = { ...Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => e[1] !== undefined)), CLAUDE_CODE_OAUTH_TOKEN: token }
        let r: { code: number; stdout: string; stderr: string }
        try { r = await exec(args, messageUtilisateur(req), env, delaiMs) } catch (e) {
          if (e instanceof DelaiDepasse || /délai|timeout|timed out/i.test((e as Error).message)) return echec('timeout', `délai de ${delaiMs} ms dépassé`)
          return echec('cli', (e as Error).message)
        }
        const res = ligneResultat(r.stdout)
        if (res?.is_error) {
          const texte = [res.result, res.error, res.subtype].filter(t => typeof t === 'string').join(' ')
          if (estQuota(texte + ' ' + r.stderr)) return echec('quota', texte || r.stderr)
          if (/structured_output/i.test(String(res.subtype))) return echec('schema', `sortie structurée refusée par la CLI : ${res.subtype}`)
          return echec('cli', texte || r.stderr || `is_error (code ${r.code})`)
        }
        if (r.code !== 0) return echec('cli', r.stderr.trim() || `code de sortie ${r.code}`)
        if (!res) return echec('cli', 'aucune ligne « result » dans la sortie de la CLI')
        const sortie = res.structured_output
        if (sortie === undefined || sortie === null) return echec('schema', 'structured_output absent')
        const valide = validateur(req.schema)
        if (!valide(sortie)) return echec('schema', ajv.errorsText(valide.errors, { separator: ' ; ', dataVar: 'sortie' }))
        const u = res.usage ?? {}
        return { ok: true, sortie: sortie as LectureClaude, modele: typeof res.model === 'string' ? res.model : req.modele,
          usage: { input: u.input_tokens ?? 0, output: u.output_tokens ?? 0, cache_creation: u.cache_creation_input_tokens ?? 0, cache_read: u.cache_read_input_tokens ?? 0 } }
      } finally { rmSync(dossier, { recursive: true, force: true }) }
    },
  }
}

// Double en mémoire pour les tests : rend les réponses dans l'ordre et mémorise les requêtes reçues.
export function creerLecteurMemoire(reponses: ReponseLecture[]): Lecteur & { requetes: RequeteLecture[] } {
  const file = [...reponses]; const requetes: RequeteLecture[] = []
  return { requetes, async lire(req) { requetes.push(req); const r = file.shift(); if (!r) throw new Error('lecteur mémoire : plus de réponse prévue'); return r } }
}
