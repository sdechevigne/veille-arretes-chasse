// Saison cynégétique : du 1er juillet N au 30 juin N+1 (calée sur le permis).
export function saisonDepuisDate(d: Date): string {
  const an = d.getUTCFullYear(); const debut = d.getUTCMonth() + 1 >= 7 ? an : an - 1
  return `${debut}-${debut + 1}`
}
export function saisonCourante(now: Date = new Date()): string { return saisonDepuisDate(now) }
// « 2026-2027 », « 2026/2027 », « 2026 – 2027 » : deux années consécutives.
export function saisonDepuisTexte(texte: string): string | null {
  const re = /\b(20\d\d)\s*[-–/]\s*(20\d\d)\b/g; let m: RegExpExecArray | null
  while ((m = re.exec(texte))) { const a = +m[1], b = +m[2]; if (b === a + 1) return `${a}-${b}` }
  return null
}
