import { describe, it, expect } from 'vitest'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { chargerConsigne } from './consigne.ts'
import { creerLecteurClaude, creerLecteurMemoire, DelaiDepasse } from './claude.ts'
import type { ExecClaude, ReponseLecture, RequeteLecture } from './claude.ts'
import type { LectureClaude } from './types.ts'

const JETON = 'sk-ant-oat-FAUX-0123456789'
const { systeme, schema } = chargerConsigne()

const sortieValide: LectureClaude = {
  acte: { numero: '2026-123', date: '2026-06-01', objet: 'Ouverture et clôture de la chasse 2026-2027', signe: true, departement_lu: '54', saison_lue: '2026-2027' },
  periodes: [{
    espece_code: 'sanglier', sous_type: null, date_ouverture: '2026-06-01', date_fermeture: '2027-02-28', mode_chasse: 'tous_modes', restriction_dates: null, source_article: '2',
    preuve: { article: '2', citation: 'Sanglier : du 1er juin 2026 au 28 février 2027', page: 1, annee_deduite: false },
  }],
  suppressions: [], notes: '',
}
const USAGE = { input_tokens: 12, cache_creation_input_tokens: 3, cache_read_input_tokens: 5, output_tokens: 7 }
const ligne = (o: object) => JSON.stringify(o)
const resultat = (extra: object = {}) => ligne({ type: 'result', subtype: 'success', is_error: false, structured_output: sortieValide, usage: USAGE, num_turns: 1, total_cost_usd: 0.01, ...extra })

const requete = (extra: Partial<RequeteLecture> = {}): RequeteLecture => ({ modele: 'sonnet', systeme, schema, texte: 'Dossier à lire', ...extra })

// Exec simulé : mémorise l'appel et l'état du fichier de prompt au moment de l'appel.
function execSimule(reponse: { code?: number; stdout?: string; stderr?: string } | Error) {
  const appels: { args: string[]; stdin: string; env: Record<string, string>; delaiMs: number; systemeLu?: string; mode?: number }[] = []
  const exec: ExecClaude = async (args, stdin, env, delaiMs) => {
    const f = args[args.indexOf('--system-prompt-file') + 1]
    appels.push({ args, stdin, env, delaiMs, systemeLu: existsSync(f) ? readFileSync(f, 'utf8') : undefined, mode: existsSync(f) ? statSync(f).mode & 0o777 : undefined })
    if (reponse instanceof Error) throw reponse
    return { code: reponse.code ?? 0, stdout: reponse.stdout ?? '', stderr: reponse.stderr ?? '' }
  }
  return { exec, appels }
}

describe('creerLecteurClaude — appel de la CLI', () => {
  it('arguments : modèle, outils vides, réglages isolés, schéma sérialisé, prompt système en fichier 0600 supprimé ensuite', async () => {
    const { exec, appels } = execSimule({ stdout: resultat() })
    await creerLecteurClaude(JETON, exec).lire(requete())
    const { args } = appels[0]
    const valeur = (opt: string) => args[args.indexOf(opt) + 1]
    expect(args[0]).toBe('-p')
    expect(valeur('--model')).toBe('sonnet')
    expect(valeur('--tools')).toBe('')
    expect(valeur('--setting-sources')).toBe('')
    expect(args).toContain('--strict-mcp-config')
    expect(args).toContain('--no-session-persistence')
    expect(valeur('--input-format')).toBe('stream-json'); expect(valeur('--output-format')).toBe('stream-json'); expect(args).toContain('--verbose')
    expect(valeur('--json-schema')).toBe(JSON.stringify(schema))
    const fichier = valeur('--system-prompt-file')
    expect(appels[0].systemeLu).toBe(systeme); expect(appels[0].mode).toBe(0o600)
    expect(existsSync(fichier)).toBe(false)
  })

  it('le prompt système est supprimé même si l’exec échoue', async () => {
    const { exec, appels } = execSimule(new Error('boum'))
    await creerLecteurClaude(JETON, exec).lire(requete())
    expect(existsSync(appels[0].args[appels[0].args.indexOf('--system-prompt-file') + 1])).toBe(false)
  })

  it('jeton uniquement dans l’environnement, jamais dans les arguments', async () => {
    const { exec, appels } = execSimule({ stdout: resultat() })
    await creerLecteurClaude(JETON, exec).lire(requete())
    expect(appels[0].env.CLAUDE_CODE_OAUTH_TOKEN).toBe(JETON)
    expect(appels[0].args.join(' ')).not.toContain(JETON)
    expect(appels[0].stdin).not.toContain(JETON)
  })

  it('stdin : une seule ligne JSON, message utilisateur avec le texte puis les images en base64', async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3])
    const { exec, appels } = execSimule({ stdout: resultat() })
    await creerLecteurClaude(JETON, exec).lire(requete({ images: [{ page: 4, png }] }))
    const { stdin } = appels[0]
    expect(stdin.endsWith('\n')).toBe(true); expect(stdin.trim().split('\n')).toHaveLength(1)
    const m = JSON.parse(stdin)
    expect(m.type).toBe('user'); expect(m.message.role).toBe('user')
    expect(m.message.content[0]).toEqual({ type: 'text', text: 'Dossier à lire' })
    const image = m.message.content.find((c: any) => c.type === 'image')
    expect(image.source).toEqual({ type: 'base64', media_type: 'image/png', data: png.toString('base64') })
    expect(JSON.stringify(m.message.content.filter((c: any) => c.type === 'text'))).toContain('page 4')
  })

  it('délai : 240 s par défaut, celui de la requête sinon', async () => {
    const { exec, appels } = execSimule({ stdout: resultat() })
    const lecteur = creerLecteurClaude(JETON, exec)
    await lecteur.lire(requete()); await lecteur.lire(requete({ delaiMs: 5000 }))
    expect(appels.map(a => a.delaiMs)).toEqual([240_000, 5000])
  })
})

describe('creerLecteurClaude — réponses', () => {
  it('résultat conforme : sortie, usage mappé, modèle', async () => {
    const { exec } = execSimule({ stdout: ['bruit non JSON', ligne({ type: 'system', subtype: 'init', model: 'claude-sonnet-X' }), resultat(), ''].join('\n') })
    const r = await creerLecteurClaude(JETON, exec).lire(requete())
    expect(r).toEqual({ ok: true, sortie: sortieValide, usage: { input: 12, output: 7, cache_creation: 3, cache_read: 5 }, modele: 'sonnet' })
  })

  it('usage absent : zéros', async () => {
    const { exec } = execSimule({ stdout: resultat({ usage: undefined }) })
    const r = await creerLecteurClaude(JETON, exec).lire(requete({ modele: 'opus' }))
    expect(r).toMatchObject({ ok: true, usage: { input: 0, output: 0, cache_creation: 0, cache_read: 0 }, modele: 'opus' })
  })

  it.each([['You have hit your usage limit'], ['API Error: 429 Too Many Requests'], ['Rate limit reached']])('is_error « %s » : quota', async (texte) => {
    const { exec } = execSimule({ code: 1, stdout: ligne({ type: 'result', subtype: 'success', is_error: true, result: texte }) })
    const r = await creerLecteurClaude(JETON, exec).lire(requete())
    expect(r).toMatchObject({ ok: false, erreur: 'quota' })
  })

  it('autre is_error : cli, message expurgé', async () => {
    const { exec } = execSimule({ stdout: ligne({ type: 'result', subtype: 'success', is_error: true, result: `Authentication failed for ${JETON}` }) })
    const r = await creerLecteurClaude(JETON, exec).lire(requete())
    expect(r).toMatchObject({ ok: false, erreur: 'cli' })
    expect((r as { message: string }).message).not.toContain(JETON)
  })

  it('structured_output absent : schema', async () => {
    const { exec } = execSimule({ stdout: resultat({ structured_output: undefined, result: 'texte libre' }) })
    expect(await creerLecteurClaude(JETON, exec).lire(requete())).toMatchObject({ ok: false, erreur: 'schema' })
  })

  it('échec de sortie structurée côté CLI (is_error, error_max_structured_output_retries) : schema', async () => {
    const { exec } = execSimule({ code: 1, stdout: ligne({ type: 'result', subtype: 'error_max_structured_output_retries', is_error: true }) })
    expect(await creerLecteurClaude(JETON, exec).lire(requete())).toMatchObject({ ok: false, erreur: 'schema' })
  })

  it('sortie non conforme au schéma (espece_code: tetras) : schema', async () => {
    const mauvaise = { ...sortieValide, periodes: [{ ...sortieValide.periodes[0], espece_code: 'tetras' }] }
    const { exec } = execSimule({ stdout: resultat({ structured_output: mauvaise }) })
    const r = await creerLecteurClaude(JETON, exec).lire(requete())
    expect(r).toMatchObject({ ok: false, erreur: 'schema' })
    expect((r as { message: string }).message).toMatch(/espece_code/)
  })

  it('contrainte non appliquée par le décodage (citation trop courte, date mal formée) : schema', async () => {
    const mauvaise = { ...sortieValide, periodes: [{ ...sortieValide.periodes[0], date_ouverture: '1er juin', preuve: { ...sortieValide.periodes[0].preuve, citation: 'court' } }] }
    const { exec } = execSimule({ stdout: resultat({ structured_output: mauvaise }) })
    expect(await creerLecteurClaude(JETON, exec).lire(requete())).toMatchObject({ ok: false, erreur: 'schema' })
  })

  it('exec qui rejette par délai : timeout', async () => {
    const { exec } = execSimule(new DelaiDepasse(1000))
    expect(await creerLecteurClaude(JETON, exec).lire(requete())).toMatchObject({ ok: false, erreur: 'timeout' })
  })

  it('exec qui rejette pour une autre raison : cli, expurgé', async () => {
    const { exec } = execSimule(new Error(`spawn claude ENOENT ${JETON}`))
    const r = await creerLecteurClaude(JETON, exec).lire(requete())
    expect(r).toMatchObject({ ok: false, erreur: 'cli' })
    expect((r as { message: string }).message).not.toContain(JETON)
  })

  it('code 1 sans résultat : cli, stderr expurgé (jeton absent)', async () => {
    const { exec } = execSimule({ code: 1, stderr: `error: invalid token ${JETON}\ntrace` })
    const r = await creerLecteurClaude(JETON, exec).lire(requete())
    expect(r).toMatchObject({ ok: false, erreur: 'cli' })
    const { message } = r as { message: string }
    expect(message).not.toContain(JETON); expect(message).toContain('invalid token')
  })

  it('code 0 sans ligne result : cli', async () => {
    const { exec } = execSimule({ stdout: 'rien d’utile\n' })
    expect(await creerLecteurClaude(JETON, exec).lire(requete())).toMatchObject({ ok: false, erreur: 'cli' })
  })
})

describe('creerLecteurMemoire', () => {
  it('rend les réponses dans l’ordre et mémorise les requêtes', async () => {
    const a: ReponseLecture = { ok: false, erreur: 'quota', message: 'q' }
    const b: ReponseLecture = { ok: true, sortie: sortieValide, usage: { input: 1, output: 2, cache_creation: 0, cache_read: 0 }, modele: 'sonnet' }
    const l = creerLecteurMemoire([a, b])
    expect(await l.lire(requete({ texte: '1' }))).toBe(a); expect(await l.lire(requete({ texte: '2' }))).toBe(b)
    expect(l.requetes.map(r => r.texte)).toEqual(['1', '2'])
  })
  it('réponses épuisées : erreur explicite', async () => {
    await expect(creerLecteurMemoire([]).lire(requete())).rejects.toThrow(/plus de réponse/)
  })
})
