import { afterEach, describe, expect, it, vi } from 'vitest'
import { lireEnv, lireManta } from './env.ts'

const BASE = { SUPABASE_URL: 'https://x.supabase.test', SUPABASE_SERVICE_ROLE_KEY: 'faux', R2_ACCOUNT_ID: 'a', R2_ACCESS_KEY_ID: 'b', R2_SECRET_ACCESS_KEY: 'c', R2_VEILLE_BUCKET: 'd' }
function poser(extra: Record<string, string> = {}) {
  for (const k of ['VEILLE_PROXY_URL', 'VEILLE_OPENCODE_URL', 'VEILLE_OPENCODE_PASSWORD', 'CLAUDE_CODE_OAUTH_TOKEN', 'MANTA_WEBHOOK_URL', 'MANTA_WEBHOOK_SECRET']) vi.stubEnv(k, '')
  for (const [k, v] of Object.entries({ ...BASE, ...extra })) vi.stubEnv(k, v)
}
afterEach(() => vi.unstubAllEnvs())

describe('lireEnv — variables optionnelles opencode / Manta', () => {
  it('absentes : fonctionnalités désactivées, aucune erreur', () => {
    poser(); const env = lireEnv()
    expect(env.opencode).toBeUndefined(); expect(env.manta).toBeUndefined()
  })
  it('opencode local : URL et mot de passe', () => {
    poser({ VEILLE_OPENCODE_URL: ' http://127.0.0.1:4197 ', VEILLE_OPENCODE_PASSWORD: 'pw' })
    expect(lireEnv().opencode).toEqual({ url: 'http://127.0.0.1:4197', motDePasse: 'pw' })
  })
  it('opencode local : mot de passe facultatif', () => {
    poser({ VEILLE_OPENCODE_URL: 'http://127.0.0.1:4197' })
    expect(lireEnv().opencode).toEqual({ url: 'http://127.0.0.1:4197', motDePasse: undefined })
  })
  it('opencode local : sans URL, le mot de passe seul ne suffit pas', () => {
    poser({ VEILLE_OPENCODE_PASSWORD: 'pw' })
    expect(lireEnv().opencode).toBeUndefined()
  })
  it('l’ancien jeton CLAUDE_CODE_OAUTH_TOKEN n’a plus aucun effet', () => {
    poser({ CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat-FAUX' })
    const env = lireEnv()
    expect('claude' in env).toBe(false); expect(env.opencode).toBeUndefined()
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
