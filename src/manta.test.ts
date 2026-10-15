import { describe, it, expect, vi, afterEach } from 'vitest'
import { createHmac } from 'node:crypto'
import { notifierManta, textePropositions } from './manta.ts'

const CFG = { url: 'https://hook.exemple.test/hook/jeton-secret', secret: 'secret-de-signature' }
const CORPS = { type: 'propositions' as const, texte: 'Veille arrêtés : 1 proposition(s) à vérifier, 0 publiée(s)', donnees: { enAttente: 1 } }

afterEach(() => { vi.restoreAllMocks() })

describe('notifierManta', () => {
  it('poste le corps JSON signé HMAC-SHA256 (hex) sur le corps brut', async () => {
    const appels: { url: string; init: RequestInit }[] = []
    const fetchImpl = (async (url: string, init: RequestInit) => { appels.push({ url, init }); return new Response('ok', { status: 200 }) }) as unknown as typeof fetch
    await notifierManta(CFG, CORPS, fetchImpl)
    expect(appels).toHaveLength(1)
    const { url, init } = appels[0]
    expect(url).toBe(CFG.url)
    expect(init.method).toBe('POST')
    const brut = init.body as string
    expect(JSON.parse(brut)).toEqual(CORPS)
    const entetes = new Headers(init.headers)
    expect(entetes.get('content-type')).toBe('application/json')
    expect(entetes.get('x-manta-signature')).toBe(`sha256=${createHmac('sha256', CFG.secret).update(brut).digest('hex')}`)
  })

  it('avale un échec réseau : aucune exception, message expurgé sur stderr', async () => {
    const erreurs: string[] = []
    vi.spyOn(console, 'error').mockImplementation((m: unknown) => { erreurs.push(String(m)) })
    const fetchImpl = (async () => { throw new Error(`connexion refusée vers ${CFG.url} (${CFG.secret})`) }) as unknown as typeof fetch
    await expect(notifierManta(CFG, CORPS, fetchImpl)).resolves.toBeUndefined()
    expect(erreurs).toHaveLength(1)
    expect(erreurs[0]).toContain('connexion refusée')
    expect(erreurs[0]).not.toContain(CFG.url)
    expect(erreurs[0]).not.toContain(CFG.secret)
  })

  it('avale une réponse HTTP en erreur', async () => {
    const erreurs: string[] = []
    vi.spyOn(console, 'error').mockImplementation((m: unknown) => { erreurs.push(String(m)) })
    const fetchImpl = (async () => new Response('non', { status: 401 })) as unknown as typeof fetch
    await expect(notifierManta(CFG, CORPS, fetchImpl)).resolves.toBeUndefined()
    expect(erreurs[0]).toContain('401')
  })
})

describe('textePropositions', () => {
  it('compte les propositions à vérifier et publiées (avec note)', () => {
    expect(textePropositions({ enAttente: 2, publie: 1, publieNote: 2, arretQuota: false })).toBe('Veille arrêtés : 2 proposition(s) à vérifier, 3 publiée(s)')
  })
  it('signale les documents sans lecture automatique (en attente d’un opérateur)', () => {
    expect(textePropositions({ enAttente: 0, publie: 0, publieNote: 0, sansLecture: 2, arretQuota: false }))
      .toBe('Veille arrêtés : 0 proposition(s) à vérifier, 0 publiée(s), 2 document(s) sans lecture automatique à traiter à la main')
    expect(textePropositions({ enAttente: 1, publie: 1, publieNote: 0, sansLecture: 1, arretQuota: true, restantsALire: 3 }))
      .toBe('Veille arrêtés : 1 proposition(s) à vérifier, 1 publiée(s), 1 document(s) sans lecture automatique à traiter à la main [quota Claude atteint, reste 3 documents]')
  })
  it('signale le quota et le reste quand il est connu', () => {
    expect(textePropositions({ enAttente: 0, publie: 4, publieNote: 0, arretQuota: true, restantsALire: 12 }))
      .toBe('Veille arrêtés : 0 proposition(s) à vérifier, 4 publiée(s) [quota Claude atteint, reste 12 documents]')
    expect(textePropositions({ enAttente: 1, publie: 0, publieNote: 0, arretQuota: true }))
      .toBe('Veille arrêtés : 1 proposition(s) à vérifier, 0 publiée(s) [quota Claude atteint]')
  })
})
