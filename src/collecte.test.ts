import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { collecter } from './collecte.ts'
import { creerDepotMemoire } from './db.ts'
import { creerArchiveMemoire } from './r2.ts'
import { sha256 } from './empreinte.ts'
import type { Telechargeur } from './types.ts'

const fx = (f: string) => readFileSync(new URL(`./__fixtures__/${f}`, import.meta.url), 'utf8')
const M = 'https://www.manche.gouv.fr'
const PDF_A = Buffer.from('%PDF-1.4 A'); const PDF_B = Buffer.from('%PDF-1.4 B')

function httpTable(table: Record<string, { statut?: number; corps?: Buffer | string }>): Telechargeur & { appels: string[] } {
  const appels: string[] = []
  return { appels, async telecharger(url) {
    appels.push(url); const r = table[url]
    if (!r) return { statut: 404, octets: Buffer.alloc(0), urlFinale: url, contentType: null }
    const octets = Buffer.isBuffer(r.corps) ? r.corps : Buffer.from(r.corps ?? '')
    return { statut: r.statut ?? 200, octets, urlFinale: url, contentType: octets.subarray(0, 5).toString() === '%PDF-' ? 'application/pdf' : null }
  } }
}

describe('collecter', () => {
  it('RAA Manche : racine → 2026 → août + septembre → PDF nouveaux archivés, documents créés, santé ok', async () => {
    const depot = creerDepotMemoire(); const archive = creerArchiveMemoire()
    depot.etat.sources.push({ id: 's50', departement: '50', type_source: 'prefecture_raa', url: `${M}/Publications/Recueil-des-actes-administratifs`, actif: true, verifiee_le: null, echecs_consecutifs: 0 })
    const table: Record<string, any> = {
      [`${M}/Publications/Recueil-des-actes-administratifs`]: { corps: fx('manche-raa-racine.html') },
      [`${M}/Publications/Recueil-des-actes-administratifs/2026`]: { corps: fx('manche-raa-2026.html') },
      [`${M}/Publications/Recueil-des-actes-administratifs/2026/(offset)/10`]: { corps: '<html></html>' },
      [`${M}/Publications/Recueil-des-actes-administratifs/2026/10.-Aout`]: { corps: '<html><a class="fr-link" href="/contenu/telechargement/1/1/file/a.pdf">Télécharger RAA 1 PDF - 1 Mb - 01/08/2026</a></html>' },
      [`${M}/Publications/Recueil-des-actes-administratifs/2026/11.-Septembre`]: { corps: fx('manche-raa-2026-septembre.html') },
      [`${M}/contenu/telechargement/1/1/file/a.pdf`]: { corps: PDF_A },
    }
    // tous les PDF de septembre renvoient le même contenu B → 1 seul document (empreinte), les autres ignorés
    for (const u of fx('manche-raa-2026-septembre.html').matchAll(/href="(\/contenu\/telechargement\/[^"]+)"/g)) table[new URL(u[1], M).href] = { corps: PDF_B }
    const http = httpTable(table)
    const stats = await collecter({ depot, archive, http, now: () => new Date('2026-09-14') })
    expect(stats.sourcesVisitees).toBe(1); expect(stats.sourcesEnEchec).toBe(0)
    expect(stats.pdfNouveaux).toBe(2); expect(stats.pdfIgnores).toBe(stats.pdfVus - 2)
    expect(depot.etat.documents.map(d => d.sha256).sort()).toEqual([sha256(PDF_A), sha256(PDF_B)].sort())
    const doc = depot.etat.documents.find(d => d.sha256 === sha256(PDF_B))!
    expect(doc.departement).toBe('50'); expect(doc.saison).toBe('2026-2027'); expect(doc.titre).toMatch(/RAA spécial 50-2026-/)
    expect(doc.r2_key).toBe(`arretes/2026-2027/50/${sha256(PDF_B)}.pdf`); expect(archive.objets.has(doc.r2_key)).toBe(true)
    expect(depot.etat.sources[0].echecs_consecutifs).toBe(0); expect(depot.etat.sources[0].verifiee_le).not.toBeNull()
    expect(http.appels.some(u => u.includes('/2025'))).toBe(false)
  })
  it('RAA : la pagination d\'une page d\'année sans PDF est suivie (mois en page 2)', async () => {
    const depot = creerDepotMemoire(); const archive = creerArchiveMemoire()
    depot.etat.sources.push({ id: 's50', departement: '50', type_source: 'prefecture_raa', url: 'https://x/raa', actif: true, verifiee_le: null, echecs_consecutifs: 0 })
    const http = httpTable({
      'https://x/raa': { corps: '<html><a class="fr-card__link" href="/raa/2026">2026</a></html>' },
      'https://x/raa/2026': { corps: '<html><a class="fr-card__link" href="/raa/2026/10.-Aout">Août</a><a class="fr-pagination__link" href="/raa/2026/(offset)/10">2</a></html>' },
      'https://x/raa/2026/(offset)/10': { corps: '<html><a class="fr-card__link" href="/raa/2026/11.-Septembre">Septembre</a></html>' },
      'https://x/raa/2026/10.-Aout': { corps: '<html></html>' },
      'https://x/raa/2026/11.-Septembre': { corps: '<html><a class="fr-link" href="/dl/s.pdf">Télécharger RAA septembre PDF - 1 Mb - 01/09/2026</a></html>' },
      'https://x/dl/s.pdf': { corps: PDF_B },
    })
    const stats = await collecter({ depot, archive, http, now: () => new Date('2026-09-14') })
    expect(http.appels).toContain('https://x/raa/2026/11.-Septembre')
    expect(stats.pdfNouveaux).toBe(1); expect(stats.sourcesEnEchec).toBe(0)
    expect((depot.etat.sources[0] as any).dernier_statut).toBe('ok')
  })
  it('même contenu sous deux URL dans un même passage : un seul document, pas d\'erreur', async () => {
    const depot = creerDepotMemoire(); const archive = creerArchiveMemoire()
    depot.etat.sources.push({ id: 's', departement: '24', type_source: 'prefecture_chasse', url: 'https://x/p', actif: true, verifiee_le: null, echecs_consecutifs: 0 })
    const http = httpTable({
      'https://x/p': { corps: '<html><a class="fr-link" href="/a.pdf">A PDF</a><a class="fr-link" href="/b.pdf">B PDF</a></html>' },
      'https://x/a.pdf': { corps: PDF_A }, 'https://x/b.pdf': { corps: PDF_A },
    })
    const stats = await collecter({ depot, archive, http })
    expect(depot.etat.documents).toHaveLength(1); expect(stats.pdfNouveaux).toBe(1); expect(stats.pdfIgnores).toBe(1); expect(stats.erreurs).toEqual([])
  })
  it('deuxième passage : URL vues récemment non retéléchargées, aucun nouveau document', async () => {
    const depot = creerDepotMemoire(); const archive = creerArchiveMemoire()
    depot.etat.sources.push({ id: 's1', departement: '24', type_source: 'federation', url: 'https://fdc24/a.pdf', actif: true, verifiee_le: null, echecs_consecutifs: 0 })
    const http = httpTable({ 'https://fdc24/a.pdf': { corps: PDF_A } })
    await collecter({ depot, archive, http }); const s2 = await collecter({ depot, archive, http })
    expect(depot.etat.documents).toHaveLength(1); expect(s2.pdfNouveaux).toBe(0)
  })
  it('source en 404 : santé http_404, échecs +1, les autres sources continuent', async () => {
    const depot = creerDepotMemoire(); const archive = creerArchiveMemoire()
    depot.etat.sources.push({ id: 'a', departement: '08', type_source: 'prefecture_chasse', url: 'https://x/absente', actif: true, verifiee_le: null, echecs_consecutifs: 2 },
                            { id: 'b', departement: '24', type_source: 'federation', url: 'https://fdc24/a.pdf', actif: true, verifiee_le: null, echecs_consecutifs: 0 })
    const stats = await collecter({ depot, archive, http: httpTable({ 'https://fdc24/a.pdf': { corps: PDF_A } }) })
    expect(stats.sourcesEnEchec).toBe(1); expect(depot.etat.sources[0].echecs_consecutifs).toBe(3); expect((depot.etat.sources[0] as any).dernier_statut).toBe('http_404')
    expect(depot.etat.documents).toHaveLength(1)
  })
  it('page 200 sans aucun lien utile : structure_changee', async () => {
    const depot = creerDepotMemoire()
    depot.etat.sources.push({ id: 'a', departement: '08', type_source: 'prefecture_raa', url: 'https://x/raa', actif: true, verifiee_le: null, echecs_consecutifs: 0 })
    await collecter({ depot, archive: creerArchiveMemoire(), http: httpTable({ 'https://x/raa': { corps: '<html><p>maintenance</p></html>' } }) })
    expect((depot.etat.sources[0] as any).dernier_statut).toBe('structure_changee')
  })
  it('filtre par départements', async () => {
    const depot = creerDepotMemoire()
    depot.etat.sources.push({ id: 'a', departement: '08', type_source: 'federation', url: 'https://a/a.pdf', actif: true, verifiee_le: null, echecs_consecutifs: 0 },
                            { id: 'b', departement: '24', type_source: 'federation', url: 'https://b/b.pdf', actif: true, verifiee_le: null, echecs_consecutifs: 0 })
    const http = httpTable({ 'https://a/a.pdf': { corps: PDF_A }, 'https://b/b.pdf': { corps: PDF_B } })
    await collecter({ depot, archive: creerArchiveMemoire(), http }, { departements: ['24'] })
    expect(http.appels).toEqual(['https://b/b.pdf'])
  })
  it('RAA : racine → mois en 200 sans PDF (début de mois) : santé ok, 0 nouveau', async () => {
    const depot = creerDepotMemoire()
    depot.etat.sources.push({ id: 's', departement: '50', type_source: 'prefecture_raa', url: 'https://x/raa', actif: true, verifiee_le: null, echecs_consecutifs: 1 })
    const http = httpTable({
      'https://x/raa': { corps: '<html><a class="fr-card__link" href="/raa/2026">2026</a></html>' },
      'https://x/raa/2026': { corps: '<html><a class="fr-card__link" href="/raa/2026/11.-Septembre">Septembre</a></html>' },
      'https://x/raa/2026/11.-Septembre': { corps: '<html><p>Aucun document ce mois-ci</p></html>' },
    })
    const stats = await collecter({ depot, archive: creerArchiveMemoire(), http, now: () => new Date('2026-09-02') })
    expect((depot.etat.sources[0] as any).dernier_statut).toBe('ok'); expect(depot.etat.sources[0].echecs_consecutifs).toBe(0)
    expect(stats.pdfNouveaux).toBe(0); expect(stats.sourcesEnEchec).toBe(0)
  })
  it('RAA : racine avec sous-page suivie en 404 et aucun PDF : aucun_pdf', async () => {
    const depot = creerDepotMemoire()
    depot.etat.sources.push({ id: 's', departement: '50', type_source: 'prefecture_raa', url: 'https://x/raa', actif: true, verifiee_le: null, echecs_consecutifs: 0 })
    const http = httpTable({ 'https://x/raa': { corps: '<html><a class="fr-card__link" href="/raa/2026">2026</a></html>' } })
    const stats = await collecter({ depot, archive: creerArchiveMemoire(), http, now: () => new Date('2026-09-02') })
    expect((depot.etat.sources[0] as any).dernier_statut).toBe('aucun_pdf'); expect(stats.sourcesEnEchec).toBe(1)
    expect(stats.erreurs.some(e => e.includes('/raa/2026'))).toBe(true)
  })
  it('page source avec erreur curl (statut 0 ou erreur) : erreur_reseau ; compté une seule fois si la mise à jour lève', async () => {
    const depot = creerDepotMemoire()
    depot.etat.sources.push({ id: 'a', departement: '08', type_source: 'federation', url: 'https://x/a', actif: true, verifiee_le: null, echecs_consecutifs: 0 })
    const http: Telechargeur = { async telecharger(url) { return { statut: 200, octets: Buffer.alloc(0), urlFinale: url, contentType: null, erreur: 'taille 99 > max 1' } } }
    const stats = await collecter({ depot, archive: creerArchiveMemoire(), http })
    expect((depot.etat.sources[0] as any).dernier_statut).toBe('erreur_reseau'); expect(stats.sourcesEnEchec).toBe(1)
    const depotCasse = { ...depot, async majSanteSource() { throw new Error('base indisponible') } }
    const s2 = await collecter({ depot: depotCasse, archive: creerArchiveMemoire(), http: httpTable({ 'https://x/a': { statut: 500 } }) })
    expect(s2.sourcesEnEchec).toBe(1)
  })
  it('plafond de pages par source : parcours interrompu et consigné', async () => {
    const depot = creerDepotMemoire()
    depot.etat.sources.push({ id: 's', departement: '50', type_source: 'prefecture_raa', url: 'https://x/raa', actif: true, verifiee_le: null, echecs_consecutifs: 0 })
    const http = httpTable({
      'https://x/raa': { corps: '<html><a class="fr-card__link" href="/raa/2026">2026</a></html>' },
      'https://x/raa/2026': { corps: '<html><a class="fr-card__link" href="/raa/2026/10.-Aout">Août</a><a class="fr-card__link" href="/raa/2026/11.-Septembre">Septembre</a></html>' },
      'https://x/raa/2026/10.-Aout': { corps: '<html><p>vide</p></html>' },
      'https://x/raa/2026/11.-Septembre': { corps: '<html><p>vide</p></html>' },
    })
    const stats = await collecter({ depot, archive: creerArchiveMemoire(), http, now: () => new Date('2026-09-14') }, { maxPagesParSource: 2 })
    expect(http.appels).toEqual(['https://x/raa', 'https://x/raa/2026'])
    expect(stats.erreurs.some(e => e.includes('plafond de 2 pages'))).toBe(true)
  })
})
