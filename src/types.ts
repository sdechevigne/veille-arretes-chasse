// Types partagés du robot de veille (miroir des tables arretes_sources / arretes_documents).
import type { PayloadCore } from './payload.ts'
export type TypeSource = 'prefecture_chasse' | 'prefecture_raa' | 'prefecture_consultation' | 'federation'
export type TypeDetecte = 'projet' | 'annuel' | 'modificatif' | 'esod' | 'ponctuel' | 'hors_sujet' | 'indetermine'
export type QualiteTexte = 'native' | 'ocr_ok' | 'ocr_douteux'
export type StatutTraitement = 'a_extraire' | 'a_lire' | 'propose' | 'publie' | 'en_attente' | 'rejete' | 'ignore' | 'erreur'

export interface Source {
  id: string; departement: string; type_source: TypeSource; url: string; actif: boolean
  verifiee_le: string | null; echecs_consecutifs: number
}

export interface DocumentDecouvert {
  departement: string; saison: string; source_id: string | null; url: string; titre: string | null
  sha256: string; r2_key: string; taille_octets: number
}

export interface PageTexte {
  n: number; source: 'native' | 'ocr' | 'erreur'; texte: string
  nbDates: number; nbEspeces: number; erreur?: string
}

export interface LectureMecanique {
  type_detecte: TypeDetecte; numero_acte: string | null; date_acte: string | null; objet: string | null
  qualite_texte: QualiteTexte; pages_retenues: number[]; statut: 'a_lire' | 'ignore'; motif_ignore?: string
}

export interface Telechargement { statut: number; octets: Buffer; urlFinale: string; contentType: 'application/pdf' | null; erreur?: string }
export interface Telechargeur { telecharger(url: string): Promise<Telechargement> }

/** Une période lue par Claude, avec sa preuve (spec partie 2 §2-§3). */
export interface PeriodeLue {
  espece_code: string; sous_type: 'cerf_elaphe' | 'cerf_sika' | 'perdrix_grise' | 'perdrix_rouge' | null
  date_ouverture: string; date_fermeture: string; mode_chasse: string
  restriction_dates: string | null; source_article: string | null
  preuve: { article: string | null; citation: string; page: number; annee_deduite: boolean }
}
export interface ActeLu { numero: string | null; date: string | null; objet: string; signe: boolean; departement_lu: string | null; saison_lue: string | null }
/** Sortie JSON imposée à Claude par schéma. */
export interface LectureClaude {
  acte: ActeLu; periodes: PeriodeLue[]
  suppressions: { espece_code: string; sous_type: string | null; citation: string; page: number }[]
  notes: string
}
export interface Article { numero: string | null; titre: string; pageDebut: number; texte: string }

/** Proposition soumise à `robot_soumettre_proposition` (contrat partagé, README phase 3). */
export interface PropositionRobot {
  document_id: string; departement: string; saison: string
  mode: 'complet' | 'difference' | 'script_projet_signe'
  type_acte: 'projet' | 'annuel' | 'modificatif' | 'esod'
  payload: PayloadCore
  acte: { numero: string | null; date: string | null; objet: string }
  base_arrete_maj: string | null
  c1: { ok: boolean; details: string[] }
  lecture: { modele: string; relance_opus: boolean; double_lecture: boolean; usage: { input: number; output: number; cache_creation: number; cache_read: number }; notes: string }
  suppression_explicite: boolean
}
export type StatutControle = 'ok' | 'note' | 'bloquant' | 'muet'
/** Résultat de `robot_soumettre_proposition`. */
export interface ResultatSoumission {
  id: string; decision: 'publie' | 'publie_note' | 'en_attente'; ecrit: boolean; mode_reglage: 'observation' | 'auto'
  controles: Record<'c1' | 'c2' | 'c3' | 'c4' | 'c5' | 'c6', { statut: StatutControle; details: string[] }>
  motif: string
}
