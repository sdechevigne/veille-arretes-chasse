import { describe, it, expect } from 'vitest'
import type { ReponseLecture } from './lecteur.ts'
import { creerLecteurOpencode, extraireJson, MODELES_OPENCODE } from './lecteur-opencode.ts'

const SCHEMA = { $schema: 'https://json-schema.org/draft/2020-12/schema', type: 'object', additionalProperties: false, required: ['a'], properties: { a: { type: 'integer' } } }
const REQ = { modele: 'sonnet' as const, systeme: 'Consigne.', schema: SCHEMA, texte: 'Texte du dossier.' }
const messageDe = (r: ReponseLecture) => (r as { message?: string }).message ?? ''
type Appel = { url: string; init: RequestInit }
type Msg = Record<string, unknown>
// Un tour = ce que produit un envoi de consigne (POST …/prompt) : une réponse HTTP du routeur (refus), les messages
// que la session ajoute jusqu'à son retour au repos, ou « bloque » (la session ne revient jamais au repos).
type Tour = (init: RequestInit) => Response | Promise<Response> | Msg[] | 'bloque'

const assistant = (texte: string, extra: Msg = {}): Msg => ({
  type: 'assistant', agent: 'lecteur', model: { id: 'claude-sonnet-5-5', providerID: 'anthropic', variant: 'default' },
  content: [{ type: 'reasoning', text: 'réflexion' }, { type: 'text', text: texte }], finish: 'stop',
  tokens: { input: 10, output: 20, reasoning: 5, cache: { write: 100, read: 7 } }, ...extra,
})
const repos = (outcome = 'succeeded', error?: Msg): Msg => ({ type: 'idle', outcome, ...(error ? { error } : {}) })
const reussi = (texte: string, extra: Msg = {}): Msg[] => [assistant(texte, extra), repos()]
const echoue = (error: Msg, extra: Msg = {}): Msg[] => [assistant('', { content: [], finish: 'error', error, ...extra }), repos('failed', error)]
const QUOTA = { type: 'provider.rate-limit', message: 'rate_limit_error', status: 429 }

// Faux serveur opencode V2 : enregistre les appels et, comme un vrai fetch, rejette avec `signal.reason` quand le
// signal est annulé. Les messages d'un tour n'apparaissent qu'à l'attente (POST …/wait), comme une exécution réelle.
function fauxOpencode(tours: Tour[], opts: { session?: () => Response; consigne?: () => Response; precoce?: number; html?: (chemin: string) => boolean } = {}) {
  const appels: Appel[] = []
  const messages: Msg[] = []
  let n = 0, id = 0, enCours: Msg[] | 'bloque' | null = null, precoce = opts.precoce ?? 0
  const nouvelId = () => `msg_${String(++id).padStart(4, '0')}`
  const json = (corps: unknown, status = 200) => new Response(JSON.stringify(corps), { status })
  const jamais = () => new Promise<Response>(() => {})
  const f = ((url: string, init: RequestInit) => {
    appels.push({ url, init })
    const chemin = url.replace(/^https?:\/\/[^/]+/, '')
    const reponse = async (): Promise<Response> => {
      // Route disparue : la V2 sert l'application web (HTML, code 200) sur toute route inconnue.
      if (opts.html?.(chemin)) return new Response('<!doctype html><html></html>', { status: 200, headers: { 'content-type': 'text/html' } })
      if (init.method === 'POST' && chemin === '/api/session') return opts.session?.() ?? json({ data: { id: 'ses_test', title: 'veille-arretes' } })
      if (init.method === 'PUT' && chemin.includes('/instructions/entries/')) return opts.consigne?.() ?? new Response(null, { status: 204 })
      if (init.method === 'DELETE') return new Response(null, { status: 204 })
      if (chemin.endsWith('/interrupt')) return json({ data: {} })
      if (chemin.endsWith('/prompt')) {
        const r = await tours[Math.min(n++, tours.length - 1)](init)
        if (r instanceof Response) return r
        const user = nouvelId()
        enCours = r === 'bloque' ? 'bloque' : r
        messages.push({ id: user, type: 'user', text: JSON.parse(String(init.body)).text })
        return json({ data: { id: user, sessionID: 'ses_test', type: 'user', delivery: 'steer' } })
      }
      if (chemin.endsWith('/wait')) {
        // Attente rendue avant le démarrage de l'exécution : aucun message neuf, la session n'est pas encore active.
        if (precoce > 0) { precoce--; return new Response(null, { status: 204 }) }
        if (enCours === 'bloque') return jamais()
        if (enCours) { for (const m of enCours) messages.push({ id: nouvelId(), ...m }); enCours = null }
        return new Response(null, { status: 204 })
      }
      if (chemin.includes('/message?')) return json({ data: [...messages].reverse(), cursor: {} })
      return new Response('route inconnue', { status: 404 })
    }
    const signal = init.signal
    if (!signal) return reponse()
    return new Promise<Response>((resolve, reject) => {
      if (signal.aborted) return reject(signal.reason)
      signal.addEventListener('abort', () => reject(signal.reason))
      reponse().then(resolve, reject)
    })
  }) as unknown as typeof fetch
  return { f, appels, messages }
}
const lecteur = (f: typeof fetch, cfg: Partial<Parameters<typeof creerLecteurOpencode>[0]> = {}) => creerLecteurOpencode({ url: 'http://x', ...cfg }, f)
const prompts = (appels: Appel[]) => appels.filter(a => a.url.endsWith('/prompt'))
const corps = (a: Appel) => JSON.parse(String(a.init.body))

describe('creerLecteurOpencode', () => {
  it('rend la sortie validée, le modèle et les 4 compteurs (réflexion comptée en sortie)', async () => {
    const { f } = fauxOpencode([() => reussi('{"a": 1}')])
    const r = await creerLecteurOpencode({ url: 'http://127.0.0.1:4197' }, f).lire(REQ)
    expect(r).toEqual({ ok: true, sortie: { a: 1 }, modele: 'claude-sonnet-5-5', usage: { input: 10, output: 25, cache_creation: 100, cache_read: 7 } })
  })
  it('session : agent lecteur, modèle anthropic, tout refusé ; consigne + schéma sans $schema en instruction de session ; texte seul en consigne', async () => {
    const { f, appels } = fauxOpencode([() => reussi('{"a": 1}')])
    await creerLecteurOpencode({ url: 'http://127.0.0.1:4197/' }, f).lire({ ...REQ, modele: 'opus' })
    expect(appels[0].url).toBe('http://127.0.0.1:4197/api/session')
    expect(corps(appels[0])).toEqual({ title: 'veille-arretes', agent: 'lecteur', model: { providerID: 'anthropic', id: MODELES_OPENCODE.opus }, permissions: [{ action: '*', resource: '*', effect: 'deny' }] })
    expect(appels[1]).toMatchObject({ url: 'http://127.0.0.1:4197/api/experimental/session/ses_test/instructions/entries/consigne', init: { method: 'PUT' } })
    const consigne: string = corps(appels[1]).value
    expect(consigne).toContain('Consigne.')
    expect(consigne).toContain('"required":["a"]')
    expect(consigne).not.toContain('$schema')
    const p = prompts(appels)
    expect(p).toHaveLength(1)
    expect(p[0].url).toBe('http://127.0.0.1:4197/api/session/ses_test/prompt')
    expect(corps(p[0])).toEqual({ text: 'Texte du dossier.' })
    expect(appels.some(a => a.url === 'http://127.0.0.1:4197/api/experimental/session/ses_test/wait' && a.init.method === 'POST')).toBe(true)
  })
  it('noms de modèles V2 : Sonnet et Opus 5.5', () => {
    expect(MODELES_OPENCODE).toEqual({ sonnet: 'claude-sonnet-5-5', opus: 'claude-opus-5-5' })
  })
  it('joint les images en pièces data:image/png, dans l’ordre, et nomme leurs pages dans le texte', async () => {
    const { f, appels } = fauxOpencode([() => reussi('{"a": 1}')])
    await lecteur(f).lire({ ...REQ, images: [{ page: 3, png: Buffer.from('PNG3') }, { page: 7, png: Buffer.from('PNG7') }] })
    const c = corps(prompts(appels)[0])
    expect(c.files).toEqual([
      { uri: `data:image/png;base64,${Buffer.from('PNG3').toString('base64')}`, name: 'page-3.png' },
      { uri: `data:image/png;base64,${Buffer.from('PNG7').toString('base64')}`, name: 'page-7.png' },
    ])
    expect(c.text.startsWith('Texte du dossier.')).toBe(true)
    expect(c.text).toContain('Images jointes, dans l’ordre : page 3, page 7.')
  })
  it('supprime la session même en cas d’échec', async () => {
    const { f, appels } = fauxOpencode([() => new Response('boum', { status: 500 })])
    await lecteur(f).lire(REQ)
    expect(appels.at(-1)).toMatchObject({ url: 'http://x/api/session/ses_test', init: { method: 'DELETE' } })
  })
  it('authentification Basic (utilisateur opencode) quand un mot de passe est fourni', async () => {
    const { f, appels } = fauxOpencode([() => reussi('{"a": 1}')])
    await lecteur(f, { motDePasse: 'pw' }).lire(REQ)
    for (const a of appels) expect(new Headers(a.init.headers).get('authorization')).toBe(`Basic ${Buffer.from('opencode:pw').toString('base64')}`)
  })
  it('JSON entouré d’un bloc de code accepté ; JSON invalide ou non conforme → schema', async () => {
    expect((await lecteur(fauxOpencode([() => reussi('```json\n{"a": 2}\n```')]).f).lire(REQ)).ok).toBe(true)
    expect(await lecteur(fauxOpencode([() => reussi('pas de json')]).f).lire(REQ)).toMatchObject({ ok: false, erreur: 'schema' })
    expect(await lecteur(fauxOpencode([() => reussi('{"a": "x"}')]).f).lire(REQ)).toMatchObject({ ok: false, erreur: 'schema' })
  })
  it('limite d’usage (statut 429 ou texte de limite) → quota', async () => {
    expect(await lecteur(fauxOpencode([() => echoue(QUOTA)]).f).lire(REQ)).toMatchObject({ ok: false, erreur: 'quota' })
    expect(await lecteur(fauxOpencode([() => echoue({ type: 'provider.unknown', message: 'You have reached your usage limit' })]).f).lire(REQ)).toMatchObject({ ok: false, erreur: 'quota' })
  })
  it('sortie tronquée (finish length) → schema ; autre erreur → cli ; session interrompue sans erreur → cli', async () => {
    expect(await lecteur(fauxOpencode([() => [assistant('{"a"', { finish: 'length' }), repos()]]).f).lire(REQ)).toMatchObject({ ok: false, erreur: 'schema' })
    const autre = await lecteur(fauxOpencode([() => echoue({ type: 'provider.invalid-request', message: 'prefill refusé', status: 400 })]).f).lire(REQ)
    expect(autre).toMatchObject({ ok: false, erreur: 'cli' })
    expect(messageDe(autre)).toContain('prefill refusé')
    expect(await lecteur(fauxOpencode([() => [repos('interrupted')]]).f).lire(REQ)).toMatchObject({ ok: false, erreur: 'cli' })
  })
  it('délai dépassé → timeout ; serveur injoignable → cli ; jamais de rejet', async () => {
    expect(await lecteur(fauxOpencode([() => 'bloque']).f).lire({ ...REQ, delaiMs: 20 })).toMatchObject({ ok: false, erreur: 'timeout' })
    const ko = (async () => { throw new TypeError('fetch failed') }) as unknown as typeof fetch
    expect(await lecteur(ko).lire(REQ)).toMatchObject({ ok: false, erreur: 'cli' })
  })
})

describe('creerLecteurOpencode — attente de la réponse', () => {
  it('attente rendue avant le démarrage de l’exécution → attend de nouveau, puis lit la réponse', async () => {
    const { f, appels } = fauxOpencode([() => reussi('{"a": 1}')], { precoce: 2 })
    expect(await lecteur(f).lire(REQ)).toMatchObject({ ok: true, sortie: { a: 1 } })
    expect(appels.filter(a => a.url.endsWith('/wait')).length).toBeGreaterThanOrEqual(3)
  })
  it('limite d’usage en cours de nouvelle tentative (retry 429, session non revenue au repos) → quota sans attendre le délai, exécution interrompue', async () => {
    const { f, appels, messages } = fauxOpencode([() => 'bloque'])
    const l = lecteur(f, { trancheAttenteMs: 10 })
    const enCours = l.lire({ ...REQ, delaiMs: 60_000 })
    await new Promise(r => setTimeout(r, 5))
    messages.push({ id: 'msg_9000', ...assistant('', { content: [], finish: undefined, tokens: undefined, retry: { attempt: 2, at: 0, error: QUOTA } }) })
    const r = await enCours
    expect(r).toMatchObject({ ok: false, erreur: 'quota' })
    const i = appels.findIndex(a => a.url.endsWith('/interrupt'))
    expect(i).toBeGreaterThan(0)
    expect(appels.at(-1)).toMatchObject({ init: { method: 'DELETE' } })
    expect(i).toBeLessThan(appels.length - 1)
  })
  it('nouvelle tentative pour une autre erreur passagère → continue d’attendre la réponse', async () => {
    let tour = 0
    const { f, messages } = fauxOpencode([() => 'bloque'])
    // La session bloque l'attente : seule la liste des messages fait avancer (1er passage : nouvelle tentative pour
    // surcharge ; 3e passage : réponse valide puis retour au repos).
    const suivi = ((url: string, init: RequestInit) => {
      if (url.includes('/message?')) {
        tour++
        if (tour === 1) messages.push({ id: 'msg_9001', ...assistant('', { content: [], finish: undefined, retry: { attempt: 1, at: 0, error: { type: 'provider.overloaded', message: 'overloaded', status: 529 } } }) })
        if (tour === 3) { messages.pop(); messages.push({ id: 'msg_9001', ...assistant('{"a": 4}') }, { id: 'msg_9002', ...repos() }) }
      }
      return f(url, init)
    }) as unknown as typeof fetch
    const r = await lecteur(suivi, { trancheAttenteMs: 5 }).lire({ ...REQ, delaiMs: 5_000 })
    expect(r).toMatchObject({ ok: true, sortie: { a: 4 } })
    expect(tour).toBeGreaterThanOrEqual(3)
  })
})

describe('creerLecteurOpencode — robustesse', () => {
  it('route de la consigne servie en HTML (route disparue, code 200) → cli explicite, aucun envoi', async () => {
    const { f, appels } = fauxOpencode([() => reussi('{"a": 1}')], { html: c => c.includes('/instructions/entries/') })
    const r = await lecteur(f).lire(REQ)
    expect(r).toMatchObject({ ok: false, erreur: 'cli' })
    expect(messageDe(r)).toContain('route opencode inattendue (HTML) : /api/experimental/session/ses_test/instructions/entries/consigne')
    expect(prompts(appels)).toHaveLength(0)
    expect(appels.at(-1)).toMatchObject({ init: { method: 'DELETE' } })
  })
  it('consigne acceptée avec un autre code que 204 → cli', async () => {
    const { f, appels } = fauxOpencode([() => reussi('{"a": 1}')], { consigne: () => new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }) })
    expect(await lecteur(f).lire(REQ)).toMatchObject({ ok: false, erreur: 'cli' })
    expect(prompts(appels)).toHaveLength(0)
  })
  it('attente servie en HTML (route disparue, code 200) → cli explicite, pas timeout', async () => {
    const { f } = fauxOpencode([() => reussi('{"a": 1}')], { html: c => c.endsWith('/wait') })
    const r = await lecteur(f).lire({ ...REQ, delaiMs: 2_000 })
    expect(r).toMatchObject({ ok: false, erreur: 'cli' })
    expect(messageDe(r)).toContain('route opencode inattendue (HTML) : /api/experimental/session/ses_test/wait')
  })
  it('message de la consigne absent d’une fenêtre pleine de messages → cli explicite, sans attendre le délai', async () => {
    const { f: base } = fauxOpencode([() => reussi('{"a": 1}')])
    const pleine = Array.from({ length: 50 }, (_, i) => ({ id: `msg_x${i}`, type: 'assistant' }))
    const f = ((url: string, init: RequestInit) => url.includes('/message?') ? Promise.resolve(new Response(JSON.stringify({ data: pleine, cursor: {} }), { status: 200 })) : base(url, init)) as unknown as typeof fetch
    const r = await lecteur(f).lire({ ...REQ, delaiMs: 5_000 })
    expect(r).toMatchObject({ ok: false, erreur: 'cli' })
    expect(messageDe(r)).toContain('hors des 50 derniers messages')
  })
  it('délai dépassé pendant l’envoi lui-même → exécution interrompue avant la suppression', async () => {
    const { f, appels } = fauxOpencode([() => new Promise<Response>(() => {})])
    expect(await lecteur(f).lire({ ...REQ, delaiMs: 20 })).toMatchObject({ ok: false, erreur: 'timeout' })
    const i = appels.findIndex(a => a.url.endsWith('/interrupt'))
    expect(i).toBeGreaterThan(0)
    expect(appels.at(-1)).toMatchObject({ init: { method: 'DELETE' } })
  })
  it('délai dépassé pendant la lecture du corps de la liste des messages → timeout (pas cli)', async () => {
    const { f: base, appels } = fauxOpencode([() => reussi('{"a": 1}')])
    const f = ((url: string, init: RequestInit) => {
      if (!url.includes('/message?')) return base(url, init)
      appels.push({ url, init })
      return Promise.resolve(new Response(new ReadableStream({
        start(c) { init.signal?.addEventListener('abort', () => c.error(init.signal!.reason)) },
      }), { status: 200 }))
    }) as unknown as typeof fetch
    expect(await lecteur(f).lire({ ...REQ, delaiMs: 20 })).toMatchObject({ ok: false, erreur: 'timeout' })
    expect(appels.at(-1)).toMatchObject({ init: { method: 'DELETE' } })
  })
  it('échec de création de session (HTTP 500) → cli, aucune suppression tentée', async () => {
    const { f, appels } = fauxOpencode([() => reussi('{"a": 1}')], { session: () => new Response('base indisponible', { status: 500 }) })
    const r = await lecteur(f).lire(REQ)
    expect(r).toMatchObject({ ok: false, erreur: 'cli' })
    expect(messageDe(r)).toContain('HTTP 500')
    expect(appels).toHaveLength(1)
  })
  it('échec de la pose de la consigne (HTTP 400) → cli, session supprimée, aucun envoi', async () => {
    const { f, appels } = fauxOpencode([() => reussi('{"a": 1}')], { consigne: () => new Response('refusée', { status: 400 }) })
    const r = await lecteur(f).lire(REQ)
    expect(r).toMatchObject({ ok: false, erreur: 'cli' })
    expect(messageDe(r)).toContain('HTTP 400')
    expect(prompts(appels)).toHaveLength(0)
    expect(appels.at(-1)).toMatchObject({ init: { method: 'DELETE' } })
  })
  it('gestion de session bornée : création, consigne et suppression ont un signal de délai', async () => {
    const { f, appels } = fauxOpencode([() => reussi('{"a": 1}')])
    await lecteur(f).lire(REQ)
    expect(appels[0].init.signal).toBeDefined()
    expect(appels[1].init.signal).toBeDefined()
    expect(appels.at(-1)!.init.signal).toBeDefined()
  })
  it('statut HTTP 429 à l’envoi → quota ; un « 429 » dans le corps d’une erreur 5xx → cli', async () => {
    expect(await lecteur(fauxOpencode([() => new Response('trop de requêtes', { status: 429 })]).f).lire(REQ)).toMatchObject({ ok: false, erreur: 'quota' })
    expect(await lecteur(fauxOpencode([() => new Response('requête 4290 échouée', { status: 502 })]).f).lire(REQ)).toMatchObject({ ok: false, erreur: 'cli' })
    expect(await lecteur(fauxOpencode([() => new Response('id 429 introuvable', { status: 500 })]).f).lire(REQ)).toMatchObject({ ok: false, erreur: 'cli' })
  })
  it('liste des messages illisible (sans « data ») → cli avec message clair', async () => {
    const { f: base } = fauxOpencode([() => reussi('{"a": 1}')])
    const f = ((url: string, init: RequestInit) => url.includes('/message?') ? Promise.resolve(new Response(JSON.stringify({ messages: [] }), { status: 200 })) : base(url, init)) as unknown as typeof fetch
    const r = await lecteur(f).lire(REQ)
    expect(r).toMatchObject({ ok: false, erreur: 'cli' })
    expect(messageDe(r)).toContain('data')
  })
  it('le mot de passe n’apparaît jamais dans un message d’erreur (corps de réponse ou erreur réseau)', async () => {
    const pw = 'mdp-secret-XYZ-123'
    const echo = await lecteur(fauxOpencode([() => new Response(`refusé pour ${pw}`, { status: 500 })]).f, { motDePasse: pw }).lire(REQ)
    expect(echo).toMatchObject({ ok: false, erreur: 'cli' })
    expect(messageDe(echo)).not.toContain(pw)
    const ko = (async () => { throw new TypeError(`connexion refusée (${pw})`) }) as unknown as typeof fetch
    expect(messageDe(await lecteur(ko, { motDePasse: pw }).lire(REQ))).not.toContain(pw)
  })
})

describe('creerLecteurOpencode — relance corrective unique (R45)', () => {
  const tokens = (input: number) => ({ tokens: { input, output: 2, reasoning: 1, cache: { write: 3, read: 4 } } })

  it('1re réponse hors schéma puis valide → ok, usage additionné, même session, erreur Ajv dans la relance', async () => {
    const { f, appels } = fauxOpencode([() => reussi('{"b": 1}', tokens(10)), () => reussi('{"a": 1}', { ...tokens(20), model: { id: 'claude-sonnet-5-5-bis', providerID: 'anthropic' } })])
    const r = await lecteur(f).lire(REQ)
    expect(r).toEqual({ ok: true, sortie: { a: 1 }, modele: 'claude-sonnet-5-5-bis', usage: { input: 30, output: 6, cache_creation: 6, cache_read: 8 } })
    const p = prompts(appels)
    expect(p).toHaveLength(2)
    expect(p[1].url).toBe(p[0].url)
    expect(appels.filter(a => a.init.method === 'PUT')).toHaveLength(1)
    const texte: string = corps(p[1]).text
    expect(corps(p[1]).files).toBeUndefined()
    expect(texte).toContain('Ta réponse précédente ne respecte pas le schéma JSON demandé : ')
    expect(texte).toContain('required')
    expect(texte).toContain('Renvoie uniquement l\'objet JSON complet et corrigé, conforme au schéma, sans texte autour.')
    expect(appels.filter(a => a.init.method === 'DELETE')).toHaveLength(1)
  })
  it('seules les réponses postérieures à la relance sont lues (pas la 1re réponse)', async () => {
    const { f } = fauxOpencode([() => reussi('{"b": 1}'), () => reussi('{"a": 2}')])
    expect(await lecteur(f).lire(REQ)).toMatchObject({ ok: true, sortie: { a: 2 } })
  })
  it('deux réponses hors schéma → schema (erreurs de la relance), exactement 2 envois', async () => {
    const { f, appels } = fauxOpencode([() => reussi('{"b": 1}'), () => reussi('{"a": "x"}')])
    const r = await lecteur(f).lire(REQ)
    expect(r).toMatchObject({ ok: false, erreur: 'schema' })
    expect(messageDe(r)).toContain('integer')
    expect(prompts(appels)).toHaveLength(2)
    expect(appels.filter(a => a.init.method === 'DELETE')).toHaveLength(1)
  })
  it('1re réponse non JSON puis valide → ok ; l’erreur d’analyse figure dans la relance', async () => {
    const { f, appels } = fauxOpencode([() => reussi('pas de json'), () => reussi('{"a": 1}')])
    expect((await lecteur(f).lire(REQ)).ok).toBe(true)
    expect(corps(prompts(appels)[1]).text).toContain('aucun objet JSON')
  })
  it('les erreurs rapportées dans la relance sont abrégées à 1 000 caractères', async () => {
    const champs = Array.from({ length: 200 }, (_, i) => `champ_${i}`)
    const gros = { ...SCHEMA, required: champs, properties: Object.fromEntries(champs.map(c => [c, { type: 'integer' }])) }
    const { f, appels } = fauxOpencode([() => reussi('{}'), () => reussi('{}')])
    await lecteur(f).lire({ ...REQ, schema: gros })
    const texte: string = corps(prompts(appels)[1]).text
    const debut = 'Ta réponse précédente ne respecte pas le schéma JSON demandé : '
    const erreurs = texte.slice(debut.length, texte.indexOf(' Renvoie uniquement'))
    expect(erreurs.length).toBeGreaterThan(900)
    // 1 000 caractères d'erreurs + le point final inséré juste avant « Renvoie » : 1 001 au plus.
    expect(erreurs.length).toBeLessThanOrEqual(1001)
  })
  it('sortie tronquée → schema SANS relance', async () => {
    const { f, appels } = fauxOpencode([() => [assistant('{"a"', { finish: 'length' }), repos()]])
    expect(await lecteur(f).lire(REQ)).toMatchObject({ ok: false, erreur: 'schema' })
    expect(prompts(appels)).toHaveLength(1)
  })
  it('quota, HTTP 500 et erreur inconnue → pas de relance', async () => {
    for (const [tour, erreur] of [
      [() => echoue(QUOTA), 'quota'],
      [() => new Response('boum', { status: 500 }), 'cli'],
      [() => echoue({ type: 'unknown', message: 'x' }), 'cli'],
    ] as const) {
      const { f, appels } = fauxOpencode([tour])
      expect(await lecteur(f).lire(REQ)).toMatchObject({ ok: false, erreur })
      expect(prompts(appels)).toHaveLength(1)
    }
  })
  it('échec de la relance elle-même (quota) → quota, pas de 3e envoi', async () => {
    const { f, appels } = fauxOpencode([() => reussi('{"b": 1}'), () => echoue(QUOTA)])
    expect(await lecteur(f).lire(REQ)).toMatchObject({ ok: false, erreur: 'quota' })
    expect(prompts(appels)).toHaveLength(2)
  })
  it('délai : les deux envois partagent le MÊME signal (échéance restante, pas un 2e délai plein) ; dépassement → timeout', async () => {
    // Pas d'horloge : AbortSignal.timeout est une minuterie interne de Node, hors de portée de vi.useFakeTimers().
    // Un 2e délai plein donnerait un 2e signal distinct ; l'échéance restante exige l'objet signal identique.
    const signaux: AbortSignal[] = []
    let annuleALaRelance: boolean | undefined
    const { f, appels } = fauxOpencode([
      (init) => { signaux.push(init.signal!); return reussi('{"b": 1}') },
      (init) => { signaux.push(init.signal!); annuleALaRelance = init.signal!.aborted; return 'bloque' },
    ])
    const r = await lecteur(f).lire({ ...REQ, delaiMs: 30 })
    expect(r).toMatchObject({ ok: false, erreur: 'timeout' })
    expect(prompts(appels)).toHaveLength(2)
    expect(signaux).toHaveLength(2)
    expect(signaux[1]).toBe(signaux[0])
    expect(annuleALaRelance).toBe(false) // la relance part avant l'échéance...
    expect(signaux[1].aborted).toBe(true) // ...et c'est ce même signal qui l'interrompt
    expect(appels.at(-1)).toMatchObject({ init: { method: 'DELETE' } })
  })
})

describe('extraireJson', () => {
  it('prend l’objet du premier { au dernier }', () => { expect(extraireJson('Voici :\n{"a": {"b": 1}}\nFin')).toEqual({ a: { b: 1 } }) })
  it('lève sans objet', () => { expect(() => extraireJson('rien')).toThrow() })
})
