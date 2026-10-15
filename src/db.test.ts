import { describe, it, expect } from 'vitest'
import { creerDepotMemoire, DoublonShaError, toutesLesPages, enLots, tentativesLecture } from './db.ts'

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

describe('creerDepotMemoire — lecture Claude', () => {
  const NOW = new Date('2026-10-15T12:00:00Z')
  const base = { departement: '54', saison: '2026-2027', source_id: null, url: 'https://x/a.pdf', titre: 'A', r2_key: 'k', taille_octets: 10 }
  async function depotAvec(docs: Array<{ statut: string; erreur?: string | null; decouvert_le: string; updated_at?: string }>) {
    const d = creerDepotMemoire()
    for (const [i, x] of docs.entries()) {
      const id = await d.creerDocument({ ...base, sha256: String(i).repeat(64) })
      Object.assign(d.etat.documents.find(doc => doc.id === id)!, { statut_traitement: x.statut, erreur: x.erreur ?? null, decouvert_le: x.decouvert_le, updated_at: x.updated_at ?? x.decouvert_le })
    }
    return d
  }
  it('documentsALire : a_lire par découverte, puis anciennes erreurs de lecture sous 3 tentatives', async () => {
    const d = await depotAvec([
      { statut: 'a_lire', decouvert_le: '2026-10-02T00:00:00Z' },
      { statut: 'erreur', erreur: 'lecture claude : boum (tentative 1)', decouvert_le: '2026-09-01T00:00:00Z', updated_at: '2026-10-13T00:00:00Z' },
      { statut: 'a_lire', decouvert_le: '2026-10-01T00:00:00Z' },
      { statut: 'erreur', erreur: 'lecture claude : boum (tentative 3)', decouvert_le: '2026-09-01T00:00:00Z', updated_at: '2026-10-13T00:00:00Z' },
      { statut: 'erreur', erreur: 'lecture claude : récent (tentative 1)', decouvert_le: '2026-09-01T00:00:00Z', updated_at: '2026-10-15T00:00:00Z' },
      { statut: 'erreur', erreur: 'pdfinfo cassé', decouvert_le: '2026-09-01T00:00:00Z', updated_at: '2026-10-01T00:00:00Z' },
    ])
    expect((await d.documentsALire(10, NOW)).map(x => x.id)).toEqual(['doc-3', 'doc-1', 'doc-2'])
    expect((await d.documentsALire(2, NOW)).map(x => x.id)).toEqual(['doc-3', 'doc-1'])
  })
  it('tentativesLecture lit le compteur des seules erreurs de lecture Claude', () => {
    expect(tentativesLecture(null)).toBe(0)
    expect(tentativesLecture('pdfinfo cassé (tentative 2)')).toBe(0)
    expect(tentativesLecture('lecture claude : x (tentative 2)')).toBe(2)
    expect(tentativesLecture('lecture claude : sans compteur')).toBe(1)
  })
  it('versionPubliee : arrêté général et ses périodes, sinon null', async () => {
    const d = creerDepotMemoire()
    expect(await d.versionPubliee('54', '2026-2027')).toEqual({ arrete: null, periodes: [] })
    const arrete = { id: 'a1', updated_at: '2026-09-20T10:00:00+00:00', statut: 'signe', url_source: 'https://x', numero_arrete: null, date_signature: '2026-05-12' }
    const periodes = [{ espece_code: 'sanglier', sous_type: null, date_ouverture: '2026-06-01', date_fermeture: '2027-02-28', mode_chasse: 'tous_modes', restriction_dates: null, source_article: '1' }]
    d.etat.publiees.push({ departement: '54', saison: '2026-2027', arrete, periodes })
    expect(await d.versionPubliee('54', '2026-2027')).toEqual({ arrete, periodes })
  })
  it('propositionProjet : dernière proposition projet non annulée ni rejetée, avec le texte de son document', async () => {
    const d = await depotAvec([{ statut: 'propose', decouvert_le: '2026-05-01T00:00:00Z' }, { statut: 'propose', decouvert_le: '2026-05-02T00:00:00Z' }])
    d.etat.documents[0].texte_r2_key = 't1'; d.etat.documents[1].texte_r2_key = 't2'
    const prop = (o: object) => ({ id: 'p', document_id: 'doc-1', departement: '54', saison: '2026-2027', type_acte: 'projet', decision: 'en_attente', annulee_le: null, created_at: '2026-05-01T00:00:00Z', payload: { periodes: [{ espece_code: 'sanglier' }] }, ...o }) as any
    expect(await d.propositionProjet('54', '2026-2027')).toBeNull()
    d.etat.propositions.push(prop({}), prop({ document_id: 'doc-2', created_at: '2026-05-03T00:00:00Z', decision: 'rejete' }), prop({ document_id: 'doc-2', created_at: '2026-05-04T00:00:00Z', annulee_le: '2026-05-05T00:00:00Z' }), prop({ type_acte: 'annuel', document_id: 'doc-2', created_at: '2026-05-06T00:00:00Z' }))
    expect(await d.propositionProjet('54', '2026-2027')).toEqual({ texte_r2_key: 't1', periodes: [{ espece_code: 'sanglier' }] })
    d.etat.propositions.push(prop({ document_id: 'disparu', created_at: '2026-05-07T00:00:00Z' }))
    expect(await d.propositionProjet('54', '2026-2027')).toBeNull()
  })
  it('marquerIgnore garde l’acte ; majStatut pose statut et motif', async () => {
    const d = await depotAvec([{ statut: 'a_lire', decouvert_le: '2026-10-01T00:00:00Z' }, { statut: 'a_lire', decouvert_le: '2026-10-01T00:00:00Z' }])
    await d.marquerIgnore('doc-1', 'ponctuel sans effet sur les dates', { numero: 'N1', date: '2026-08-01', objet: 'Battue administrative' })
    expect(d.etat.documents[0]).toMatchObject({ statut_traitement: 'ignore', erreur: 'ponctuel sans effet sur les dates', numero_acte: 'N1', date_acte: '2026-08-01', objet: 'Battue administrative' })
    await d.majStatut('doc-2', 'en_attente', 'type non déterminé mécaniquement')
    expect(d.etat.documents[1]).toMatchObject({ statut_traitement: 'en_attente', erreur: 'type non déterminé mécaniquement' })
  })
  it('soumettre : refuse comme la RPC un document déjà traité ou incohérent ; sinon enregistre et décide', async () => {
    const d = await depotAvec([{ statut: 'a_lire', decouvert_le: '2026-10-01T00:00:00Z' }, { statut: 'propose', decouvert_le: '2026-10-01T00:00:00Z' }])
    const p = (o: object) => ({ document_id: 'doc-1', departement: '54', saison: '2026-2027', mode: 'complet', type_acte: 'annuel', payload: { departement: '54', saison: '2026-2027' }, acte: { numero: 'N', date: '2026-05-12', objet: 'Ouverture' }, base_arrete_maj: null, c1: { ok: true, details: [] }, lecture: {}, suppression_explicite: false, ...o }) as any
    await expect(d.soumettre(p({ document_id: 'doc-2' }))).rejects.toThrow(/déjà traité/)
    await expect(d.soumettre(p({ saison: '2025-2026' }))).rejects.toThrow(/incohérents/)
    await expect(d.soumettre(p({ document_id: 'inconnu' }))).rejects.toThrow(/inconnu/)
    const r = await d.soumettre(p({ c1: { ok: false, details: ['x'] } }))
    expect(r).toMatchObject({ decision: 'en_attente', ecrit: false, mode_reglage: 'observation' })
    expect(d.etat.documents[0]).toMatchObject({ statut_traitement: 'en_attente', objet: 'Ouverture', erreur: null })
    expect(d.etat.propositions).toHaveLength(1)
  })
})
