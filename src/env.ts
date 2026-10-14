// Variables d'environnement du robot. Les valeurs ne sont jamais journalisées.
export interface Env { supabaseUrl: string; serviceRoleKey: string; proxy?: string; r2: { accountId: string; accessKeyId: string; secretAccessKey: string; bucket: string } }
function obligatoire(nom: string): string { const v = process.env[nom]?.trim(); if (!v) throw new Error(`Variable manquante : ${nom}`); return v }
export function lireEnv(): Env {
  return {
    supabaseUrl: obligatoire('SUPABASE_URL'), serviceRoleKey: obligatoire('SUPABASE_SERVICE_ROLE_KEY'),
    proxy: process.env.VEILLE_PROXY_URL?.trim() || undefined,
    r2: { accountId: obligatoire('R2_ACCOUNT_ID'), accessKeyId: obligatoire('R2_ACCESS_KEY_ID'), secretAccessKey: obligatoire('R2_SECRET_ACCESS_KEY'), bucket: obligatoire('R2_VEILLE_BUCKET') },
  }
}
