// Variables d'environnement du robot. Les valeurs ne sont jamais journalisées.
export interface Env { supabaseUrl: string; serviceRoleKey: string; proxy?: string; r2: { accountId: string; accessKeyId: string; secretAccessKey: string; bucket: string }; opencode?: { url: string; motDePasse?: string }; manta?: { url: string; secret: string } }
function facultative(nom: string): string | undefined { return process.env[nom]?.trim() || undefined }
function obligatoire(nom: string): string { const v = process.env[nom]?.trim(); if (!v) throw new Error(`Variable manquante : ${nom}`); return v }
/** Webhook Manta seul (commande `notifier`, qui n'a besoin d'aucun autre secret) ; incomplet = notification désactivée. */
export function lireManta(): Env['manta'] {
  const url = facultative('MANTA_WEBHOOK_URL'), secret = facultative('MANTA_WEBHOOK_SECRET')
  return url && secret ? { url, secret } : undefined
}
export function lireEnv(): Env {
  // Facultatives : absentes = fonctionnalité désactivée (lecture Claude, alerte Manta), jamais une erreur de chargement.
  const url = facultative('VEILLE_OPENCODE_URL')
  return {
    opencode: url ? { url, motDePasse: facultative('VEILLE_OPENCODE_PASSWORD') } : undefined,
    manta: lireManta(),
    supabaseUrl: obligatoire('SUPABASE_URL'), serviceRoleKey: obligatoire('SUPABASE_SERVICE_ROLE_KEY'),
    proxy: process.env.VEILLE_PROXY_URL?.trim() || undefined,
    r2: { accountId: obligatoire('R2_ACCOUNT_ID'), accessKeyId: obligatoire('R2_ACCESS_KEY_ID'), secretAccessKey: obligatoire('R2_SECRET_ACCESS_KEY'), bucket: obligatoire('R2_VEILLE_BUCKET') },
  }
}
