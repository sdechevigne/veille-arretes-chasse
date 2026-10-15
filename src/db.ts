// Accès aux tables arretes_sources / arretes_documents (service_role) + double mémoire pour les tests.
import { createClient } from '@supabase/supabase-js'
import type { Source, DocumentDecouvert, LectureMecanique, StatutTraitement, TypeDetecte, QualiteTexte, PropositionRobot, ResultatSoumission } from './types.ts'
import type { PeriodePubliee } from './difference.ts'
import type { PeriodePayload } from './payload.ts'

export interface DocumentEnBase extends DocumentDecouvert {
  id: string; statut_traitement: StatutTraitement; decouvert_le: string; updated_at?: string
  type_detecte: TypeDetecte | null; qualite_texte: QualiteTexte | null; texte_r2_key: string | null; erreur: string | null
  numero_acte?: string | null; date_acte?: string | null; objet?: string | null
}
/** Ligne `arretes` publiée (`type_arrete = 'prefectoral_general'`) d'un couple département / saison. */
export interface ArretePublie { id: string; updated_at: string; statut: string; url_source: string | null; numero_arrete: string | null; date_signature: string | null }
export interface VersionPubliee { arrete: ArretePublie | null; periodes: PeriodePubliee[] }
/** Proposition telle qu'enregistrée (double mémoire). */
export type PropositionEnBase = PropositionRobot & { id: string; decision: string; annulee_le: string | null; created_at: string }
export interface Depot {
  sourcesActives(): Promise<Source[]>
  majSanteSource(id: string, ok: boolean, statut: string): Promise<void>
  shaConnus(shas: string[]): Promise<Set<string>>
  urlsVuesDepuis(jours: number): Promise<Set<string>>
  creerDocument(d: DocumentDecouvert): Promise<string>
  documentsParStatut(statut: StatutTraitement, limite: number): Promise<DocumentEnBase[]>
  majLecture(id: string, l: LectureMecanique & { texte_r2_key: string | null }): Promise<void>
  marquerErreur(id: string, message: string): Promise<void>
  /** Documents à lire par Claude : `a_lire` (ordre de découverte), puis erreurs de lecture Claude rejouables (> 24 h, < 3 tentatives).
   *  `departements` (non vide) restreint la file avant la limite. */
  documentsALire(limite: number, maintenant?: Date, departements?: string[]): Promise<DocumentEnBase[]>
  versionPubliee(departement: string, saison: string): Promise<VersionPubliee>
  /** Dernière proposition `projet` encore valable du couple (ni annulée, ni rejetée) : texte de son document et périodes. */
  propositionProjet(departement: string, saison: string): Promise<{ texte_r2_key: string; periodes: PeriodePayload[] } | null>
  soumettre(p: PropositionRobot): Promise<ResultatSoumission>
  marquerIgnore(id: string, motif: string, acte: { numero: string | null; date: string | null; objet: string | null }): Promise<void>
  majStatut(id: string, statut: StatutTraitement, motif: string): Promise<void>
}
const lancer = (ctx: string, error: { message: string } | null) => { if (error) throw new Error(`${ctx} : ${error.message}`) }

/** Un document avec ce sha256 existe déjà (violation d'unicité Postgres 23505). */
export class DoublonShaError extends Error {
  constructor(readonly sha256: string) { super(`sha256 en double : ${sha256}`); this.name = 'DoublonShaError' }
}

const TAILLE_PAGE = 1000 // plafond de lignes par requête PostgREST
const TAILLE_LOT_IN = 100 // taille max d'une liste .in() (limite d'URL)
export const PREFIXE_ERREUR_LECTURE = 'lecture claude :'
const TENTATIVES_MAX = 3
const DELAI_REJEU_MS = 24 * 3600e3
/** Nombre de tentatives de lecture Claude déjà faites, lu dans le message d'erreur (`… (tentative N)`). */
export function tentativesLecture(erreur: string | null | undefined): number {
  if (!erreur?.startsWith(PREFIXE_ERREUR_LECTURE)) return 0
  const m = /\(tentative (\d+)\)$/.exec(erreur)
  return m ? Number(m[1]) : 1
}
const rejouable = (d: Pick<DocumentEnBase, 'erreur'>) => tentativesLecture(d.erreur) > 0 && tentativesLecture(d.erreur) < TENTATIVES_MAX
const COLONNES_PERIODE = 'id, espece_code, sous_type, date_ouverture, date_fermeture, mode_chasse, restriction_dates, source_article, zone_libelle, zone_geojson'

const STATUT_SANTE = /^(ok|http_[0-9]{3}|aucun_pdf|structure_changee|erreur_reseau)$/ // miroir de la CHECK en base

/** Parcourt toutes les pages d'une requête PostgREST (tri stable exigé côté appelant). */
export async function toutesLesPages<T>(ctx: string, page: (de: number, a: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>): Promise<T[]> {
  const lignes: T[] = []
  for (let de = 0; ; de += TAILLE_PAGE) {
    const { data, error } = await page(de, de + TAILLE_PAGE - 1); lancer(ctx, error)
    lignes.push(...(data ?? []))
    if ((data ?? []).length < TAILLE_PAGE) return lignes
  }
}

export function enLots<T>(elements: T[], taille: number): T[][] {
  const lots: T[][] = []
  for (let i = 0; i < elements.length; i += taille) lots.push(elements.slice(i, i + taille))
  return lots
}

export function creerDepotSupabase(url: string, serviceRoleKey: string): Depot {
  const sb = createClient(url, serviceRoleKey, { auth: { persistSession: false, autoRefreshToken: false } }) as any
  return {
    async sourcesActives() { return toutesLesPages<Source>('sourcesActives', (de, a) => sb.from('arretes_sources').select('id, departement, type_source, url, actif, verifiee_le, echecs_consecutifs').eq('actif', true).order('departement').order('id').range(de, a)) },
    async majSanteSource(id, ok, statut) {
      const now = new Date().toISOString()
      const { data: cur, error: e1 } = await sb.from('arretes_sources').select('echecs_consecutifs').eq('id', id).single(); lancer('majSanteSource/lecture', e1)
      const patch = ok ? { derniere_visite_at: now, dernier_succes_at: now, dernier_statut: statut, echecs_consecutifs: 0, verifiee_le: now }
                       : { derniere_visite_at: now, dernier_statut: statut, echecs_consecutifs: (cur?.echecs_consecutifs ?? 0) + 1 }
      const { error } = await sb.from('arretes_sources').update(patch).eq('id', id); lancer('majSanteSource', error)
    },
    async shaConnus(shas) {
      const connus = new Set<string>()
      for (const lot of enLots(shas, TAILLE_LOT_IN)) {
        const { data, error } = await sb.from('arretes_documents').select('sha256').in('sha256', lot); lancer('shaConnus', error)
        for (const r of data ?? []) connus.add(r.sha256)
      }
      return connus
    },
    async urlsVuesDepuis(jours) {
      const depuis = new Date(Date.now() - jours * 86400e3).toISOString()
      const lignes = await toutesLesPages<{ url: string }>('urlsVuesDepuis', (de, a) => sb.from('arretes_documents').select('url').gte('decouvert_le', depuis).order('id').range(de, a))
      return new Set(lignes.map(r => r.url))
    },
    async creerDocument(d) {
      const { data, error } = await sb.from('arretes_documents').insert(d).select('id').single()
      if (error?.code === '23505') throw new DoublonShaError(d.sha256)
      lancer('creerDocument', error); return data.id
    },
    async documentsParStatut(statut, limite) { const { data, error } = await sb.from('arretes_documents').select('*').eq('statut_traitement', statut).order('decouvert_le').limit(limite); lancer('documentsParStatut', error); return data ?? [] },
    async majLecture(id, l) { const { error } = await sb.from('arretes_documents').update({ type_detecte: l.type_detecte, numero_acte: l.numero_acte, date_acte: l.date_acte, objet: l.objet, qualite_texte: l.qualite_texte, pages_retenues: l.pages_retenues, texte_r2_key: l.texte_r2_key, statut_traitement: l.statut, erreur: l.motif_ignore?.slice(0, 2000) ?? null }).eq('id', id); lancer('majLecture', error) },
    async marquerErreur(id, message) { const { error } = await sb.from('arretes_documents').update({ statut_traitement: 'erreur', erreur: message.slice(0, 2000) }).eq('id', id); lancer('marquerErreur', error) },
    async documentsALire(limite, maintenant = new Date(), departements) {
      const filtrer = (q: any) => departements?.length ? q.in('departement', departements) : q
      const { data, error } = await filtrer(sb.from('arretes_documents').select('*').eq('statut_traitement', 'a_lire')).order('decouvert_le').order('id').limit(limite); lancer('documentsALire', error)
      const aLire: DocumentEnBase[] = data ?? []
      if (aLire.length >= limite) return aLire
      // Le compteur de tentatives est dans le texte : filtrage final côté robot (ces lignes restent peu nombreuses).
      const avant = new Date(maintenant.getTime() - DELAI_REJEU_MS).toISOString()
      const erreurs = await toutesLesPages<DocumentEnBase>('documentsALire/erreurs', (de, a) => filtrer(sb.from('arretes_documents').select('*').eq('statut_traitement', 'erreur'))
        .like('erreur', `${PREFIXE_ERREUR_LECTURE}%`).lt('updated_at', avant).order('decouvert_le').order('id').range(de, a))
      return [...aLire, ...erreurs.filter(rejouable)].slice(0, limite)
    },
    async versionPubliee(departement, saison) {
      const { data: arrete, error } = await sb.from('arretes').select('id, updated_at, statut, url_source, numero_arrete, date_signature')
        .eq('departement', departement).eq('saison', saison).eq('type_arrete', 'prefectoral_general').maybeSingle(); lancer('versionPubliee', error)
      if (!arrete) return { arrete: null, periodes: [] }
      const periodes = await toutesLesPages<PeriodePubliee>('versionPubliee/periodes', (de, a) => sb.from('periodes_chasse').select(COLONNES_PERIODE).eq('arrete_id', arrete.id).order('id').range(de, a))
      return { arrete, periodes }
    },
    async propositionProjet(departement, saison) {
      const { data: prop, error } = await sb.from('arretes_propositions').select('document_id, payload').eq('departement', departement).eq('saison', saison)
        .eq('type_acte', 'projet').is('annulee_le', null).neq('decision', 'rejete').order('created_at', { ascending: false }).limit(1).maybeSingle(); lancer('propositionProjet', error)
      if (!prop) return null
      // Document disparu ou sans texte : pas de raccourci (lecture complète).
      const { data: doc, error: e2 } = await sb.from('arretes_documents').select('texte_r2_key').eq('id', prop.document_id).maybeSingle(); lancer('propositionProjet/document', e2)
      return doc?.texte_r2_key ? { texte_r2_key: doc.texte_r2_key, periodes: prop.payload?.periodes ?? [] } : null
    },
    async soumettre(p) { const { data, error } = await sb.rpc('robot_soumettre_proposition', { p_proposition: p }); lancer('soumettre', error); return data },
    async marquerIgnore(id, motif, acte) { const { error } = await sb.from('arretes_documents').update({ statut_traitement: 'ignore', erreur: motif.slice(0, 2000), numero_acte: acte.numero, date_acte: acte.date, objet: acte.objet }).eq('id', id); lancer('marquerIgnore', error) },
    async majStatut(id, statut, motif) { const { error } = await sb.from('arretes_documents').update({ statut_traitement: statut, erreur: motif.slice(0, 2000) }).eq('id', id); lancer('majStatut', error) },
  }
}

export interface EtatMemoire {
  sources: Source[]; documents: DocumentEnBase[]; propositions: PropositionEnBase[]
  publiees: { departement: string; saison: string; arrete: ArretePublie; periodes: PeriodePubliee[] }[]
}
export function creerDepotMemoire(): Depot & { etat: EtatMemoire } {
  const etat: EtatMemoire = { sources: [], documents: [], propositions: [], publiees: [] }; let seq = 0
  const docDe = (id: string) => etat.documents.find(d => d.id === id)
  return {
    etat,
    async sourcesActives() { return etat.sources.filter(s => s.actif) },
    async majSanteSource(id, ok, statut) { if (!STATUT_SANTE.test(statut)) throw new Error(`dernier_statut invalide : ${statut}`); const s = etat.sources.find(s => s.id === id)!; (s as any).dernier_statut = statut; if (ok) { s.echecs_consecutifs = 0; s.verifiee_le = new Date().toISOString() } else s.echecs_consecutifs += 1 },
    async shaConnus(shas) { return new Set(etat.documents.filter(d => shas.includes(d.sha256)).map(d => d.sha256)) },
    async urlsVuesDepuis(jours) { const depuis = Date.now() - jours * 86400e3; return new Set(etat.documents.filter(d => Date.parse(d.decouvert_le) >= depuis).map(d => d.url)) },
    async creerDocument(d) { if (etat.documents.some(x => x.sha256 === d.sha256)) throw new DoublonShaError(d.sha256); const id = `doc-${++seq}`; etat.documents.push({ ...d, id, statut_traitement: 'a_extraire', decouvert_le: new Date().toISOString(), type_detecte: null, qualite_texte: null, texte_r2_key: null, erreur: null }); return id },
    async documentsParStatut(statut, limite) { return etat.documents.filter(d => d.statut_traitement === statut).slice(0, limite) },
    async majLecture(id, l) { const d = etat.documents.find(d => d.id === id)!; Object.assign(d, { type_detecte: l.type_detecte, numero_acte: l.numero_acte, date_acte: l.date_acte, objet: l.objet, qualite_texte: l.qualite_texte, pages_retenues: l.pages_retenues, texte_r2_key: l.texte_r2_key, statut_traitement: l.statut, erreur: l.motif_ignore?.slice(0, 2000) ?? null }) },
    async marquerErreur(id, message) { const d = etat.documents.find(d => d.id === id)!; d.statut_traitement = 'erreur'; d.erreur = message.slice(0, 2000) },
    async documentsALire(limite, maintenant = new Date(), departements) {
      const retenu = (d: DocumentEnBase) => !departements?.length || departements.includes(d.departement)
      const parDecouverte = (a: DocumentEnBase, b: DocumentEnBase) => a.decouvert_le.localeCompare(b.decouvert_le)
      const avant = maintenant.getTime() - DELAI_REJEU_MS
      const aLire = etat.documents.filter(d => d.statut_traitement === 'a_lire' && retenu(d)).sort(parDecouverte)
      const erreurs = etat.documents.filter(d => d.statut_traitement === 'erreur' && retenu(d) && rejouable(d) && Date.parse(d.updated_at ?? d.decouvert_le) < avant).sort(parDecouverte)
      return [...aLire, ...erreurs].slice(0, limite)
    },
    async versionPubliee(departement, saison) {
      const v = etat.publiees.find(p => p.departement === departement && p.saison === saison)
      return v ? { arrete: v.arrete, periodes: v.periodes } : { arrete: null, periodes: [] }
    },
    async propositionProjet(departement, saison) {
      const p = etat.propositions.filter(p => p.departement === departement && p.saison === saison && p.type_acte === 'projet' && p.annulee_le === null && p.decision !== 'rejete')
        .sort((a, b) => b.created_at.localeCompare(a.created_at))[0]
      const cle = p && docDe(p.document_id)?.texte_r2_key
      return cle ? { texte_r2_key: cle, periodes: p.payload.periodes } : null
    },
    // Miroir des refus d'entrée de la RPC ; décision simplifiée (C1 seul), jamais d'écriture (mode observation).
    async soumettre(p) {
      const d = docDe(p.document_id)
      if (!d) throw new Error('soumettre : document inconnu')
      if (!['a_lire', 'erreur'].includes(d.statut_traitement)) throw new Error(`soumettre : document déjà traité (statut ${d.statut_traitement})`)
      if (p.departement !== d.departement || p.saison !== d.saison || p.departement !== p.payload.departement || p.saison !== p.payload.saison)
        throw new Error(`soumettre : proposition invalide : département / saison incohérents avec le document (${d.departement}/${d.saison}) ou le payload`)
      const decision = p.c1.ok ? 'publie' as const : 'en_attente' as const
      const id = `prop-${etat.propositions.length + 1}`
      etat.propositions.push({ ...p, id, decision, annulee_le: null, created_at: new Date().toISOString() })
      Object.assign(d, { statut_traitement: decision === 'en_attente' ? 'en_attente' : 'propose', numero_acte: p.acte.numero ?? d.numero_acte, date_acte: p.acte.date ?? d.date_acte, objet: p.acte.objet ?? d.objet, erreur: null })
      const muet = { statut: 'muet' as const, details: [] }
      return { id, decision, ecrit: false, mode_reglage: 'observation', controles: { c1: { statut: p.c1.ok ? 'ok' : 'bloquant', details: p.c1.details }, c2: muet, c3: muet, c4: muet, c5: muet, c6: muet }, motif: p.c1.ok ? 'contrôles au vert' : 'C1 en échec' }
    },
    async marquerIgnore(id, motif, acte) { Object.assign(docDe(id)!, { statut_traitement: 'ignore', erreur: motif.slice(0, 2000), numero_acte: acte.numero, date_acte: acte.date, objet: acte.objet }) },
    async majStatut(id, statut, motif) { Object.assign(docDe(id)!, { statut_traitement: statut, erreur: motif.slice(0, 2000) }) },
  }
}
