import { describe, it, expect } from 'vitest'
import { creerDepotMemoire, DoublonShaError, toutesLesPages, enLots } from './db.ts'

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
  it('doublon sha256 : DoublonShaError typée', async () => {
    const d = creerDepotMemoire()
    const doc = { departement: '50', saison: '2026-2027', source_id: 's1', url: 'https://x/a.pdf', titre: 'A', sha256: 'a'.repeat(64), r2_key: 'k', taille_octets: 10 }
    await d.creerDocument(doc)
    await expect(d.creerDocument({ ...doc, url: 'https://x/b.pdf' })).rejects.toBeInstanceOf(DoublonShaError)
  })
  it('statut de santé hors CHECK : refusé ; erreur tronquée à 2000', async () => {
    const d = creerDepotMemoire()
    d.etat.sources.push({ id: 's1', departement: '50', type_source: 'prefecture_raa', url: 'https://x', actif: true, verifiee_le: null, echecs_consecutifs: 0 })
    await expect(d.majSanteSource('s1', false, 'http_4040')).rejects.toThrow(/invalide/)
    const id = await d.creerDocument({ departement: '50', saison: '2026-2027', source_id: 's1', url: 'https://x/a.pdf', titre: 'A', sha256: 'a'.repeat(64), r2_key: 'k', taille_octets: 10 })
    await d.marquerErreur(id, 'e'.repeat(5000))
    expect((d.etat.documents[0] as any).erreur.length).toBe(2000)
  })
})

describe('pagination', () => {
  it('toutesLesPages boucle jusqu’à une page incomplète', async () => {
    const appels: Array<[number, number]> = []
    const total = 2500
    const lignes = await toutesLesPages<number>('t', async (de, a) => { appels.push([de, a]); return { data: Array.from({ length: Math.max(0, Math.min(a + 1, total) - de) }, (_, i) => de + i), error: null } })
    expect(lignes.length).toBe(total); expect(appels).toEqual([[0, 999], [1000, 1999], [2000, 2999]])
  })
  it('toutesLesPages : page pile pleine → une page vide termine la boucle', async () => {
    let n = 0
    const lignes = await toutesLesPages<number>('t', async () => ({ data: n++ === 0 ? Array.from({ length: 1000 }, (_, i) => i) : [], error: null }))
    expect(lignes.length).toBe(1000); expect(n).toBe(2)
  })
  it('toutesLesPages propage l’erreur', async () => {
    await expect(toutesLesPages('ctx', async () => ({ data: null, error: { message: 'boum' } }))).rejects.toThrow('ctx : boum')
  })
  it('enLots découpe par taille', () => { expect(enLots([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]); expect(enLots([], 100)).toEqual([]) })
})
