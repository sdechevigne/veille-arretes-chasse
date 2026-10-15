// Chargement de la consigne de lecture (prompt système) et du schéma de sortie imposé à Claude.
// Seul accès disque de la lecture Claude : appelé une fois au démarrage, échoue tôt si un fichier est invalide.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const DOSSIER = join(import.meta.dirname, '..', 'consigne')

export function chargerConsigne(): { systeme: string; schema: object } {
  const systeme = readFileSync(join(DOSSIER, 'lecture-arrete.md'), 'utf8')
  if (!systeme.trim()) throw new Error('consigne de lecture vide')
  const schema = JSON.parse(readFileSync(join(DOSSIER, 'lecture-arrete.schema.json'), 'utf8'))
  if (!schema || typeof schema !== 'object' || Array.isArray(schema) || !schema.properties?.periodes) {
    throw new Error('schéma de lecture invalide : properties.periodes attendu')
  }
  return { systeme, schema }
}
