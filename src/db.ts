// Accès aux tables arretes_sources / arretes_documents (service_role) + double mémoire pour les tests.
import { createClient } from '@supabase/supabase-js'
import type { Source, DocumentDecouvert, LectureMecanique, StatutTraitement } from './types.ts'

export interface DocumentEnBase extends DocumentDecouvert { id: string; statut_traitement: StatutTraitement; decouvert_le: string }
export interface Depot {
  sourcesActives(): Promise<Source[]>
  majSanteSource(id: string, ok: boolean, statut: string): Promise<void>
  shaConnus(shas: string[]): Promise<Set<string>>
  urlsVuesDepuis(jours: number): Promise<Set<string>>
  creerDocument(d: DocumentDecouvert): Promise<string>
  documentsParStatut(statut: StatutTraitement, limite: number): Promise<DocumentEnBase[]>
  majLecture(id: string, l: LectureMecanique & { texte_r2_key: string | null }): Promise<void>
  marquerErreur(id: string, message: string): Promise<void>
}
const lancer = (ctx: string, error: { message: string } | null) => { if (error) throw new Error(`${ctx} : ${error.message}`) }

export function creerDepotSupabase(url: string, serviceRoleKey: string): Depot {
  const sb = createClient(url, serviceRoleKey, { auth: { persistSession: false, autoRefreshToken: false } }) as any
  return {
    async sourcesActives() { const { data, error } = await sb.from('arretes_sources').select('id, departement, type_source, url, actif, verifiee_le, echecs_consecutifs').eq('actif', true).order('departement'); lancer('sourcesActives', error); return data ?? [] },
    async majSanteSource(id, ok, statut) {
      const now = new Date().toISOString()
      const { data: cur, error: e1 } = await sb.from('arretes_sources').select('echecs_consecutifs').eq('id', id).single(); lancer('majSanteSource/lecture', e1)
      const patch = ok ? { derniere_visite_at: now, dernier_succes_at: now, dernier_statut: statut, echecs_consecutifs: 0, verifiee_le: now }
                       : { derniere_visite_at: now, dernier_statut: statut, echecs_consecutifs: (cur?.echecs_consecutifs ?? 0) + 1 }
      const { error } = await sb.from('arretes_sources').update(patch).eq('id', id); lancer('majSanteSource', error)
    },
    async shaConnus(shas) { if (!shas.length) return new Set(); const { data, error } = await sb.from('arretes_documents').select('sha256').in('sha256', shas); lancer('shaConnus', error); return new Set((data ?? []).map((r: any) => r.sha256)) },
    async urlsVuesDepuis(jours) { const depuis = new Date(Date.now() - jours * 86400e3).toISOString(); const { data, error } = await sb.from('arretes_documents').select('url').gte('decouvert_le', depuis); lancer('urlsVuesDepuis', error); return new Set((data ?? []).map((r: any) => r.url)) },
    async creerDocument(d) { const { data, error } = await sb.from('arretes_documents').insert(d).select('id').single(); lancer('creerDocument', error); return data.id },
    async documentsParStatut(statut, limite) { const { data, error } = await sb.from('arretes_documents').select('*').eq('statut_traitement', statut).order('decouvert_le').limit(limite); lancer('documentsParStatut', error); return data ?? [] },
    async majLecture(id, l) { const { error } = await sb.from('arretes_documents').update({ type_detecte: l.type_detecte, numero_acte: l.numero_acte, date_acte: l.date_acte, objet: l.objet, qualite_texte: l.qualite_texte, pages_retenues: l.pages_retenues, texte_r2_key: l.texte_r2_key, statut_traitement: l.statut, erreur: l.motif_ignore ?? null }).eq('id', id); lancer('majLecture', error) },
    async marquerErreur(id, message) { const { error } = await sb.from('arretes_documents').update({ statut_traitement: 'erreur', erreur: message.slice(0, 2000) }).eq('id', id); lancer('marquerErreur', error) },
  }
}

export function creerDepotMemoire(): Depot & { etat: { sources: Source[]; documents: DocumentEnBase[] } } {
  const etat = { sources: [] as Source[], documents: [] as DocumentEnBase[] }; let seq = 0
  return {
    etat,
    async sourcesActives() { return etat.sources.filter(s => s.actif) },
    async majSanteSource(id, ok, statut) { const s = etat.sources.find(s => s.id === id)!; (s as any).dernier_statut = statut; if (ok) { s.echecs_consecutifs = 0; s.verifiee_le = new Date().toISOString() } else s.echecs_consecutifs += 1 },
    async shaConnus(shas) { return new Set(etat.documents.filter(d => shas.includes(d.sha256)).map(d => d.sha256)) },
    async urlsVuesDepuis(jours) { const depuis = Date.now() - jours * 86400e3; return new Set(etat.documents.filter(d => Date.parse(d.decouvert_le) >= depuis).map(d => d.url)) },
    async creerDocument(d) { if (etat.documents.some(x => x.sha256 === d.sha256)) throw new Error('sha256 en double'); const id = `doc-${++seq}`; etat.documents.push({ ...d, id, statut_traitement: 'a_extraire', decouvert_le: new Date().toISOString() }); return id },
    async documentsParStatut(statut, limite) { return etat.documents.filter(d => d.statut_traitement === statut).slice(0, limite) },
    async majLecture(id, l) { const d = etat.documents.find(d => d.id === id)!; Object.assign(d, { type_detecte: l.type_detecte, numero_acte: l.numero_acte, date_acte: l.date_acte, objet: l.objet, qualite_texte: l.qualite_texte, pages_retenues: l.pages_retenues, texte_r2_key: l.texte_r2_key, statut_traitement: l.statut, erreur: l.motif_ignore ?? null }) },
    async marquerErreur(id, message) { const d = etat.documents.find(d => d.id === id)!; d.statut_traitement = 'erreur'; (d as any).erreur = message },
  }
}
