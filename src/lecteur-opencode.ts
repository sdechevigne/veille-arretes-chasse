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
// Texte d'une erreur de message (rendue par l'API Anthropic) ; un statut HTTP se teste sur `r.status`, jamais sur un corps de réponse.
const estQuota = (t: string) => /rate.?limit|usage limit|\b429\b/i.test(t)
const estDelai = (e: any) => e?.name === 'TimeoutError' || e?.name === 'AbortError'
// Délai fixe des appels de gestion de session (création, suppression) : un serveur figé ne doit pas bloquer `lire`.
const DELAI_SESSION_MS = 15_000
// Longueur maximale des erreurs de schéma renvoyées au modèle dans la relance corrective.
const ERREURS_RELANCE_MAX = 1_000
type Usage = { input: number; output: number; cache_creation: number; cache_read: number }
// Résultat d'un envoi de message : échec terminal (pas de relance), sortie valide, ou sortie hors schéma (relançable).
type Envoi = { echec: ReponseLecture } | { modele: string; usage: Usage; sortie: unknown } | { modele: string; usage: Usage; invalide: string }

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
      let etape = 'création de session'
      try {
        const s = await appeler('/session', { method: 'POST', body: JSON.stringify({ title: 'veille-arretes', permission: [{ permission: '*', pattern: '*', action: 'deny' }] }), signal: AbortSignal.timeout(DELAI_SESSION_MS) })
        if (!s.ok) return echec('cli', `création de session : HTTP ${s.status} ${await s.text()}`)
        session = (await s.json() as { id: string }).id
        const corps = { agent: 'lecteur', model: { providerID: 'anthropic', modelID: MODELES_OPENCODE[req.modele] }, system: consigneSysteme(req), tools: { '*': false }, parts: parties(req) }
        etape = 'lecture'
        // Un seul signal pour les deux envois possibles (lecture + relance corrective) : `delaiMs` couvre l'ensemble, la relance n'a que l'échéance restante.
        // Il couvre aussi la lecture du corps : un signal expiré pendant `text()` est rapporté par le `catch` ci-dessous.
        const signal = AbortSignal.timeout(delaiMs)
        const envoi = async (parts: object[]): Promise<Envoi> => {
          const r = await appeler(`/session/${session}/message`, { method: 'POST', body: JSON.stringify({ ...corps, parts }), signal })
          const brut = await r.text()
          if (!r.ok) return { echec: echec(r.status === 429 ? 'quota' : 'cli', `HTTP ${r.status} ${brut}`) }
          const rep = JSON.parse(brut) as { info?: any; parts?: { type: string; text?: string; synthetic?: boolean }[] }
          if (!rep.info || !Array.isArray(rep.parts)) return { echec: echec('cli', 'réponse opencode sans « info » ou sans « parts »') }
          const err = rep.info.error
          if (err) {
            const texte = `${err.name} ${err.data?.message ?? ''}`
            if (err.data?.statusCode === 429 || estQuota(texte)) return { echec: echec('quota', texte) }
            if (err.name === 'MessageOutputLengthError') return { echec: echec('schema', 'sortie tronquée (longueur maximale atteinte)') }
            return { echec: echec('cli', texte) }
          }
          const texte = rep.parts.filter(p => p.type === 'text' && !p.synthetic).map(p => p.text ?? '').join('\n')
          const t = rep.info.tokens ?? {}
          const usage = { input: t.input ?? 0, output: (t.output ?? 0) + (t.reasoning ?? 0), cache_creation: t.cache?.write ?? 0, cache_read: t.cache?.read ?? 0 }
          const modele = typeof rep.info.modelID === 'string' ? rep.info.modelID : MODELES_OPENCODE[req.modele]
          let sortie: unknown
          try { sortie = extraireJson(texte) } catch (e: any) { return { modele, usage, invalide: `réponse non JSON : ${e?.message ?? e}` } }
          const invalide = validerSortie(req.schema, sortie)
          return invalide ? { modele, usage, invalide } : { modele, usage, sortie }
        }
        const premier = await envoi(corps.parts)
        if ('echec' in premier) return premier.echec
        if (!('invalide' in premier)) return { ok: true, sortie: premier.sortie as LectureClaude, modele: premier.modele, usage: premier.usage }
        // Sortie hors schéma : UNE relance corrective dans la même session (jamais plus), les erreurs en retour.
        const second = await envoi([{ type: 'text', text: `Ta réponse précédente ne respecte pas le schéma JSON demandé : ${premier.invalide.slice(0, ERREURS_RELANCE_MAX)}. Renvoie uniquement l'objet JSON complet et corrigé, conforme au schéma, sans texte autour.` }])
        if ('echec' in second) return second.echec
        if ('invalide' in second) return echec('schema', second.invalide)
        const [u1, u2] = [premier.usage, second.usage]
        return { ok: true, sortie: second.sortie as LectureClaude, modele: second.modele,
          usage: { input: u1.input + u2.input, output: u1.output + u2.output, cache_creation: u1.cache_creation + u2.cache_creation, cache_read: u1.cache_read + u2.cache_read } }
      } catch (e: any) {
        if (estDelai(e)) return echec('timeout', etape === 'lecture' ? `délai de ${delaiMs} ms dépassé` : `délai de ${DELAI_SESSION_MS} ms dépassé (${etape})`)
        return echec('cli', String(e?.message ?? e))
      } finally {
        if (session) await appeler(`/session/${session}`, { method: 'DELETE', signal: AbortSignal.timeout(DELAI_SESSION_MS) }).catch(() => { /* session orpheline : sans conséquence, base locale de l'instance isolée */ })
      }
    },
  }
}
