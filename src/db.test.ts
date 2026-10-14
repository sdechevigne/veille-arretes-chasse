import { describe, it, expect } from 'vitest'
import { creerDepotMemoire } from './db.ts'

describe('creerDepotMemoire (contrat Depot)', () => {
  it('santé : succès remet les échecs à 0 et date verifiee_le ; échec incrémente', async () => {
    const d = creerDepotMemoire()
    d.etat.sources.push({ id: 's1', departement: '50', type_source: 'prefecture_raa', url: 'https://x', actif: true, verifiee_le: null, echecs_consecutifs: 2 })
    await d.majSanteSource('s1', false, 'http_404'); expect(d.etat.sources[0].echecs_consecutifs).toBe(3)
    await d.majSanteSource('s1', true, 'ok'); expect(d.etat.sources[0].echecs_consecutifs).toBe(0); expect(d.etat.sources[0].verifiee_le).not.toBeNull()
  })
  it('shaConnus et urlsVuesDepuis reflètent les documents créés', async () => {
    const d = creerDepotMemoire()
    await d.creerDocument({ departement: '50', saison: '2026-2027', source_id: 's1', url: 'https://x/a.pdf', titre: 'A', sha256: 'a'.repeat(64), r2_key: 'k', taille_octets: 10 })
    expect(await d.shaConnus(['a'.repeat(64), 'b'.repeat(64)])).toEqual(new Set(['a'.repeat(64)]))
    expect(await d.urlsVuesDepuis(30)).toEqual(new Set(['https://x/a.pdf']))
    expect((await d.documentsParStatut('a_extraire', 10)).length).toBe(1)
  })
})
