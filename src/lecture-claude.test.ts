import { describe, it, expect } from 'vitest'
import { lireAvecClaude, preparerDossier } from './lecture-claude.ts'
import { creerDepotMemoire } from './db.ts'
import { creerArchiveMemoire, cleArchive } from './r2.ts'
import type { Lecteur, ReponseLecture, RequeteLecture } from './claude.ts'
import type { OutilsPdf } from './pdf.ts'
import type { PeriodePubliee } from './difference.ts'
import type { LectureClaude, PeriodeLue, QualiteTexte, TypeDetecte } from './types.ts'

const NOW = new Date('2026-10-15T12:00:00Z')
const NOMS = { '54': 'Meurthe-et-Moselle' }
const CONSIGNE = { systeme: 'consigne de test', schema: { type: 'object' } }

// Fixture : arrêté annuel à deux articles datés.
const ENTETE = "PRÉFET DE MEURTHE-ET-MOSELLE\nARRÊTÉ N° 2026/DDT/12\nrelatif à l'ouverture et à la clôture de la chasse pour la campagne 2026-2027"
const ART1 = 'Article 1 : Le sanglier peut être chassé du 1er juin 2026 au 28 février 2027.'
const ART2 = "Article 2 : Le chevreuil peut être chassé à l'approche du 1er juin 2026 au 28 février 2027."
const AP = [[ENTETE, ART1, ART2, 'Fait à Nancy, le 12 mai 2026'].join('\n')]
const PROJET = [["PROJET D'ARRÊTÉ\nrelatif à l'ouverture et à la clôture de la chasse pour la campagne 2026-2027", ART1, ART2, 'Fait à , le'].join('\n')]

const preuve = (citation: string, page = 1) => ({ article: '1', citation, page, annee_deduite: false })
const P1: PeriodeLue = { espece_code: 'sanglier', sous_type: null, date_ouverture: '2026-06-01', date_fermeture: '2027-02-28', mode_chasse: 'tous_modes', restriction_dates: null, source_article: 'Article 1', preuve: preuve('Le sanglier peut être chassé du 1er juin 2026 au 28 février 2027') }
const P2: PeriodeLue = { espece_code: 'chevreuil', sous_type: null, date_ouverture: '2026-06-01', date_fermeture: '2027-02-28', mode_chasse: 'approche_affut', restriction_dates: null, source_article: 'Article 2', preuve: preuve("Le chevreuil peut être chassé à l'approche du 1er juin 2026 au 28 février 2027") }
const ACTE = { numero: '2026/DDT/12', date: '2026-05-12', objet: 'Ouverture et clôture de la chasse 2026-2027', signe: true, departement_lu: 'Meurthe-et-Moselle', saison_lue: '2026-2027' }
const sortie = (o: Partial<LectureClaude> = {}): LectureClaude => ({ acte: ACTE, periodes: [P1, P2], suppressions: [], notes: '', ...o })
const ok = (s: LectureClaude, modele = 'sonnet'): ReponseLecture => ({ ok: true, sortie: s, usage: { input: 100, output: 50, cache_creation: 10, cache_read: 0 }, modele })
const echec = (erreur: 'quota' | 'schema' | 'timeout' | 'cli'): ReponseLecture => ({ ok: false, erreur, message: `échec ${erreur}` })

// Lecteur scripté : une Error dans la file simule une exception imprévue.
function lecteurScripte(reponses: (ReponseLecture | Error)[]): Lecteur & { requetes: RequeteLecture[] } {
  const file = [...reponses]; const requetes: RequeteLecture[] = []
  return { requetes, async lire(req) { requetes.push(req); const r = file.shift(); if (!r) throw new Error('plus de réponse prévue'); if (r instanceof Error) throw r; return r } }
}

interface DocTest { type?: TypeDetecte; pages?: string[]; qualite?: QualiteTexte; statut?: 'a_lire' | 'erreur' | 'propose'; erreur?: string; updated_at?: string }
async function monter(docs: DocTest[], reponses: (ReponseLecture | Error)[]) {
  const depot = creerDepotMemoire(); const archive = creerArchiveMemoire(); const lecteur = lecteurScripte(reponses)
  for (const [i, d] of docs.entries()) {
    const sha = String.fromCharCode(97 + i).repeat(64)
    const r2_key = cleArchive('2026-2027', '54', sha, 'pdf'); archive.objets.set(r2_key, Buffer.from(`%PDF-${i}`))
    const id = await depot.creerDocument({ departement: '54', saison: '2026-2027', source_id: null, url: `https://exemple.test/${i}.pdf`, titre: 'AP', sha256: sha, r2_key, taille_octets: 5 })
    const texte_r2_key = cleArchive('2026-2027', '54', sha, 'texte.json')
    const pages = (d.pages ?? AP).map((texte, j) => ({ n: j + 1, source: 'native', texte, nbDates: 0, nbEspeces: 0 }))
    archive.objets.set(texte_r2_key, Buffer.from(JSON.stringify({ sha256: sha, pages })))
    await depot.majLecture(id, { type_detecte: d.type ?? 'annuel', numero_acte: null, date_acte: null, objet: null, qualite_texte: d.qualite ?? 'native', pages_retenues: pages.map(p => p.n), statut: 'a_lire', texte_r2_key })
    Object.assign(depot.etat.documents.find(x => x.id === id)!, { decouvert_le: `2026-10-0${i + 1}T00:00:00Z`, updated_at: d.updated_at ?? `2026-10-0${i + 1}T00:00:00Z` },
      d.statut && d.statut !== 'a_lire' ? { statut_traitement: d.statut, erreur: d.erreur ?? null } : {})
  }
  const images: number[] = []; const temps: string[] = []; const liberes: string[] = []
  const outils: OutilsPdf = { async nbPages() { return 1 }, async texteNatif() { return '' }, async ocrPage() { return '' }, async imagePage(_pdf, n) { images.push(n); return Buffer.from(`png${n}`) } }
  const fichierTemp = async (o: Buffer) => { const chemin = `/tmp/fake-${o.toString()}`; temps.push(chemin); return { chemin, liberer: () => { liberes.push(chemin) } } }
  const journal: string[] = []
  const lancer = (o: { echeance?: Date; limite?: number; departements?: string[] } = {}) => lireAvecClaude({ depot, archive, lecteur, outils, consigne: CONSIGNE, noms: NOMS, fichierTemp, now: () => NOW, log: l => { journal.push(l) } }, { limite: 10, ...o })
  const doc = (i: number) => depot.etat.documents[i] as any
  return { depot, archive, lecteur, images, temps, liberes, journal, lancer, doc }
}

const ARRETE = { id: 'a1', updated_at: '2026-09-20T10:00:00+00:00', statut: 'signe', url_source: 'https://exemple.test/ap.pdf', numero_arrete: '2026/DDT/12', date_signature: '2026-05-12' }
const publiee = (o: Partial<PeriodePubliee>): PeriodePubliee => ({ espece_code: 'sanglier', sous_type: null, date_ouverture: '2026-06-01', date_fermeture: '2027-02-28', mode_chasse: 'tous_modes', restriction_dates: null, source_article: '1', ...o })
const MODIF = [["PRÉFET DE MEURTHE-ET-MOSELLE\nARRÊTÉ N° 2026/DDT/80 modifiant l'arrêté du 12 mai 2026 pour la campagne 2026-2027", 'Article 1 : Le sanglier peut être chassé du 15 juin 2026 au 28 février 2027.', 'Fait à Nancy, le 1er septembre 2026'].join('\n')]
const P_MODIF: PeriodeLue = { ...P1, date_ouverture: '2026-06-15', preuve: preuve('Le sanglier peut être chassé du 15 juin 2026 au 28 février 2027') }

describe('lireAvecClaude', () => {
  it('annuel complet : une lecture Sonnet, C1 ok, proposition soumise et décision comptée', async () => {
    const m = await monter([{}], [ok(sortie())])
    const stats = await m.lancer()
    expect(stats).toMatchObject({ traites: 1, publie: 1, enAttente: 0, erreurs: 0, arretQuota: false, arretPrecoce: false, tokens: { input: 100, output: 50 } })
    expect(stats.decisions).toEqual([{ documentId: 'doc-1', departement: '54', decision: 'publie' }])
    expect(m.lecteur.requetes).toHaveLength(1)
    expect(m.lecteur.requetes[0]).toMatchObject({ modele: 'sonnet', systeme: 'consigne de test', schema: CONSIGNE.schema })
    expect(m.lecteur.requetes[0].texte).toContain('type annuel, mode complet')
    const p = m.depot.etat.propositions[0]
    expect(p).toMatchObject({ document_id: 'doc-1', departement: '54', saison: '2026-2027', mode: 'complet', type_acte: 'annuel', base_arrete_maj: null, suppression_explicite: false,
      acte: { numero: '2026/DDT/12', date: '2026-05-12', objet: ACTE.objet }, c1: { ok: true, details: [] },
      lecture: { modele: 'sonnet', relance_opus: false, double_lecture: false, usage: { input: 100, output: 50, cache_creation: 10, cache_read: 0 } } })
    expect(p.payload).toMatchObject({ departement: '54', saison: '2026-2027', strict: true, arrete: { statut: 'signe', date_signature: '2026-05-12', url_source: 'https://exemple.test/0.pdf' },
      preuve: { code_detecte: '54', dept_detecte: 'Meurthe-et-Moselle', millesime_detecte: '2026-2027', signature_detectee: '2026-05-12', extrait_source: P2.preuve.citation } })
    expect(p.payload.periodes.map(x => x.espece_code)).toEqual(['chevreuil', 'sanglier'])
    expect(p.payload.periodes[1].preuve).toEqual(P1.preuve)
    expect(m.doc(0).statut_traitement).toBe('propose')
    expect(m.journal.some(l => l.startsWith('54 publie'))).toBe(true)
  })

  it('quota au 2ᵉ document : arrêt du passage, le 2ᵉ reste a_lire, le 3ᵉ n’est pas lu', async () => {
    const m = await monter([{}, {}, {}], [ok(sortie()), echec('quota')])
    const stats = await m.lancer()
    expect(stats).toMatchObject({ arretQuota: true, publie: 1, erreurs: 0 })
    expect(m.lecteur.requetes).toHaveLength(2)
    expect(m.doc(1)).toMatchObject({ statut_traitement: 'a_lire', erreur: null })
    expect(m.doc(2).statut_traitement).toBe('a_lire')
  })

  it('filtre départements : seuls les documents des départements demandés sont lus', async () => {
    const m = await monter([{}, {}], [ok(sortie())])
    expect(await m.lancer({ departements: ['24'] })).toMatchObject({ traites: 0 })
    expect(m.lecteur.requetes).toHaveLength(0)
    expect(await m.lancer({ departements: ['54'], limite: 1 })).toMatchObject({ traites: 1, publie: 1 })
  })

  it('preparerDossier (commande dossier) : même mode et même dossier que la lecture, sans appel Claude', async () => {
    const m = await monter([{ type: 'modificatif', pages: MODIF }], [])
    m.depot.etat.publiees.push({ departement: '54', saison: '2026-2027', arrete: ARRETE, periodes: [publiee({})] })
    const notes: string[] = []
    const p = await preparerDossier({ depot: m.depot, archive: m.archive, noms: NOMS }, m.doc(0), notes)
    expect(p.mode).toBe('difference')
    expect(p.dossier.texte).toContain('Le sanglier peut être chassé du 15 juin 2026')
    expect(p.dossier.estimationTokens).toBeGreaterThan(0)
    expect(m.lecteur.requetes).toHaveLength(0)
  })

  it('schéma raté puis Opus ok : relance_opus et modèle Opus', async () => {
    const m = await monter([{}], [echec('schema'), ok(sortie(), 'opus')])
    await m.lancer()
    expect(m.lecteur.requetes.map(r => r.modele)).toEqual(['sonnet', 'opus'])
    expect(m.depot.etat.propositions[0].lecture).toMatchObject({ modele: 'opus', relance_opus: true, usage: { input: 100 } })
  })

  it('deux échecs techniques → erreur avec compteur de tentatives', async () => {
    const m = await monter([{}], [echec('timeout'), echec('cli')])
    const stats = await m.lancer()
    expect(stats.erreurs).toBe(1)
    expect(m.doc(0)).toMatchObject({ statut_traitement: 'erreur', erreur: 'lecture claude : claude cli : échec cli (tentative 1)' })
  })

  it('C1 faux persistant : relance Opus avec le détail, puis soumission avec c1.ok = false', async () => {
    const faux = sortie({ periodes: [{ ...P1, preuve: preuve('Le sanglier est interdit toute la saison hivernale sur tout le territoire départemental') }, P2] })
    const m = await monter([{}], [ok(faux), ok(faux, 'opus')])
    const stats = await m.lancer()
    expect(m.lecteur.requetes[1].modele).toBe('opus')
    expect(m.lecteur.requetes[1].texte).toMatch(/Vérification précédente : période \d \(sanglier\) : citation introuvable/)
    const p = m.depot.etat.propositions[0]
    expect(p.c1.ok).toBe(false); expect(p.c1.details[0]).toMatch(/citation introuvable/)
    expect(p.lecture.relance_opus).toBe(true)
    expect(stats.enAttente).toBe(1)
  })

  it('citation sans espèce : double lecture en image, sorties égales → double_lecture et C1 résolu', async () => {
    const s = sortie({ periodes: [P1, { ...P2, preuve: preuve("à l'approche du 1er juin 2026 au 28 février 2027") }] })
    const m = await monter([{}], [ok(s), ok(s), ok(s)])
    const stats = await m.lancer()
    expect(m.lecteur.requetes).toHaveLength(3)
    expect(m.lecteur.requetes[0].images).toBeUndefined()
    for (const r of m.lecteur.requetes.slice(1)) { expect(r.modele).toBe('sonnet'); expect(r.images).toEqual([{ page: 1, png: Buffer.from('png1') }]) }
    expect(m.images).toEqual([1])
    expect(m.temps).toEqual(['/tmp/fake-%PDF-0']); expect(m.liberes).toEqual(m.temps)
    const p = m.depot.etat.propositions[0]
    expect(p.lecture).toMatchObject({ double_lecture: true, relance_opus: false, usage: { input: 300, output: 150 } })
    expect(p.c1).toEqual({ ok: true, details: [] })
    expect(p.lecture.notes).toContain('levé par la double lecture : période 2 (chevreuil) : espèce absente de la citation')
    expect(stats.tokens).toEqual({ input: 300, output: 150 })
  })

  it('double lecture divergente → c1.ok = false avec le détail', async () => {
    const s = sortie({ periodes: [P1, { ...P2, preuve: preuve("à l'approche du 1er juin 2026 au 28 février 2027") }] })
    const autre = sortie({ periodes: [{ ...P1, date_fermeture: '2027-01-31' }, P2] })
    const m = await monter([{}], [ok(s), ok(s), ok(autre)])
    await m.lancer()
    const p = m.depot.etat.propositions[0]
    expect(p.lecture.double_lecture).toBe(true)
    expect(p.c1.ok).toBe(false)
    expect(p.c1.details.some(d => d.startsWith('double lecture divergente'))).toBe(true)
  })

  it('texte OCR douteux : double lecture sur les pages du dossier', async () => {
    const m = await monter([{ qualite: 'ocr_douteux' }], [ok(sortie()), ok(sortie()), ok(sortie())])
    await m.lancer()
    expect(m.lecteur.requetes).toHaveLength(3)
    expect(m.depot.etat.propositions[0].lecture.double_lecture).toBe(true)
  })

  it('plus de 6 pages à relire en image : pas de double lecture, c1.ok = false', async () => {
    const pages = [`${ENTETE}\n${ART1}`, ...Array.from({ length: 6 }, (_, k) => `Article ${k + 2} : Le lièvre peut être chassé du 1er octobre 2026 au 30 novembre 2026.`)]
    const m = await monter([{ qualite: 'ocr_douteux', pages }], [ok(sortie({ periodes: [P1] }))])
    await m.lancer()
    expect(m.lecteur.requetes).toHaveLength(1); expect(m.images).toEqual([])
    expect(m.depot.etat.propositions[0].c1).toEqual({ ok: false, details: ['trop de pages à relire en image (7)'] })
  })

  it('modificatif : mode différence, base_arrete_maj publiée, périodes consolidées', async () => {
    const m = await monter([{ type: 'modificatif', pages: MODIF }], [ok(sortie({ periodes: [P_MODIF], acte: { ...ACTE, numero: '2026/DDT/80', date: '2026-09-01' } }))])
    m.depot.etat.publiees.push({ departement: '54', saison: '2026-2027', arrete: ARRETE, periodes: [publiee({}), publiee({ espece_code: 'lievre', date_ouverture: '2026-10-01', date_fermeture: '2026-12-01' })] })
    await m.lancer()
    expect(m.lecteur.requetes[0].texte).toContain('=== Périodes actuellement publiées ===')
    const p = m.depot.etat.propositions[0]
    expect(p).toMatchObject({ mode: 'difference', type_acte: 'modificatif', base_arrete_maj: ARRETE.updated_at, c1: { ok: true } })
    expect(p.payload.periodes.map(x => `${x.espece_code} ${x.date_ouverture}`)).toEqual(['lievre 2026-10-01', 'sanglier 2026-06-15'])
    expect(p.lecture.notes).toMatch(/remplace/)
    expect(p.payload.notes).toBeNull()
  })

  it('modificatif sans version publiée : lecture complète et note', async () => {
    const m = await monter([{ type: 'modificatif', pages: MODIF }], [ok(sortie({ periodes: [P_MODIF] }))])
    await m.lancer()
    const p = m.depot.etat.propositions[0]
    expect(p.mode).toBe('complet'); expect(p.lecture.notes).toMatch(/aucune version publiée/)
  })

  it('zone publiée remplacée (différence) ou non reprise (complet) : signalée en C1, jamais effacée en silence', async () => {
    const zone = publiee({ zone_libelle: 'Zone A' })
    const a = await monter([{ type: 'modificatif', pages: MODIF }], [ok(sortie({ periodes: [P_MODIF] }))])
    a.depot.etat.publiees.push({ departement: '54', saison: '2026-2027', arrete: ARRETE, periodes: [zone] })
    await a.lancer()
    expect(a.depot.etat.propositions[0].c1).toEqual({ ok: false, details: ['zone publiée non reprise : sanglier tous_modes (Zone A)'] })
    const b = await monter([{}], [ok(sortie())])
    b.depot.etat.publiees.push({ departement: '54', saison: '2026-2027', arrete: ARRETE, periodes: [publiee({ espece_code: 'lievre', mode_chasse: 'battue', zone_libelle: 'Plaine' })] })
    await b.lancer()
    expect(b.depot.etat.propositions[0].c1.details).toEqual(['zone publiée non reprise : lievre battue (Plaine)'])
  })

  it('annuel après un projet identique : script_projet_signe, une requête courte, périodes du projet', async () => {
    const m = await monter([{ type: 'projet', pages: PROJET, statut: 'propose' }, {}], [ok(sortie({ periodes: [] }))])
    const periodesProjet = [P1, P2].map(({ preuve: pr, ...x }) => ({ ...x, preuve: pr }))
    m.depot.etat.propositions.push({ id: 'p0', document_id: 'doc-1', departement: '54', saison: '2026-2027', type_acte: 'projet', decision: 'publie', annulee_le: null, created_at: '2026-05-01T00:00:00Z', payload: { periodes: periodesProjet } } as any)
    const stats = await m.lancer()
    expect(m.lecteur.requetes).toHaveLength(1)
    expect(m.lecteur.requetes[0].texte).toContain('mode script_projet_signe')
    expect(m.lecteur.requetes[0].texte).not.toContain('Article 1 :')
    const p = m.depot.etat.propositions[1]
    expect(p).toMatchObject({ mode: 'script_projet_signe', type_acte: 'annuel', c1: { ok: true } })
    expect(p.payload.periodes.map(x => x.preuve)).toEqual([P2.preuve, P1.preuve])
    expect(stats.publie).toBe(1)
  })

  it('projet lu comme signé : statut signé retenu et noté', async () => {
    const m = await monter([{ type: 'projet' }], [ok(sortie())])
    await m.lancer()
    const p = m.depot.etat.propositions[0]
    expect(p.payload.arrete.statut).toBe('signe'); expect(p.lecture.notes).toMatch(/projet lu comme signé/)
  })

  it('ponctuel : lecture réduite, ignore avec objet renseigné, aucune soumission', async () => {
    const pages = ["PRÉFET DE MEURTHE-ET-MOSELLE\nARRÊTÉ N° 2026/DDT/90 autorisant une battue administrative, campagne 2026-2027\nArticle 1 : Une battue est autorisée le 3 novembre 2026.\nFait à Nancy, le 20 octobre 2026"]
    const m = await monter([{ type: 'ponctuel', pages }], [ok(sortie({ periodes: [], acte: { ...ACTE, numero: '2026/DDT/90', date: '2026-10-20', objet: 'Battue administrative au sanglier' } }))])
    const stats = await m.lancer()
    expect(m.lecteur.requetes[0].texte).toContain('type ponctuel, mode script_projet_signe')
    expect(m.doc(0)).toMatchObject({ statut_traitement: 'ignore', erreur: 'ponctuel sans effet sur les dates', objet: 'Battue administrative au sanglier', numero_acte: '2026/DDT/90', date_acte: '2026-10-20' })
    expect(m.depot.etat.propositions).toHaveLength(0)
    expect(stats).toMatchObject({ ignores: 1, tokens: { input: 100, output: 50 } })
  })

  it('indéterminé : en_attente sans appel Claude, compté sans lecture', async () => {
    const m = await monter([{ type: 'indetermine' }], [])
    const stats = await m.lancer()
    expect(m.lecteur.requetes).toHaveLength(0)
    expect(m.doc(0)).toMatchObject({ statut_traitement: 'en_attente', erreur: 'type non déterminé mécaniquement' })
    expect(stats).toMatchObject({ sansLecture: 1, ignores: 0 })
  })

  it('saison lue différente de celle du document → erreur sans appel Claude', async () => {
    const m = await monter([{ pages: [AP[0].replace('2026-2027', '2025-2026')] }], [])
    await m.lancer()
    expect(m.lecteur.requetes).toHaveLength(0)
    expect(m.doc(0).erreur).toBe('lecture claude : saison lue 2025-2026 ≠ saison du document 2026-2027 (tentative 1)')
  })

  it('aucune saison dans l’en-tête : saison du document retenue, note', async () => {
    const m = await monter([{ pages: [AP[0].replace(' pour la campagne 2026-2027', '')] }], [ok(sortie())])
    await m.lancer()
    expect(m.depot.etat.propositions[0].lecture.notes).toMatch(/saison/)
  })

  it('document trop long → erreur sans appel Claude', async () => {
    const m = await monter([{ pages: [`${ENTETE}\nArticle 1 : sanglier du 1er juin 2026 au 28 février 2027 ${'x'.repeat(140_000)}`] }], [])
    const stats = await m.lancer()
    expect(m.lecteur.requetes).toHaveLength(0); expect(stats.erreurs).toBe(1)
    expect(m.doc(0).erreur).toMatch(/^lecture claude : document trop long \(\d+ tokens estimés\) \(tentative 1\)$/)
  })

  it('exception du lecteur → erreur, le passage continue', async () => {
    const m = await monter([{}, {}], [new Error('panne imprévue'), ok(sortie())])
    const stats = await m.lancer()
    expect(stats).toMatchObject({ erreurs: 1, publie: 1, traites: 2 })
    expect(m.doc(0).erreur).toBe('lecture claude : panne imprévue (tentative 1)')
  })

  it('échec de la RPC → erreur enregistrée, le passage continue', async () => {
    const m = await monter([{}], [ok(sortie())])
    m.depot.soumettre = async () => { throw new Error('soumettre : date invalide') }
    const stats = await m.lancer()
    expect(stats.erreurs).toBe(1)
    expect(m.doc(0)).toMatchObject({ statut_traitement: 'erreur', erreur: 'lecture claude : soumettre : date invalide (tentative 1)' })
  })

  it('payload hors vocabulaire → erreur avant la RPC', async () => {
    const loup = sortie({ periodes: [{ ...P1, espece_code: 'loup' }] })
    const m = await monter([{}], [ok(loup), ok(loup, 'opus')])
    await m.lancer()
    expect(m.depot.etat.propositions).toHaveLength(0)
    expect(m.doc(0).erreur).toMatch(/^lecture claude : payload refusé : espece hors vocabulaire: "loup"/)
  })

  it('erreur de lecture ancienne : relue, le compteur de tentatives avance', async () => {
    const m = await monter([{ statut: 'erreur', erreur: 'lecture claude : boum (tentative 1)', updated_at: '2026-10-13T00:00:00Z' }], [new Error('encore')])
    await m.lancer()
    expect(m.doc(0).erreur).toBe('lecture claude : encore (tentative 2)')
  })

  it('modificatif ne faisant que supprimer : proposition soumise, extrait source = citation de la suppression', async () => {
    const pages = [MODIF[0].replace(/Article 1 : .*/, 'Article 1 : La chasse du lièvre est suspendue du 1er octobre 2026 au 1er décembre 2026.')]
    const supp = { espece_code: 'lievre', sous_type: null, citation: 'La chasse du lièvre est suspendue', page: 1 }
    const m = await monter([{ type: 'modificatif', pages }], [ok(sortie({ periodes: [], suppressions: [supp] }))])
    m.depot.etat.publiees.push({ departement: '54', saison: '2026-2027', arrete: ARRETE, periodes: [publiee({}), publiee({ espece_code: 'lievre', date_ouverture: '2026-10-01', date_fermeture: '2026-12-01' })] })
    await m.lancer()
    expect(m.depot.etat.propositions).toHaveLength(1)
    const p = m.depot.etat.propositions[0]
    expect(p).toMatchObject({ mode: 'difference', suppression_explicite: true, c1: { ok: true } })
    expect(p.payload.preuve.extrait_source).toBe(supp.citation)
    expect(p.payload.periodes.map(x => x.espece_code)).toEqual(['sanglier'])
  })

  it('suppression et période lues : l’extrait source reste la citation d’une période', async () => {
    const pages = [MODIF[0].replace('Fait à', 'Article 2 : La chasse du lièvre est suspendue.\nFait à')]
    const supp = { espece_code: 'lievre', sous_type: null, citation: 'La chasse du lièvre est suspendue', page: 1 }
    const m = await monter([{ type: 'modificatif', pages }], [ok(sortie({ periodes: [P_MODIF], suppressions: [supp] }))])
    m.depot.etat.publiees.push({ departement: '54', saison: '2026-2027', arrete: ARRETE, periodes: [publiee({}), publiee({ espece_code: 'lievre', date_ouverture: '2026-10-01', date_fermeture: '2026-12-01' })] })
    await m.lancer()
    const p = m.depot.etat.propositions[0]
    expect(p).toMatchObject({ suppression_explicite: true, c1: { ok: true } })
    expect(p.payload.preuve.extrait_source).toBe(P_MODIF.preuve.citation)
    expect(p.payload.periodes.map(x => `${x.espece_code} ${x.date_ouverture}`)).toEqual(['sanglier 2026-06-15'])
  })

  it('notes de Claude dans le payload publié ; notes du robot seulement dans la lecture', async () => {
    const m = await monter([{ pages: [AP[0].replace(' pour la campagne 2026-2027', '')] }], [ok(sortie({ notes: 'Le loup relève de l’arrêté ministériel.' }))])
    await m.lancer()
    const p = m.depot.etat.propositions[0]
    expect(p.payload.notes).toBe('Le loup relève de l’arrêté ministériel.')
    expect(p.lecture.notes).toMatch(/^Le loup relève de l’arrêté ministériel\.\n.*saison/)
  })

  it('décision publie_note comptée à part', async () => {
    const m = await monter([{}], [ok(sortie())])
    const soumettre = m.depot.soumettre.bind(m.depot)
    m.depot.soumettre = async p => ({ ...(await soumettre(p)), decision: 'publie_note' as const })
    const stats = await m.lancer()
    expect(stats).toMatchObject({ publie: 0, publieNote: 1, enAttente: 0 })
    expect(stats.decisions).toEqual([{ documentId: 'doc-1', departement: '54', decision: 'publie_note' }])
  })

  it('journal défaillant après une soumission réussie : document jamais marqué en erreur', async () => {
    const m = await monter([{}], [ok(sortie())])
    const stats = await lireAvecClaude({ depot: m.depot, archive: m.archive, lecteur: m.lecteur, outils: {} as OutilsPdf, consigne: CONSIGNE, noms: NOMS,
      fichierTemp: async () => { throw new Error('inutile') }, now: () => NOW, log: () => { throw new Error('journal en panne') } }, { limite: 10 })
    expect(stats).toMatchObject({ publie: 1, erreurs: 0 })
    expect(m.depot.etat.propositions).toHaveLength(1)
    expect(m.doc(0)).toMatchObject({ statut_traitement: 'propose', erreur: null })
  })

  it('hors sujet ou texte absent : en_attente sans appel Claude, compté sans lecture', async () => {
    const m = await monter([{ type: 'hors_sujet' }, {}], [])
    m.doc(1).texte_r2_key = null
    const stats = await m.lancer()
    expect(m.lecteur.requetes).toHaveLength(0)
    expect(stats).toMatchObject({ sansLecture: 2, erreurs: 0 })
    expect(m.doc(0)).toMatchObject({ statut_traitement: 'en_attente', erreur: 'type hors_sujet : pas de lecture Claude' })
    expect(m.doc(1)).toMatchObject({ statut_traitement: 'en_attente', erreur: 'texte extrait absent : lecture Claude impossible' })
  })

  it('échéance dépassée : rien n’est lu, arrêt précoce', async () => {
    const m = await monter([{}], [ok(sortie())])
    const stats = await m.lancer({ echeance: new Date(NOW.getTime() - 1) })
    expect(stats).toMatchObject({ traites: 0, arretPrecoce: true })
    expect(m.lecteur.requetes).toHaveLength(0)
  })

  it('projet dont la proposition est en attente (C1 non vérifié) : jamais de raccourci, lecture complète', async () => {
    const m = await monter([{ type: 'projet', pages: PROJET, statut: 'propose' }, {}], [ok(sortie())])
    m.depot.etat.propositions.push({ id: 'p0', document_id: 'doc-1', departement: '54', saison: '2026-2027', type_acte: 'projet', decision: 'en_attente', annulee_le: null, created_at: '2026-05-01T00:00:00Z', payload: { periodes: [P1, P2] } } as any)
    await m.lancer()
    expect(m.lecteur.requetes[0].texte).toContain('mode complet')
    expect(m.depot.etat.propositions[1]).toMatchObject({ mode: 'complet', c1: { ok: true } })
  })

  it('erreur de plus de 2 000 caractères : le compteur de tentatives survit à la troncature', async () => {
    const m = await monter([{}], [new Error('x'.repeat(3000))])
    await m.lancer()
    const e1 = m.doc(0).erreur as string
    expect(e1.length).toBeLessThanOrEqual(2000)
    expect(e1.endsWith('(tentative 1)')).toBe(true)
    m.doc(0).updated_at = '2026-10-13T00:00:00Z'
    const m2 = await lireAvecClaude({ depot: m.depot, archive: m.archive, lecteur: { async lire() { throw new Error('y'.repeat(3000)) } }, outils: {} as OutilsPdf, consigne: CONSIGNE, noms: NOMS,
      fichierTemp: async () => { throw new Error('inutile') }, now: () => NOW }, { limite: 10 })
    expect(m2.erreurs).toBe(1)
    expect((m.doc(0).erreur as string).endsWith('(tentative 2)')).toBe(true)
  })

  it('soumission en échec alors que la proposition est enregistrée : document jamais re-marqué en erreur', async () => {
    const m = await monter([{}], [ok(sortie())])
    const soumettre = m.depot.soumettre.bind(m.depot)
    m.depot.soumettre = async p => { await soumettre(p); throw new Error('réponse perdue') }
    const stats = await m.lancer()
    expect(stats).toMatchObject({ erreurs: 0, traites: 1 })
    expect(m.depot.etat.propositions).toHaveLength(1)
    expect(m.doc(0)).toMatchObject({ statut_traitement: 'propose', erreur: null })
    expect(m.journal.some(l => /réponse perdue/.test(l) && /déjà enregistrée/.test(l))).toBe(true)
  })

  it('double lecture après une relance Opus : le modèle tracé est celui de la lecture retenue (Sonnet)', async () => {
    const s = sortie({ periodes: [P1, { ...P2, preuve: preuve("à l'approche du 1er juin 2026 au 28 février 2027") }] })
    const m = await monter([{}], [echec('schema'), ok(s, 'opus'), ok(s, 'sonnet'), ok(s, 'sonnet')])
    await m.lancer()
    expect(m.depot.etat.propositions[0].lecture).toMatchObject({ modele: 'sonnet', relance_opus: true, double_lecture: true })
  })

  it('département lu : forme longue ramenée au nom officiel ; autre département gardé tel quel et noté', async () => {
    const a = await monter([{}], [ok(sortie({ acte: { ...ACTE, departement_lu: 'Préfecture de Meurthe-et-Moselle' } }))])
    await a.lancer()
    expect(a.depot.etat.propositions[0].payload.preuve.dept_detecte).toBe('Meurthe-et-Moselle')
    const b = await monter([{}], [ok(sortie({ acte: { ...ACTE, departement_lu: 'Moselle' } }))])
    await b.lancer()
    const p = b.depot.etat.propositions[0]
    expect(p.payload.preuve.dept_detecte).toBe('Moselle')
    expect(p.lecture.notes).toMatch(/département lu « Moselle » ≠ département attendu « Meurthe-et-Moselle »/)
  })
})
