// Types partagés du robot de veille (miroir des tables arretes_sources / arretes_documents).
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

export interface Telechargement { statut: number; octets: Buffer; urlFinale: string; contentType: string | null; erreur?: string }
export interface Telechargeur { telecharger(url: string): Promise<Telechargement> }
