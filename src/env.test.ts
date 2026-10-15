import { afterEach, describe, expect, it, vi } from 'vitest'
import { lireEnv, lireManta } from './env.ts'

const BASE = { SUPABASE_URL: 'https://x.supabase.test', SUPABASE_SERVICE_ROLE_KEY: 'faux', R2_ACCOUNT_ID: 'a', R2_ACCESS_KEY_ID: 'b', R2_SECRET_ACCESS_KEY: 'c', R2_VEILLE_BUCKET: 'd' }
function poser(extra: Record<string, string> = {}) {
  for (const k of ['VEILLE_PROXY_URL', 'CLAUDE_CODE_OAUTH_TOKEN', 'MANTA_WEBHOOK_URL', 'MANTA_WEBHOOK_SECRET']) vi.stubEnv(k, '')
  for (const [k, v] of Object.entries({ ...BASE, ...extra })) vi.stubEnv(k, v)
}
afterEach(() => vi.unstubAllEnvs())

describe('lireEnv — variables optionnelles Claude / Manta', () => {
  it('absentes : fonctionnalités désactivées, aucune erreur', () => {
    poser(); const env = lireEnv()
    expect(env.claude).toBeUndefined(); expect(env.manta).toBeUndefined()
  })
  it('jeton Claude présent', () => {
    poser({ CLAUDE_CODE_OAUTH_TOKEN: ' sk-ant-oat-FAUX ' })
    expect(lireEnv().claude).toEqual({ token: 'sk-ant-oat-FAUX' })
  })
  it('Manta exige l’URL ET le secret', () => {
    poser({ MANTA_WEBHOOK_URL: 'https://manta.test/hook' }); expect(lireEnv().manta).toBeUndefined()
    poser({ MANTA_WEBHOOK_SECRET: 's3cret-faux' }); expect(lireEnv().manta).toBeUndefined()
    poser({ MANTA_WEBHOOK_URL: 'https://manta.test/hook', MANTA_WEBHOOK_SECRET: 's3cret-faux' })
    expect(lireEnv().manta).toEqual({ url: 'https://manta.test/hook', secret: 's3cret-faux' })
  })
  it('lireManta : lisible sans les variables Supabase / R2 (commande notifier)', () => {
    for (const k of Object.keys(BASE)) vi.stubEnv(k, '')
    vi.stubEnv('MANTA_WEBHOOK_URL', 'https://manta.test/hook'); vi.stubEnv('MANTA_WEBHOOK_SECRET', 's3cret-faux')
    expect(lireManta()).toEqual({ url: 'https://manta.test/hook', secret: 's3cret-faux' })
  })
})
