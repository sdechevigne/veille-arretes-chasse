// Lecteur Claude par un opencode V2 local (instance isolée de la machine Manta) : la rotation des sièges Claude est
// assurée par le plugin manta-claude-max de cette instance. API de session V2 : la consigne (+ schéma) est une
// instruction de la session, l'envoi (POST …/prompt) est asynchrone, la réponse se lit dans la liste des messages une
// fois la session revenue au repos (message « idle »). Sortie demandée en JSON texte, validée par Ajv. `lire` ne rejette jamais.
import { expurger } from './http.ts'
import { DELAI_LECTURE_MS, schemaSansMeta, validerSortie } from './lecteur.ts'
import type { Lecteur, ReponseLecture, RequeteLecture } from './lecteur.ts'
import type { LectureClaude } from './types.ts'

export const MODELES_OPENCODE = { sonnet: 'claude-sonnet-5-5', opus: 'claude-opus-5-5' } as const
// `trancheAttenteMs` : durée maximale d'une attente bloquante (POST …/wait) avant de relire les messages, pour repérer
// une limite d'usage pendant les nouvelles tentatives d'opencode sans attendre la fin du délai de lecture.
export interface ConfigOpencode { url: string; motDePasse?: string; trancheAttenteMs?: number }

const COURT = 500
const abreger = (t: string) => (t.length > COURT ? `${t.slice(0, COURT)}…` : t)
// Texte d'une erreur rendue par l'API Anthropic ; un statut HTTP se teste sur le champ `status`, jamais sur un corps de réponse.
const estQuota = (t: string) => /rate.?limit|usage limit|\b429\b/i.test(t)
const estDelai = (e: any) => e?.name === 'TimeoutError' || e?.name === 'AbortError'
// Délai fixe des appels de gestion de session (création, consigne, interruption, suppression) : un serveur figé ne doit pas bloquer `lire`.
const DELAI_SESSION_MS = 15_000
const TRANCHE_ATTENTE_MS = 15_000
// Pause avant une nouvelle attente quand la session n'a pas encore démarré l'exécution (l'attente rend alors aussitôt).
const PAUSE_ATTENTE_MS = 250
// Messages relus à chaque tour : ceux qui suivent la consigne envoyée (une réponse, un repos) tiennent largement dedans.
const MESSAGES_LUS = 50
// Longueur maximale des erreurs de schéma renvoyées au modèle dans la relance corrective.
const ERREURS_RELANCE_MAX = 1_000
type Usage = { input: number; output: number; cache_creation: number; cache_read: number }
type Erreur = { type?: string; message?: string; status?: number }
type Message = { id?: string; type?: string; content?: { type: string; text?: string }[]; model?: { id?: string }; finish?: string; tokens?: any; error?: Erreur; retry?: { error?: Erreur }; outcome?: string }
// Résultat d'un envoi de consigne : échec terminal (pas de relance), sortie valide, ou sortie hors schéma (relançable).
type Envoi = { echec: ReponseLecture } | { modele: string; usage: Usage; sortie: unknown } | { modele: string; usage: Usage; invalide: string }

export function extraireJson(texte: string): unknown {
  const debut = texte.indexOf('{'), fin = texte.lastIndexOf('}')
  if (debut < 0 || fin <= debut) throw new Error('aucun objet JSON dans la réponse')
  return JSON.parse(texte.slice(debut, fin + 1))
}

function consigneSysteme(req: RequeteLecture): string {
  return `${req.systeme}\n\n## Format de sortie\nRéponds UNIQUEMENT par un objet JSON conforme au schéma JSON ci-dessous : aucun texte avant ni après, aucun bloc de code.\n${JSON.stringify(schemaSansMeta(req.schema))}`
}

// Les pièces jointes arrivent au modèle sans leur nom : les pages des images sont donc annoncées dans le texte, dans l'ordre des pièces.
function premiereConsigne(req: RequeteLecture): { text: string; files?: { uri: string; name: string }[] } {
  const images = req.images ?? []
  if (images.length === 0) return { text: req.texte }
  return {
    text: `${req.texte}\n\nImages jointes, dans l’ordre : ${images.map(im => `page ${im.page}`).join(', ')}.`,
    files: images.map(im => ({ uri: `data:image/png;base64,${im.png.toString('base64')}`, name: `page-${im.page}.png` })),
  }
}

const pause = (ms: number, signal: AbortSignal) => new Promise<void>((resolve, reject) => {
  if (signal.aborted) return reject(signal.reason)
  const t = setTimeout(() => { signal.removeEventListener('abort', annuler); resolve() }, ms)
  const annuler = () => { clearTimeout(t); reject(signal.reason) }
  signal.addEventListener('abort', annuler, { once: true })
})

export function creerLecteurOpencode(cfg: ConfigOpencode, fetchImpl: typeof fetch = fetch): Lecteur {
  const base = cfg.url.replace(/\/+$/, '')
  const tranche = cfg.trancheAttenteMs ?? TRANCHE_ATTENTE_MS
  const entetes: Record<string, string> = { 'content-type': 'application/json' }
  if (cfg.motDePasse) entetes.authorization = `Basic ${Buffer.from(`opencode:${cfg.motDePasse}`).toString('base64')}`
  const echec = (erreur: 'quota' | 'schema' | 'timeout' | 'cli', message: string): ReponseLecture =>
    ({ ok: false, erreur, message: abreger(expurger(message.trim(), undefined, cfg.motDePasse)) })
  const echecErreur = (e: Erreur): ReponseLecture => {
    const texte = `${e.type ?? 'erreur'} ${e.message ?? ''}`
    return e.status === 429 || estQuota(texte) ? echec('quota', texte) : echec('cli', texte)
  }
  // Une route disparue (API V2 encore expérimentale par endroits) n'échoue pas : opencode y sert son application web
  // (HTML, code 200). Toute réponse HTML est donc refusée, quelle que soit la route.
  const appeler = async (chemin: string, init: RequestInit) => {
    const r = await fetchImpl(`${base}${chemin}`, { ...init, headers: entetes })
    if (/text\/html/i.test(r.headers.get('content-type') ?? '')) throw new Error(`route opencode inattendue (HTML) : ${chemin.split('?')[0]}`)
    return r
  }

  return {
    async lire(req) {
      const delaiMs = req.delaiMs ?? DELAI_LECTURE_MS
      let session: string | undefined
      let auRepos = true
      let etape = 'création de session'
      try {
        const s = await appeler('/api/session', { method: 'POST', body: JSON.stringify({ title: 'veille-arretes', agent: 'lecteur', model: { providerID: 'anthropic', id: MODELES_OPENCODE[req.modele] }, permissions: [{ action: '*', resource: '*', effect: 'deny' }] }), signal: AbortSignal.timeout(DELAI_SESSION_MS) })
        if (!s.ok) return echec('cli', `création de session : HTTP ${s.status} ${await s.text()}`)
        session = (await s.json() as { data: { id: string } }).data.id
        etape = 'pose de la consigne'
        const c = await appeler(`/api/experimental/session/${session}/instructions/entries/consigne`, { method: 'PUT', body: JSON.stringify({ value: consigneSysteme(req) }), signal: AbortSignal.timeout(DELAI_SESSION_MS) })
        // Code exact relevé sur la V2 : tout autre succès laisserait douter que la consigne (et le schéma) soient posés.
        if (c.status !== 204) return echec('cli', `pose de la consigne : HTTP ${c.status} ${await c.text()}`)
        etape = 'lecture'
        // Un seul signal pour les deux envois possibles (lecture + relance corrective) : `delaiMs` couvre l'ensemble, la relance n'a que l'échéance restante.
        // Il couvre aussi la lecture des corps : un signal expiré pendant `text()` est rapporté par le `catch` ci-dessous.
        const signal = AbortSignal.timeout(delaiMs)

        // Messages postérieurs à la consigne `idConsigne`, du plus ancien au plus récent ; null si elle n'est pas encore enregistrée.
        const messagesApres = async (idConsigne: string): Promise<Message[] | null> => {
          const r = await appeler(`/api/session/${session}/message?order=desc&limit=${MESSAGES_LUS}`, { method: 'GET', signal })
          const brut = await r.text()
          if (!r.ok) throw new Error(`liste des messages : HTTP ${r.status} ${brut}`)
          const liste = (JSON.parse(brut) as { data?: Message[] }).data
          if (!Array.isArray(liste)) throw new Error('liste des messages opencode sans « data »')
          const i = liste.findIndex(m => m.id === idConsigne)
          // Absent d'une page incomplète : pas encore enregistré. Absent d'une page pleine : hors de portée, attendre ne servirait à rien.
          if (i < 0 && liste.length >= MESSAGES_LUS) throw new Error(`message de la consigne hors des ${MESSAGES_LUS} derniers messages de la session`)
          return i < 0 ? null : liste.slice(0, i).reverse()
        }

        const envoi = async (consigne: { text: string; files?: object[] }): Promise<Envoi> => {
          // Dès l'envoi, une exécution peut avoir démarré : un délai dépassé pendant l'envoi doit aussi l'interrompre.
          auRepos = false
          const r = await appeler(`/api/session/${session}/prompt`, { method: 'POST', body: JSON.stringify(consigne), signal })
          const brut = await r.text()
          if (!r.ok) return { echec: echec(r.status === 429 ? 'quota' : 'cli', `HTTP ${r.status} ${brut}`) }
          const idConsigne = (JSON.parse(brut) as { data?: { id?: string } }).data?.id
          if (!idConsigne) return { echec: echec('cli', 'envoi accepté sans identifiant de message') }
          let suite: Message[]
          for (;;) {
            // Attente bloquante par tranches : entre deux tranches, une limite d'usage en cours de nouvelle tentative est repérée tout de suite.
            const w = await appeler(`/api/experimental/session/${session}/wait`, { method: 'POST', signal: AbortSignal.any([signal, AbortSignal.timeout(tranche)]) })
              .catch((e) => { if (signal.aborted || !estDelai(e)) throw e; return null })
            if (w && w.status !== 204) return { echec: echec('cli', `attente de la réponse : HTTP ${w.status} ${await w.text()}`) }
            const apres = await messagesApres(idConsigne)
            if (apres?.some(m => m.type === 'idle')) { suite = apres; break }
            const tentative = apres?.filter(m => m.type === 'assistant').at(-1)?.retry?.error
            if (tentative && (tentative.status === 429 || estQuota(`${tentative.type ?? ''} ${tentative.message ?? ''}`))) return { echec: echecErreur(tentative) }
            if (w) await pause(PAUSE_ATTENTE_MS, signal)
          }
          auRepos = true
          const repos = suite.find(m => m.type === 'idle')!
          const reponses = suite.filter(m => m.type === 'assistant')
          const derniere = reponses.at(-1)
          const err = derniere?.error ?? repos.error
          if (err) return { echec: echecErreur(err) }
          if (repos.outcome !== 'succeeded' || !derniere) return { echec: echec('cli', `session terminée sans réponse (${repos.outcome ?? 'issue inconnue'})`) }
          if (derniere.finish === 'length') return { echec: echec('schema', 'sortie tronquée (longueur maximale atteinte)') }
          const usage = { input: 0, output: 0, cache_creation: 0, cache_read: 0 }
          for (const m of reponses) {
            const t = m.tokens ?? {}
            usage.input += t.input ?? 0; usage.output += (t.output ?? 0) + (t.reasoning ?? 0)
            usage.cache_creation += t.cache?.write ?? 0; usage.cache_read += t.cache?.read ?? 0
          }
          const texte = (derniere.content ?? []).filter(p => p.type === 'text').map(p => p.text ?? '').join('\n')
          const modele = typeof derniere.model?.id === 'string' ? derniere.model.id : MODELES_OPENCODE[req.modele]
          let sortie: unknown
          try { sortie = extraireJson(texte) } catch (e: any) { return { modele, usage, invalide: `réponse non JSON : ${e?.message ?? e}` } }
          const invalide = validerSortie(req.schema, sortie)
          return invalide ? { modele, usage, invalide } : { modele, usage, sortie }
        }

        const premier = await envoi(premiereConsigne(req))
        if ('echec' in premier) return premier.echec
        if (!('invalide' in premier)) return { ok: true, sortie: premier.sortie as LectureClaude, modele: premier.modele, usage: premier.usage }
        // Sortie hors schéma : UNE relance corrective dans la même session (jamais plus), les erreurs en retour.
        const second = await envoi({ text: `Ta réponse précédente ne respecte pas le schéma JSON demandé : ${premier.invalide.slice(0, ERREURS_RELANCE_MAX)}. Renvoie uniquement l'objet JSON complet et corrigé, conforme au schéma, sans texte autour.` })
        if ('echec' in second) return second.echec
        if ('invalide' in second) return echec('schema', second.invalide)
        const [u1, u2] = [premier.usage, second.usage]
        return { ok: true, sortie: second.sortie as LectureClaude, modele: second.modele,
          usage: { input: u1.input + u2.input, output: u1.output + u2.output, cache_creation: u1.cache_creation + u2.cache_creation, cache_read: u1.cache_read + u2.cache_read } }
      } catch (e: any) {
        if (estDelai(e)) return echec('timeout', etape === 'lecture' ? `délai de ${delaiMs} ms dépassé` : `délai de ${DELAI_SESSION_MS} ms dépassé (${etape})`)
        return echec('cli', String(e?.message ?? e))
      } finally {
        if (session) {
          // Exécution peut-être encore en cours (délai, limite d'usage) : interrompue avant la suppression, sans quoi Claude continuerait de répondre.
          if (!auRepos) await appeler(`/api/session/${session}/interrupt`, { method: 'POST', signal: AbortSignal.timeout(DELAI_SESSION_MS) }).catch(() => { /* suppression tentée quand même */ })
          await appeler(`/api/session/${session}`, { method: 'DELETE', signal: AbortSignal.timeout(DELAI_SESSION_MS) }).catch(() => { /* session orpheline : sans conséquence, base locale de l'instance isolée */ })
        }
      }
    },
  }
}
