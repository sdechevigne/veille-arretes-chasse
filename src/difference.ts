// Mode différence : applique la lecture d'un modificatif sur les périodes déjà publiées. Module pur.
import type { LectureClaude, PeriodeLue } from './types.ts'

export interface PeriodePubliee {
  id?: string; espece_code: string; sous_type: string | null; date_ouverture: string; date_fermeture: string
  mode_chasse: string; restriction_dates: string | null; source_article: string | null
  zone_libelle?: string | null; zone_geojson?: unknown
  preuve?: PeriodeLue['preuve']
}

// Convention : « cerf » sans précision = cerf_elaphe (une publiée cerf/null correspond à une lue cerf_elaphe).
const sousTypeCanon = (espece: string, sousType: string | null | undefined): string | null =>
  espece === 'cerf' && sousType == null ? 'cerf_elaphe' : (sousType ?? null)
const mode = (p: PeriodePubliee): string => p.mode_chasse || 'tous_modes'
const cleEspece = (p: PeriodePubliee): string => `${p.espece_code}|${sousTypeCanon(p.espece_code, p.sous_type) ?? ''}`
const cle = (p: PeriodePubliee): string => `${cleEspece(p)}|${mode(p)}`
const plage = (ps: PeriodePubliee[]): string => ps.map(p => `${p.date_ouverture}→${p.date_fermeture}`).join(' + ')
const signature = (p: PeriodePubliee): string => `${p.date_ouverture}→${p.date_fermeture}|${p.restriction_dates ?? ''}`
const memesPeriodes = (a: PeriodePubliee[], b: PeriodePubliee[]): boolean => {
  const x = a.map(signature).sort(), y = b.map(signature).sort()
  return x.length === y.length && x.every((v, i) => v === y[i])
}
const etiquette = (espece: string, sousType: string | null | undefined): string => {
  const st = sousTypeCanon(espece, sousType)
  return st ? `${espece} (${st})` : espece
}

export function appliquerDifference(
  publiees: PeriodePubliee[], lecture: LectureClaude,
): { periodes: PeriodePubliee[]; journal: string[]; suppressionExplicite: boolean } {
  const journal: string[] = []
  const suppressionExplicite = lecture.suppressions.length > 0

  // Suppressions explicites : retirent toutes les publiées de même (espèce, sous-type).
  const cleSuppression = (s: LectureClaude['suppressions'][number]): string => `${s.espece_code}|${sousTypeCanon(s.espece_code, s.sous_type) ?? ''}`
  const supprimees = new Set(lecture.suppressions.map(cleSuppression))
  for (const s of lecture.suppressions) {
    const retirees = publiees.filter(p => cleEspece(p) === cleSuppression(s))
    journal.push(`suppression ${etiquette(s.espece_code, s.sous_type)} : ${retirees.length ? plage(retirees) : 'aucune période publiée'}`)
  }
  const restantes = publiees.filter(p => !supprimees.has(cleEspece(p)))

  // Les périodes lues de même clé forment un groupe : il remplace toutes les publiées de cette clé.
  const groupes = new Map<string, PeriodeLue[]>()
  for (const l of lecture.periodes) groupes.set(cle(l), [...(groupes.get(cle(l)) ?? []), l])

  for (const [k, lues] of groupes) {
    const remplacees = restantes.filter(p => cle(p) === k)
    const lib = `${etiquette(lues[0].espece_code, lues[0].sous_type)} ${mode(lues[0])}`
    journal.push(!remplacees.length ? `ajout ${lib} : ${plage(lues)}`
      : memesPeriodes(lues, remplacees) ? `${lib} : ${plage(lues)} inchangé`
      : `${lib} : ${plage(lues)} remplace ${plage(remplacees)}`)
  }

  const conservees = restantes.filter(p => !groupes.has(cle(p)))
  return { periodes: [...conservees, ...lecture.periodes].map(p => ({ ...p })), journal, suppressionExplicite }
}
