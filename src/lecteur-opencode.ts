// Lecteur Claude par un opencode local (instance isolée de la machine Manta) : la rotation des sièges Claude est
// assurée par le plugin manta-accounts de cette instance. Sortie demandée en JSON texte (la sortie structurée native
// d'opencode force un tool_choice refusé par claude-sonnet-5-5), puis validée par Ajv. `lire` ne rejette jamais.
import { expurger } from './http.ts'
import { DELAI_LECTURE_MS, schemaSansMeta, validerSortie } from './lecteur.ts'
import type { Lecteur, ReponseLecture, RequeteLecture } from './lecteur.ts'
import type { LectureClaude } from './types.ts'

export const MODELES_OPENCODE = { sonnet: 'claude-sonnet-5-5', opus: 'claude-opus-5-5' } as const
export interface ConfigOpencode { url: string; motDePasse?: string }

const COURT = 500
const abreger = (t: string) => (t.length > COURT ? `${t.slice(0, COURT)}…` : t)
const estQuota = (t: string) => /rate.?limit|usage limit|\b429\b/i.test(t)

export function extraireJson(texte: string): unknown {
  const debut = texte.indexOf('{'), fin = texte.lastIndexOf('}')
  if (debut < 0 || fin <= debut) throw new Error('aucun objet JSON dans la réponse')
  return JSON.parse(texte.slice(debut, fin + 1))
}

function consigneSysteme(req: RequeteLecture): string {
  return `${req.systeme}\n\n## Format de sortie\nRéponds UNIQUEMENT par un objet JSON conforme au schéma JSON ci-dessous : aucun texte avant ni après, aucun bloc de code.\n${JSON.stringify(schemaSansMeta(req.schema))}`
}

function parties(req: RequeteLecture): object[] {
  const p: object[] = [{ type: 'text', text: req.texte }]
  for (const im of req.images ?? []) {
    p.push({ type: 'text', text: `Image de la page ${im.page} :` })
    p.push({ type: 'file', mime: 'image/png', filename: `page-${im.page}.png`, url: `data:image/png;base64,${im.png.toString('base64')}` })
  }
  return p
}

export function creerLecteurOpencode(cfg: ConfigOpencode, fetchImpl: typeof fetch = fetch): Lecteur {
  const base = cfg.url.replace(/\/+$/, '')
  const entetes: Record<string, string> = { 'content-type': 'application/json' }
  if (cfg.motDePasse) entetes.authorization = `Basic ${Buffer.from(`opencode:${cfg.motDePasse}`).toString('base64')}`
  const echec = (erreur: 'quota' | 'schema' | 'timeout' | 'cli', message: string): ReponseLecture =>
    ({ ok: false, erreur, message: abreger(expurger(message.trim(), undefined, cfg.motDePasse)) })
  const appeler = (chemin: string, init: RequestInit) => fetchImpl(`${base}${chemin}`, { ...init, headers: entetes })

  return {
    async lire(req) {
      const delaiMs = req.delaiMs ?? DELAI_LECTURE_MS
      let session: string | undefined
      try {
        const s = await appeler('/session', { method: 'POST', body: JSON.stringify({ title: 'veille-arretes', permission: [{ permission: '*', pattern: '*', action: 'deny' }] }) })
        if (!s.ok) return echec('cli', `création de session : HTTP ${s.status} ${await s.text()}`)
        session = (await s.json() as { id: string }).id
        const corps = { agent: 'lecteur', model: { providerID: 'anthropic', modelID: MODELES_OPENCODE[req.modele] }, system: consigneSysteme(req), tools: { '*': false }, parts: parties(req) }
        let r: Response
        try { r = await appeler(`/session/${session}/message`, { method: 'POST', body: JSON.stringify(corps), signal: AbortSignal.timeout(delaiMs) }) } catch (e: any) {
          if (e?.name === 'TimeoutError' || e?.name === 'AbortError') return echec('timeout', `délai de ${delaiMs} ms dépassé`)
          return echec('cli', String(e?.message ?? e))
        }
        const brut = await r.text()
        if (!r.ok) return echec(estQuota(brut) ? 'quota' : 'cli', `HTTP ${r.status} ${brut}`)
        const rep = JSON.parse(brut) as { info: any; parts: { type: string; text?: string; synthetic?: boolean }[] }
        const err = rep.info?.error
        if (err) {
          const texte = `${err.name} ${err.data?.message ?? ''}`
          if (err.data?.statusCode === 429 || estQuota(texte)) return echec('quota', texte)
          if (err.name === 'MessageOutputLengthError') return echec('schema', 'sortie tronquée (longueur maximale atteinte)')
          return echec('cli', texte)
        }
        const texte = rep.parts.filter(p => p.type === 'text' && !p.synthetic).map(p => p.text ?? '').join('\n')
        let sortie: unknown
        try { sortie = extraireJson(texte) } catch (e: any) { return echec('schema', `réponse non JSON : ${e?.message ?? e}`) }
        const invalide = validerSortie(req.schema, sortie)
        if (invalide) return echec('schema', invalide)
        const t = rep.info.tokens ?? {}
        return { ok: true, sortie: sortie as LectureClaude, modele: typeof rep.info.modelID === 'string' ? rep.info.modelID : MODELES_OPENCODE[req.modele],
          usage: { input: t.input ?? 0, output: (t.output ?? 0) + (t.reasoning ?? 0), cache_creation: t.cache?.write ?? 0, cache_read: t.cache?.read ?? 0 } }
      } catch (e: any) {
        return echec('cli', String(e?.message ?? e))
      } finally {
        if (session) await appeler(`/session/${session}`, { method: 'DELETE' }).catch(() => { /* session orpheline : sans conséquence, base locale de l'instance isolée */ })
      }
    },
  }
}
