import { describe, it, expect } from 'vitest'
import type { ReponseLecture } from './lecteur.ts'
import { creerLecteurOpencode, extraireJson, MODELES_OPENCODE } from './lecteur-opencode.ts'

const SCHEMA = { $schema: 'https://json-schema.org/draft/2020-12/schema', type: 'object', additionalProperties: false, required: ['a'], properties: { a: { type: 'integer' } } }
const REQ = { modele: 'sonnet' as const, systeme: 'Consigne.', schema: SCHEMA, texte: 'Texte du dossier.' }
const messageDe = (r: ReponseLecture) => (r as { message?: string }).message ?? ''
type Appel = { url: string; init: RequestInit }

// Faux fetch : enregistre les appels et, comme un vrai fetch, rejette avec `signal.reason` quand le signal est annulé.
function fauxFetch(reponseMessage: (init: RequestInit) => Response | Promise<Response>, reponseSession: () => Response = () => new Response(JSON.stringify({ id: 'ses_test' }), { status: 200 })) {
  const appels: Appel[] = []
  const f = ((url: string, init: RequestInit) => {
    appels.push({ url, init })
    const reponse = async () => {
      if (init.method === 'POST' && url.endsWith('/session')) return reponseSession()
      if (init.method === 'DELETE') return new Response('true', { status: 200 })
      return reponseMessage(init)
    }
    const signal = init.signal
    if (!signal) return reponse()
    return new Promise<Response>((resolve, reject) => {
      if (signal.aborted) return reject(signal.reason)
      signal.addEventListener('abort', () => reject(signal.reason))
      reponse().then(resolve, reject)
    })
  }) as unknown as typeof fetch
  return { f, appels }
}
const message = (texte: string, extra: Record<string, unknown> = {}) => new Response(JSON.stringify({
  info: { modelID: 'claude-sonnet-5-5', tokens: { input: 10, output: 20, reasoning: 5, cache: { write: 100, read: 7 } }, ...extra },
  parts: [{ type: 'step-start' }, { type: 'text', text: texte }, { type: 'step-finish' }],
}), { status: 200 })

describe('creerLecteurOpencode', () => {
  it('rend la sortie validée, le modèle et les 4 compteurs (réflexion comptée en sortie)', async () => {
    const { f } = fauxFetch(() => message('{"a": 1}'))
    const r = await creerLecteurOpencode({ url: 'http://127.0.0.1:4197' }, f).lire(REQ)
    expect(r).toEqual({ ok: true, sortie: { a: 1 }, modele: 'claude-sonnet-5-5', usage: { input: 10, output: 25, cache_creation: 100, cache_read: 7 } })
  })
  it('envoie agent lecteur, modèle anthropic, consigne + schéma sans $schema, outils coupés', async () => {
    const { f, appels } = fauxFetch(() => message('{"a": 1}'))
    await creerLecteurOpencode({ url: 'http://127.0.0.1:4197' }, f).lire({ ...REQ, modele: 'opus' })
    const corps = JSON.parse(String(appels[1].init.body))
    expect(appels[1].url).toBe('http://127.0.0.1:4197/session/ses_test/message')
    expect(corps.agent).toBe('lecteur')
    expect(corps.model).toEqual({ providerID: 'anthropic', modelID: MODELES_OPENCODE.opus })
    expect(corps.tools).toEqual({ '*': false })
    expect(corps.system).toContain('Consigne.')
    expect(corps.system).toContain('"required":["a"]')
    expect(corps.system).not.toContain('$schema')
    expect(corps.format).toBeUndefined()
    expect(corps.parts[0]).toEqual({ type: 'text', text: 'Texte du dossier.' })
  })
  it('joint les images en parties fichier data:image/png', async () => {
    const { f, appels } = fauxFetch(() => message('{"a": 1}'))
    await creerLecteurOpencode({ url: 'http://x' }, f).lire({ ...REQ, images: [{ page: 3, png: Buffer.from('PNG') }] })
    const parts = JSON.parse(String(appels[1].init.body)).parts
    expect(parts[1]).toEqual({ type: 'text', text: 'Image de la page 3 :' })
    expect(parts[2]).toEqual({ type: 'file', mime: 'image/png', filename: 'page-3.png', url: `data:image/png;base64,${Buffer.from('PNG').toString('base64')}` })
  })
  it('supprime la session même en cas d’échec', async () => {
    const { f, appels } = fauxFetch(() => new Response('boum', { status: 500 }))
    await creerLecteurOpencode({ url: 'http://x' }, f).lire(REQ)
    expect(appels.at(-1)).toMatchObject({ url: 'http://x/session/ses_test', init: { method: 'DELETE' } })
  })
  it('authentification Basic quand un mot de passe est fourni', async () => {
    const { f, appels } = fauxFetch(() => message('{"a": 1}'))
    await creerLecteurOpencode({ url: 'http://x', motDePasse: 'pw' }, f).lire(REQ)
    for (const a of appels) expect(new Headers(a.init.headers).get('authorization')).toBe(`Basic ${Buffer.from('opencode:pw').toString('base64')}`)
  })
  it('JSON entouré d’un bloc de code accepté ; JSON invalide ou non conforme → schema', async () => {
    expect((await creerLecteurOpencode({ url: 'http://x' }, fauxFetch(() => message('```json\n{"a": 2}\n```')).f).lire(REQ)).ok).toBe(true)
    expect(await creerLecteurOpencode({ url: 'http://x' }, fauxFetch(() => message('pas de json')).f).lire(REQ)).toMatchObject({ ok: false, erreur: 'schema' })
    expect(await creerLecteurOpencode({ url: 'http://x' }, fauxFetch(() => message('{"a": "x"}')).f).lire(REQ)).toMatchObject({ ok: false, erreur: 'schema' })
  })
  it('limite d’usage de tous les sièges (APIError 429) → quota', async () => {
    const { f } = fauxFetch(() => message('', { error: { name: 'APIError', data: { message: 'rate_limit_error', statusCode: 429 } } }))
    expect(await creerLecteurOpencode({ url: 'http://x' }, f).lire(REQ)).toMatchObject({ ok: false, erreur: 'quota' })
  })
  it('sortie tronquée (MessageOutputLengthError) → schema ; autre erreur du message → cli', async () => {
    expect(await creerLecteurOpencode({ url: 'http://x' }, fauxFetch(() => message('{"a"', { error: { name: 'MessageOutputLengthError', data: {} } })).f).lire(REQ)).toMatchObject({ ok: false, erreur: 'schema' })
    expect(await creerLecteurOpencode({ url: 'http://x' }, fauxFetch(() => message('', { error: { name: 'UnknownError', data: { message: 'x' } } })).f).lire(REQ)).toMatchObject({ ok: false, erreur: 'cli' })
  })
  it('délai dépassé → timeout ; serveur injoignable → cli ; jamais de rejet', async () => {
    const lent = fauxFetch(() => new Promise<Response>(() => {})).f
    expect(await creerLecteurOpencode({ url: 'http://x' }, lent).lire({ ...REQ, delaiMs: 20 })).toMatchObject({ ok: false, erreur: 'timeout' })
    const ko = (async () => { throw new TypeError('fetch failed') }) as unknown as typeof fetch
    expect(await creerLecteurOpencode({ url: 'http://x' }, ko).lire(REQ)).toMatchObject({ ok: false, erreur: 'cli' })
  })
})

describe('creerLecteurOpencode — robustesse', () => {
  it('délai dépassé pendant la lecture du corps de la réponse → timeout (pas cli)', async () => {
    // Les en-têtes arrivent, mais le corps ne se termine jamais : le flux échoue à l'annulation du signal, comme un vrai fetch.
    const corpsSansFin = (init: RequestInit) => new Response(new ReadableStream({
      start(c) { init.signal?.addEventListener('abort', () => c.error(init.signal!.reason)) },
    }), { status: 200 })
    const { f, appels } = fauxFetch(corpsSansFin)
    expect(await creerLecteurOpencode({ url: 'http://x' }, f).lire({ ...REQ, delaiMs: 20 })).toMatchObject({ ok: false, erreur: 'timeout' })
    expect(appels.at(-1)).toMatchObject({ init: { method: 'DELETE' } })
  })
  it('échec de création de session (HTTP 500) → cli, aucune suppression tentée', async () => {
    const { f, appels } = fauxFetch(() => message('{"a": 1}'), () => new Response('base indisponible', { status: 500 }))
    const r = await creerLecteurOpencode({ url: 'http://x' }, f).lire(REQ)
    expect(r).toMatchObject({ ok: false, erreur: 'cli' })
    expect(messageDe(r)).toContain('HTTP 500')
    expect(appels).toHaveLength(1)
  })
  it('création de session : titre, permission « tout refuser » et signal de délai ; suppression bornée aussi', async () => {
    const { f, appels } = fauxFetch(() => message('{"a": 1}'))
    await creerLecteurOpencode({ url: 'http://x' }, f).lire(REQ)
    expect(JSON.parse(String(appels[0].init.body))).toEqual({ title: 'veille-arretes', permission: [{ permission: '*', pattern: '*', action: 'deny' }] })
    expect(appels[0].init.signal).toBeDefined()
    expect(appels.at(-1)!.init.signal).toBeDefined()
  })
  it('statut HTTP 429 → quota ; un « 429 » dans le corps d’une erreur 5xx → cli', async () => {
    expect(await creerLecteurOpencode({ url: 'http://x' }, fauxFetch(() => new Response('trop de requêtes', { status: 429 })).f).lire(REQ)).toMatchObject({ ok: false, erreur: 'quota' })
    expect(await creerLecteurOpencode({ url: 'http://x' }, fauxFetch(() => new Response('requête 4290 échouée', { status: 502 })).f).lire(REQ)).toMatchObject({ ok: false, erreur: 'cli' })
    expect(await creerLecteurOpencode({ url: 'http://x' }, fauxFetch(() => new Response('id 429 introuvable', { status: 500 })).f).lire(REQ)).toMatchObject({ ok: false, erreur: 'cli' })
  })
  it('réponse sans « info » (ou sans « parts ») → cli avec message clair', async () => {
    const sansInfo = await creerLecteurOpencode({ url: 'http://x' }, fauxFetch(() => new Response(JSON.stringify({ parts: [] }), { status: 200 })).f).lire(REQ)
    expect(sansInfo).toMatchObject({ ok: false, erreur: 'cli' })
    expect(messageDe(sansInfo)).toContain('info')
    expect(await creerLecteurOpencode({ url: 'http://x' }, fauxFetch(() => new Response(JSON.stringify({ info: {} }), { status: 200 })).f).lire(REQ)).toMatchObject({ ok: false, erreur: 'cli' })
  })
  it('le mot de passe n’apparaît jamais dans un message d’erreur (corps de réponse ou erreur réseau)', async () => {
    const pw = 'mdp-secret-XYZ-123'
    const echo = await creerLecteurOpencode({ url: 'http://x', motDePasse: pw }, fauxFetch(() => new Response(`refusé pour ${pw}`, { status: 500 })).f).lire(REQ)
    expect(echo).toMatchObject({ ok: false, erreur: 'cli' })
    expect(messageDe(echo)).not.toContain(pw)
    const ko = (async () => { throw new TypeError(`connexion refusée (${pw})`) }) as unknown as typeof fetch
    const reseau = await creerLecteurOpencode({ url: 'http://x', motDePasse: pw }, ko).lire(REQ)
    expect(messageDe(reseau)).not.toContain(pw)
  })
})

describe('extraireJson', () => {
  it('prend l’objet du premier { au dernier }', () => { expect(extraireJson('Voici :\n{"a": {"b": 1}}\nFin')).toEqual({ a: { b: 1 } }) })
  it('lève sans objet', () => { expect(() => extraireJson('rien')).toThrow() })
})
