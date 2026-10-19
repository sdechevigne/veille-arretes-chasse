import { describe, it, expect } from 'vitest'
import { createServer } from 'node:http'
import { createHmac } from 'node:crypto'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const SCRIPT = fileURLToPath(new URL('../scripts/notifier-echec.mjs', import.meta.url))
const SECRET = 'cle-de-signature-factice'

async function avecServeur(statut: number, fn: (url: string, recus: { corps: string; signature: string }[]) => Promise<void>) {
  const recus: { corps: string; signature: string }[] = []
  const serveur = createServer((req, res) => {
    let corps = ''
    req.on('data', d => corps += d).on('end', () => { recus.push({ corps, signature: String(req.headers['x-manta-signature']) }); res.statusCode = statut; res.end('ok') })
  })
  await new Promise<void>(r => serveur.listen(0, '127.0.0.1', r))
  try { await fn(`http://127.0.0.1:${(serveur.address() as any).port}/hook`, recus) } finally { serveur.close() }
}

// Processus réel (spawn asynchrone) : le serveur de test répond pendant que l'enfant tourne.
const lancer = (env: Record<string, string>, texte?: string) => new Promise<{ code: number | null; stderr: string }>(resolve => {
  const p = spawn(process.execPath, texte === undefined ? [SCRIPT] : [SCRIPT, texte], { env: { PATH: process.env.PATH ?? '', ...env } })
  let stderr = ''; p.stderr.on('data', d => stderr += d); p.on('close', code => resolve({ code, stderr }))
})

describe('scripts/notifier-echec.mjs', () => {
  it('poste le texte signé HMAC-SHA256 sur le corps brut, au format de la notification de lecture', async () => {
    await avecServeur(200, async (url, recus) => {
      const r = await lancer({ MANTA_WEBHOOK_URL: url, MANTA_WEBHOOK_SECRET: SECRET }, 'Veille arrêtés : passage nocturne en échec : npm ci (code 1)')
      expect(r.code).toBe(0)
      expect(recus).toHaveLength(1)
      expect(JSON.parse(recus[0].corps)).toEqual({ type: 'propositions', texte: 'Veille arrêtés : passage nocturne en échec : npm ci (code 1)', donnees: null })
      expect(recus[0].signature).toBe(`sha256=${createHmac('sha256', SECRET).update(recus[0].corps).digest('hex')}`)
    })
  })

  it('webhook refusé : code 0, statut HTTP journalisé sans adresse ni clé', async () => {
    await avecServeur(500, async (url) => {
      const r = await lancer({ MANTA_WEBHOOK_URL: url, MANTA_WEBHOOK_SECRET: SECRET }, 'x')
      expect(r.code).toBe(0)
      expect(r.stderr).toContain('HTTP 500')
      expect(r.stderr).not.toContain(url); expect(r.stderr).not.toContain(SECRET)
    })
  })

  it('webhook injoignable : code 0, rien de sensible dans le journal', async () => {
    const url = 'http://127.0.0.1:1/hook'
    const r = await lancer({ MANTA_WEBHOOK_URL: url, MANTA_WEBHOOK_SECRET: SECRET }, 'x')
    expect(r.code).toBe(0)
    expect(r.stderr).toContain('impossible'); expect(r.stderr).not.toContain(url); expect(r.stderr).not.toContain(SECRET)
  })

  it('webhook non configuré : ignoré (code 0) ; texte absent : code 2', async () => {
    expect((await lancer({}, 'x')).code).toBe(0)
    expect((await lancer({ MANTA_WEBHOOK_URL: 'http://127.0.0.1:1/h', MANTA_WEBHOOK_SECRET: SECRET })).code).toBe(2)
  })
})
