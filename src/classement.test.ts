import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { classer, extraireMetadonnees, departementDuTexte, garde } from './classement.ts'

const fx = (f: string) => JSON.parse(readFileSync(new URL(`./__fixtures__/${f}`, import.meta.url), 'utf8'))
const texte54 = fx('54-ap.texte.json').pages.map((p: any) => p.texte).join('\n')
const texte69 = fx('69-fdc.texte.json').pages.map((p: any) => p.texte).join('\n')
const NOMS = { '54': 'Meurthe-et-Moselle', '69': 'Rhône', '50': 'Manche', '59': 'Nord', '36': 'Indre', '28': 'Eure-et-Loir' }

describe('classer', () => {
  it('arrêté annuel signé (54, 69)', () => { expect(classer('', texte54)).toBe('annuel'); expect(classer('', texte69)).toBe('annuel') })
  it('projet en consultation', () => {
    expect(classer('Projet d’arrêté', 'PROJET D’ARRÊTÉ relatif à l’ouverture et à la clôture de la chasse 2027-2028\nConsultation du public du 3 au 23 avril 2027\nArticle 1')).toBe('projet')
  })
  it('modificatif, esod, ponctuel, hors sujet', () => {
    expect(classer('Arrêté modifiant l’arrêté du 12 mai 2026 relatif à la chasse', 'Article 1 : la date de clôture du sanglier est reportée')).toBe('modificatif')
    expect(classer('', 'Arrêté fixant la liste des espèces susceptibles d’occasionner des dégâts (ESOD) dans le département')).toBe('esod')
    expect(classer('', 'Arrêté ordonnant une battue administrative aux sangliers sur la commune de X')).toBe('ponctuel')
    expect(classer('', 'Arrêté portant réglementation de la pêche en eau douce')).toBe('hors_sujet')
  })
  it('le mot chasse en passant ne fait pas un acte chasse', () => {
    expect(classer('', 'Arrêté portant interdiction de circulation ; sont exclus les véhicules de la fédération des chasseurs')).toBe('indetermine')
  })
})
describe('extraireMetadonnees', () => {
  it('numéro et date de signature du 54', () => {
    const m = extraireMetadonnees(texte54)
    expect(m.numero_acte).toBe('2026/DDT/ABER/48'); expect(m.date_acte).toMatch(/^2026-0[4-6]-\d{2}$/)
  })
  it('signature OCR réelle du 54 (« Nancy,le {6 AVR. 2026 ») et du 69 (« Fait, le 2 3 JUIN 2026 »)', () => {
    expect(extraireMetadonnees(texte54).date_acte).toBe('2026-04-06'); expect(extraireMetadonnees(texte69).date_acte).toBe('2026-06-23')
    expect(extraireMetadonnees(texte69).numero_acte).toBe('DDT - 2026-A43')
  })
  it('date « Fait à Nancy, le 12 mai 2026 » prioritaire', () => {
    expect(extraireMetadonnees('ARRÊTÉ N° 12\nVU le décret du 29 avril 2004\n…\nFait à Nancy, le 12 mai 2026\nLe Préfet').date_acte).toBe('2026-05-12')
  })
})
describe('departementDuTexte + garde', () => {
  it('lit le département en tête', () => {
    expect(departementDuTexte(texte54, NOMS)).toBe('54'); expect(departementDuTexte(texte69, NOMS)).toBe('69')
    expect(departementDuTexte('PRÉFET\nDU NORD\nArrêté…', NOMS)).toBe('59')
  })
  it('refuse un PDF d’un autre département (piège 28 → Indre) ; accepte sans indice', () => {
    expect(garde({ departementSource: '28', saisonAttendue: '2026-2027' }, 'PRÉFET DE L’INDRE\nArrêté… campagne 2026-2027', NOMS)).toEqual({ ok: false, motif: expect.stringMatching(/département/) })
    expect(garde({ departementSource: '54', saisonAttendue: '2026-2027' }, texte54, NOMS)).toEqual({ ok: true })
    expect(garde({ departementSource: '54', saisonAttendue: '2026-2027' }, 'texte sans rien', NOMS)).toEqual({ ok: true })
  })
  it('refuse une saison lointaine, accepte la précédente (prolongation)', () => {
    expect(garde({ departementSource: '54', saisonAttendue: '2026-2027' }, 'campagne 2023-2024', NOMS).ok).toBe(false)
    expect(garde({ departementSource: '54', saisonAttendue: '2026-2027' }, 'campagne 2025-2026', NOMS).ok).toBe(true)
  })
})
