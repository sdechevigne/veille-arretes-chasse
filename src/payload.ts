// Payload consolidé pour `_apply_arrete_core` et refus locaux (avant tout appel réseau). Module pur.
import type { PeriodePubliee } from './difference.ts'
import type { ActeLu, PeriodeLue } from './types.ts'
import { ESPECES, MODES, SOUS_TYPES } from './vocabulaire.ts'

export interface PreuveCore {
  code_detecte: string; dept_detecte: string; millesime_detecte: string; signature_detectee: string; extrait_source: string
}
export interface PeriodePayload {
  espece_code: string; sous_type: string | null; date_ouverture: string; date_fermeture: string
  mode_chasse: string | null; restriction_dates: string | null; source_article: string | null
  zone_libelle?: string; zone_geojson?: unknown
  preuve?: PeriodeLue['preuve']
}
export interface PayloadCore {
  departement: string; saison: string; strict: true
  arrete: { statut: 'signe' | 'en_attente_signature'; date_signature: string | null; numero_arrete: string | null; url_source: string; url_consultation: null }
  notes: string | null
  periodes: PeriodePayload[]
  preuve?: PreuveCore
}
export interface EntreePayload {
  departement: string; saison: string; statut: 'signe' | 'en_attente_signature'; acte: ActeLu; url: string
  periodes: (PeriodeLue | PeriodePubliee)[]; notes: string; preuveCore: PreuveCore
}

const STATUTS = ['signe', 'en_attente_signature']
const RE_ISO = /^(\d{4})-(\d{2})-(\d{2})$/

// Convention : « cerf » sans précision = cerf_elaphe.
const sousTypeCanon = (espece: string, sousType: string | null | undefined): string | null =>
  espece === 'cerf' && sousType == null ? 'cerf_elaphe' : (sousType ?? null)

function periodePayload(p: PeriodeLue | PeriodePubliee): PeriodePayload {
  const r: PeriodePayload = {
    espece_code: p.espece_code, sous_type: sousTypeCanon(p.espece_code, p.sous_type),
    date_ouverture: p.date_ouverture, date_fermeture: p.date_fermeture, mode_chasse: p.mode_chasse || 'tous_modes',
    restriction_dates: p.restriction_dates ?? null, source_article: p.source_article ?? null,
  }
  const pub = p as PeriodePubliee
  if (pub.zone_libelle != null) r.zone_libelle = pub.zone_libelle
  if (pub.zone_geojson != null) r.zone_geojson = pub.zone_geojson
  if (pub.preuve) r.preuve = pub.preuve
  return r
}

const comparer = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)

export function construirePayload(p: EntreePayload): PayloadCore {
  const signe = p.statut === 'signe'
  const periodes = p.periodes.map(periodePayload).sort((a, b) =>
    comparer(a.espece_code, b.espece_code) || comparer(a.sous_type ?? '', b.sous_type ?? '')
    || comparer(a.date_ouverture, b.date_ouverture) || comparer(a.mode_chasse, b.mode_chasse))
  return {
    departement: p.departement, saison: p.saison, strict: true,
    arrete: { statut: p.statut, date_signature: signe ? p.acte.date : null, numero_arrete: p.acte.numero ?? null, url_source: p.url, url_consultation: null },
    notes: p.notes || null, periodes, preuve: { ...p.preuveCore },
  }
}

// Date ISO réelle (format AAAA-MM-JJ et jour existant au calendrier).
function dateValide(d: string): boolean {
  const m = RE_ISO.exec(d ?? '')
  if (!m) return false
  const t = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]))
  return t.getUTCFullYear() === +m[1] && t.getUTCMonth() === +m[2] - 1 && t.getUTCDate() === +m[3]
}

// Reproduit les refus de `_apply_arrete_core` vérifiables sans la base (messages identiques) ; [] = payload sain.
// Non vérifiable ici : `departement inconnu` et la comparaison de `dept_detecte` au nom officiel.
export function validerVocabulaire(payload: PayloadCore): string[] {
  const e: string[] = []
  const saison = /^(\d{4})-(\d{4})$/.exec(payload.saison ?? '')
  let an1 = 0, an2 = 0
  if (!saison) e.push(`saison invalide: "${payload.saison}"`)
  else if (+saison[2] !== +saison[1] + 1) e.push(`saison non consecutive: "${payload.saison}"`)
  else { an1 = +saison[1]; an2 = +saison[2] }

  const a = payload.arrete
  if (!STATUTS.includes(a.statut)) e.push(`statut hors vocabulaire: "${a.statut}"`)
  if (a.statut === 'signe' && !a.date_signature) e.push('statut "signe" mais date_signature absente')
  if (!a.url_source?.trim()) e.push('url_source absente')

  for (const per of payload.periodes) {
    if (!(ESPECES as readonly string[]).includes(per.espece_code)) e.push(`espece hors vocabulaire: "${per.espece_code}"`)
    if (per.mode_chasse != null && !(MODES as readonly string[]).includes(per.mode_chasse)) e.push(`mode hors vocabulaire: "${per.mode_chasse}"`)
    if (per.sous_type != null && !(SOUS_TYPES as readonly string[]).includes(per.sous_type)) e.push(`sous_type hors vocabulaire: "${per.sous_type}"`)
    const valides = (['date_ouverture', 'date_fermeture'] as const).map(c => {
      if (!dateValide(per[c])) { e.push(`${c} invalide: "${per[c]}"`); return false }
      if (an1 && ![an1, an2].includes(+per[c].slice(0, 4))) e.push(`${c} hors saison: ${per[c]}`)
      return true
    })
    if (an1 && valides[0] && valides[1] && per.date_ouverture > per.date_fermeture && +per.date_fermeture.slice(0, 4) !== an2)
      e.push(`dates inversees: ${per.espece_code} ${per.date_ouverture}>${per.date_fermeture}`)
  }
  if (!payload.periodes.length) e.push('aucune periode datee')

  if ((payload.strict as boolean | undefined) !== false && a.statut === 'signe') {
    const pr = payload.preuve
    if (!pr) e.push('bloc preuve absent (strict + signe)')
    else {
      if (pr.code_detecte !== payload.departement) e.push(`preuve.code_detecte "${pr.code_detecte}" != departement "${payload.departement}"`)
      if (!pr.dept_detecte?.trim()) e.push('preuve.dept_detecte vide')
      if (pr.millesime_detecte !== payload.saison) e.push(`preuve.millesime_detecte "${pr.millesime_detecte}" != saison "${payload.saison}"`)
      if (!pr.signature_detectee?.trim()) e.push('preuve.signature_detectee vide')
      if (!pr.extrait_source?.trim()) e.push('preuve.extrait_source vide')
    }
  }
  return e
}
