// Amorçage du registre `arretes_sources` à partir des `arretes.url_source` déjà connues.
// Pur (aucun accès réseau ni base) : la CLI (`amorcer`) lit les URL et imprime le SQL d'insertion.
import type { TypeSource } from './types.ts'

export interface ArreteUrl { departement: string; url_source: string | null }
export interface SourceDerivee { departement: string; type_source: TypeSource; url: string; verifiee: boolean; note?: string }

/** Domaine du site de la préfecture, par code de département (règle `www.<nom-sans-accents-tirets>.gouv.fr` + exceptions relevées dans les URL réelles). */
export const DOMAINES_PREFECTURES: Record<string, string> = {
  '01': 'www.ain.gouv.fr', // Ain
  '02': 'www.aisne.gouv.fr', // Aisne
  '03': 'www.allier.gouv.fr', // Allier
  '04': 'www.alpes-de-haute-provence.gouv.fr', // Alpes-de-Haute-Provence
  '05': 'www.hautes-alpes.gouv.fr', // Hautes-Alpes
  '06': 'www.alpes-maritimes.gouv.fr', // Alpes-Maritimes
  '07': 'www.ardeche.gouv.fr', // Ardèche
  '08': 'www.ardennes.gouv.fr', // Ardennes
  '09': 'www.ariege.gouv.fr', // Ariège
  '10': 'www.aube.gouv.fr', // Aube
  '11': 'www.aude.gouv.fr', // Aude
  '12': 'www.aveyron.gouv.fr', // Aveyron
  '13': 'www.bouches-du-rhone.gouv.fr', // Bouches-du-Rhône
  '14': 'www.calvados.gouv.fr', // Calvados
  '15': 'www.cantal.gouv.fr', // Cantal
  '16': 'www.charente.gouv.fr', // Charente
  '17': 'www.charente-maritime.gouv.fr', // Charente-Maritime
  '18': 'www.cher.gouv.fr', // Cher
  '19': 'www.correze.gouv.fr', // Corrèze
  '21': 'www.cote-dor.gouv.fr', // Côte-d'Or
  '22': 'www.cotes-darmor.gouv.fr', // Côtes-d'Armor
  '23': 'www.creuse.gouv.fr', // Creuse
  '24': 'www.dordogne.gouv.fr', // Dordogne
  '25': 'www.doubs.gouv.fr', // Doubs
  '26': 'www.drome.gouv.fr', // Drôme
  '27': 'www.eure.gouv.fr', // Eure
  '28': 'www.eure-et-loir.gouv.fr', // Eure-et-Loir
  '29': 'www.finistere.gouv.fr', // Finistère
  '2A': 'www.corse-du-sud.gouv.fr', // Corse-du-Sud
  '2B': 'www.haute-corse.gouv.fr', // Haute-Corse
  '30': 'www.gard.gouv.fr', // Gard
  '31': 'www.haute-garonne.gouv.fr', // Haute-Garonne
  '32': 'www.gers.gouv.fr', // Gers
  '33': 'www.gironde.gouv.fr', // Gironde
  '34': 'www.herault.gouv.fr', // Hérault
  '35': 'www.ille-et-vilaine.gouv.fr', // Ille-et-Vilaine
  '36': 'www.indre.gouv.fr', // Indre
  '37': 'www.indre-et-loire.gouv.fr', // Indre-et-Loire
  '38': 'www.isere.gouv.fr', // Isère
  '39': 'www.jura.gouv.fr', // Jura
  '40': 'www.landes.gouv.fr', // Landes
  '41': 'www.loir-et-cher.gouv.fr', // Loir-et-Cher
  '42': 'www.loire.gouv.fr', // Loire
  '43': 'www.haute-loire.gouv.fr', // Haute-Loire
  '44': 'www.loire-atlantique.gouv.fr', // Loire-Atlantique
  '45': 'www.loiret.gouv.fr', // Loiret
  '46': 'www.lot.gouv.fr', // Lot
  '47': 'www.lot-et-garonne.gouv.fr', // Lot-et-Garonne
  '48': 'www.lozere.gouv.fr', // Lozère
  '49': 'www.maine-et-loire.gouv.fr', // Maine-et-Loire
  '50': 'www.manche.gouv.fr', // Manche
  '51': 'www.marne.gouv.fr', // Marne
  '52': 'www.haute-marne.gouv.fr', // Haute-Marne
  '53': 'www.mayenne.gouv.fr', // Mayenne
  '54': 'www.meurthe-et-moselle.gouv.fr', // Meurthe-et-Moselle
  '55': 'www.meuse.gouv.fr', // Meuse
  '56': 'www.morbihan.gouv.fr', // Morbihan
  '57': 'www.moselle.gouv.fr', // Moselle
  '58': 'www.nievre.gouv.fr', // Nièvre
  '59': 'www.nord.gouv.fr', // Nord
  '60': 'www.oise.gouv.fr', // Oise
  '61': 'www.orne.gouv.fr', // Orne
  '62': 'www.pas-de-calais.gouv.fr', // Pas-de-Calais
  '63': 'www.puy-de-dome.gouv.fr', // Puy-de-Dôme
  '64': 'www.pyrenees-atlantiques.gouv.fr', // Pyrénées-Atlantiques
  '65': 'www.hautes-pyrenees.gouv.fr', // Hautes-Pyrénées
  '66': 'www.pyrenees-orientales.gouv.fr', // Pyrénées-Orientales
  '67': 'www.bas-rhin.gouv.fr', // Bas-Rhin
  '68': 'www.haut-rhin.gouv.fr', // Haut-Rhin
  '69': 'www.rhone.gouv.fr', // Rhône
  '70': 'www.haute-saone.gouv.fr', // Haute-Saône
  '71': 'www.saone-et-loire.gouv.fr', // Saône-et-Loire
  '72': 'www.sarthe.gouv.fr', // Sarthe
  '73': 'www.savoie.gouv.fr', // Savoie
  '74': 'www.haute-savoie.gouv.fr', // Haute-Savoie
  '75': 'www.prefecturedepolice.interieur.gouv.fr', // Paris
  '76': 'www.seine-maritime.gouv.fr', // Seine-Maritime
  '77': 'www.seine-et-marne.gouv.fr', // Seine-et-Marne
  '78': 'www.yvelines.gouv.fr', // Yvelines
  '79': 'www.deux-sevres.gouv.fr', // Deux-Sèvres
  '80': 'www.somme.gouv.fr', // Somme
  '81': 'www.tarn.gouv.fr', // Tarn
  '82': 'www.tarn-et-garonne.gouv.fr', // Tarn-et-Garonne
  '83': 'www.var.gouv.fr', // Var
  '84': 'www.vaucluse.gouv.fr', // Vaucluse
  '85': 'www.vendee.gouv.fr', // Vendée
  '86': 'www.vienne.gouv.fr', // Vienne
  '87': 'www.haute-vienne.gouv.fr', // Haute-Vienne
  '88': 'www.vosges.gouv.fr', // Vosges
  '89': 'www.yonne.gouv.fr', // Yonne
  '90': 'www.territoire-de-belfort.gouv.fr', // Territoire de Belfort
  '91': 'www.essonne.gouv.fr', // Essonne
  '92': 'www.hauts-de-seine.gouv.fr', // Hauts-de-Seine
  '93': 'www.seine-saint-denis.gouv.fr', // Seine-Saint-Denis
  '94': 'www.val-de-marne.gouv.fr', // Val-de-Marne
  '95': 'www.val-doise.gouv.fr', // Val-d'Oise
}

const NOTE_SITE_TIERS = 'amorçage 2026-10 depuis arretes.url_source — à corriger à la main (page /IMG/pdf non navigable)'
const CHEMIN_RAA = '/Publications/Recueil-des-actes-administratifs'

/** URL sans son dernier segment de chemin (ni paramètres ni ancre). */
function pageParente(u: URL): string {
  const segments = u.pathname.split('/').filter(Boolean); segments.pop()
  return `${u.protocol}//${u.host}${segments.length ? `/${segments.join('/')}` : ''}`
}

/** Source déduite de l'`url_source` d'un arrêté (hors RAA, ajouté pour tout département). */
function depuisUrlSource(departement: string, urlSource: string): SourceDerivee | null {
  let u: URL
  try { u = new URL(urlSource) } catch { return null }
  const hote = u.hostname.toLowerCase()
  // Hors .gouv.fr : fédération des chasseurs, visitée avec succès en 2026 → URL gardée telle quelle.
  if (!hote.endsWith('.gouv.fr')) return { departement, type_source: 'federation', url: urlSource, verifiee: true }
  // Site de l'État autre que la préfecture (ex. DRIEAT Île-de-France) : on garde le dossier parent, à confirmer.
  if (hote !== DOMAINES_PREFECTURES[departement]) return { departement, type_source: 'prefecture_chasse', url: pageParente(u), verifiee: false, note: NOTE_SITE_TIERS }
  // Un PDF direct n'apprend rien de plus que le recueil : seul le RAA est amorcé.
  if (/\.pdf$/i.test(u.pathname) || u.pathname.includes('/contenu/telechargement/')) return null
  if (/\/Consultation-du-public\//i.test(u.pathname)) return { departement, type_source: 'prefecture_consultation', url: pageParente(u), verifiee: false }
  if (/\/(Actions-de-l-Etat|Politiques-publiques)\//i.test(u.pathname)) return { departement, type_source: 'prefecture_chasse', url: pageParente(u), verifiee: false }
  return null
}

export function deriverSources(arretes: ArreteUrl[]): SourceDerivee[] {
  const sources: SourceDerivee[] = []
  for (const { departement, url_source } of arretes) {
    const domaine = DOMAINES_PREFECTURES[departement]
    if (!domaine) throw new Error(`Département sans domaine de préfecture : ${departement}`)
    const derivee = url_source ? depuisUrlSource(departement, url_source) : null
    if (derivee) sources.push(derivee)
    sources.push({ departement, type_source: 'prefecture_raa', url: `https://${domaine}${CHEMIN_RAA}`, verifiee: false })
  }
  return sources
}

const litteral = (s: string) => `'${s.replace(/'/g, "''")}'`

/** SQL d'insertion idempotent (ON CONFLICT DO NOTHING) ; `verifiee_le = now()` pour les sources vérifiées. */
export function sqlAmorcage(sources: SourceDerivee[]): string {
  if (sources.length === 0) return ''
  const lignes = [...sources]
    .sort((a, b) => a.departement.localeCompare(b.departement) || a.type_source.localeCompare(b.type_source) || a.url.localeCompare(b.url))
    .map(s => {
      const note = s.note ?? (s.type_source === 'prefecture_raa' ? 'amorçage 2026-10 heuristique domaine' : 'amorçage 2026-10 depuis arretes.url_source')
      return `  (${litteral(s.departement)}, ${litteral(s.type_source)}, ${litteral(s.url)}, ${s.verifiee ? 'now()' : 'NULL'}, ${litteral(note)})`
    })
  return `INSERT INTO public.arretes_sources (departement, type_source, url, verifiee_le, notes) VALUES\n${lignes.join(',\n')}\nON CONFLICT (departement, type_source, url) DO NOTHING;\n`
}
