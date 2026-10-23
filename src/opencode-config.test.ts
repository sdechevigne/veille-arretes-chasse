import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'

// Garde-fou durable de la configuration de l'instance isolée (opencode V2) : relue telle que le script la copie.
// Seuls les commentaires de ligne entière sont retirés (le JSONC du dépôt n'en a pas d'autres ; les URL contiennent « // »).
const config = JSON.parse(readFileSync(new URL('../opencode/opencode.jsonc', import.meta.url), 'utf8').split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n'))

describe('opencode/opencode.jsonc', () => {
  it('agent lecteur : refuse tout (dernière règle = tout refusé), sans limite d’étapes (steps → prefill refusé)', () => {
    const lecteur = config.agents.lecteur
    expect(lecteur.mode).toBe('primary')
    expect(lecteur.permissions.at(-1)).toEqual({ action: '*', resource: '*', effect: 'deny' })
    expect(lecteur.permissions.every((r: { effect: string }) => r.effect === 'deny')).toBe(true)
    expect(lecteur).not.toHaveProperty('steps')
    expect(lecteur).not.toHaveProperty('maxSteps')
  })
  it('aucun serveur MCP, aucun plugin déclaré (seul manta-claude-max, copié dans plugins/), aucune instruction', () => {
    expect(config.mcp).toEqual({ servers: {} })
    expect(config).not.toHaveProperty('plugins')
    expect(config).not.toHaveProperty('plugin')
    expect(config).not.toHaveProperty('instructions')
  })
  it('mises à jour automatiques et partage coupés (forme V2)', () => {
    expect(config.update).toBe('disable')
    expect(config.share).toBe('disabled')
    expect(config.$schema).toBe('https://opencode.ai/config.json')
  })
})
