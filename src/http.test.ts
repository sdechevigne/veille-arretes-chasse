import { describe, it, expect, vi } from 'vitest'
import { creerTelechargeur, expurger } from './http.ts'

const PROXY = 'http://user:pa55@proxy.example.fr:8080'
function execFactice(reponses: Array<{ code: number; stdout?: Buffer; stderr?: string }>) {
  const appels: string[][] = []
  const exec = vi.fn(async (args: string[]) => { appels.push(args); const r = reponses.shift()!; return { code: r.code, stdout: r.stdout ?? Buffer.alloc(0), stderr: r.stderr ?? '' } })
  return { exec, appels }
}
// stdout = corps + "\n<code>" (format -w imposé par http.ts)
const ok = (corps: string, code = 200) => Buffer.concat([Buffer.from(corps), Buffer.from(`\n${code} https://x/final`)])

describe('creerTelechargeur', () => {
  it('passe le proxy, un UA navigateur, la langue, le timeout, et renvoie statut + octets', async () => {
    const { exec, appels } = execFactice([{ code: 0, stdout: ok('%PDF-1.4') }])
    const t = creerTelechargeur({ proxy: PROXY, delaiMinMs: 0, delaiMaxMs: 0, timeoutS: 40 }, exec)
    const r = await t.telecharger('https://www.manche.gouv.fr/a.pdf')
    expect(r.statut).toBe(200); expect(r.octets.toString()).toBe('%PDF-1.4'); expect(r.urlFinale).toBe('https://x/final')
    const a = appels[0]
    expect(a).toEqual(expect.arrayContaining(['-x', PROXY, '--max-time', '40', '-L', '--http1.1']))
    expect(a[a.indexOf('-A') + 1]).toMatch(/Mozilla/)
    expect(a).toContain('Accept-Language: fr-FR,fr;q=0.9')
  })
  it('sans proxy : pas de -x', async () => {
    const { exec, appels } = execFactice([{ code: 0, stdout: ok('x') }])
    await creerTelechargeur({ delaiMinMs: 0, delaiMaxMs: 0 }, exec).telecharger('https://a/b')
    expect(appels[0]).not.toContain('-x')
  })
  it('réessaie une fois sur erreur réseau puis rend une erreur expurgée', async () => {
    const { exec } = execFactice([{ code: 7, stderr: 'curl: (7) Failed to connect to proxy.example.fr port 8080' }, { code: 7, stderr: 'curl: (7) Failed to connect to proxy.example.fr port 8080' }])
    const r = await creerTelechargeur({ proxy: PROXY, delaiMinMs: 0, delaiMaxMs: 0, tentatives: 2 }, exec).telecharger('https://a/b')
    expect(exec).toHaveBeenCalledTimes(2)
    expect(r.statut).toBe(0); expect(r.erreur).toContain('<proxy>'); expect(r.erreur).not.toContain('proxy.example.fr'); expect(r.erreur).not.toContain('pa55')
  })
  it('refuse un corps au-delà de la taille max', async () => {
    const { exec } = execFactice([{ code: 0, stdout: ok('x'.repeat(100)) }])
    const r = await creerTelechargeur({ delaiMinMs: 0, delaiMaxMs: 0, tailleMaxOctets: 50 }, exec).telecharger('https://a/b')
    expect(r.statut).toBe(200); expect(r.erreur).toMatch(/taille/i); expect(r.octets.length).toBe(0)
  })
  it('espace les requêtes d’un même hôte, pas celles d’hôtes différents', async () => {
    const { exec } = execFactice([{ code: 0, stdout: ok('1') }, { code: 0, stdout: ok('2') }, { code: 0, stdout: ok('3') }])
    const t = creerTelechargeur({ delaiMinMs: 50, delaiMaxMs: 50 }, exec)
    const t0 = Date.now(); await t.telecharger('https://a/1'); await t.telecharger('https://b/1'); const t1 = Date.now()
    await t.telecharger('https://a/2'); const t2 = Date.now()
    expect(t1 - t0).toBeLessThan(45); expect(t2 - t1).toBeGreaterThanOrEqual(45)
  })
  it('corps contenant des sauts de ligne : seul le dernier \\n est le marqueur', async () => {
    const { exec } = execFactice([{ code: 0, stdout: ok('a\nb\n%PDF-1') }])
    const r = await creerTelechargeur({ delaiMinMs: 0, delaiMaxMs: 0 }, exec).telecharger('https://a/b')
    expect(r.statut).toBe(200); expect(r.octets.toString()).toBe('a\nb\n%PDF-1'); expect(r.erreur).toBeUndefined()
  })
  it('corps vide : statut 200, 0 octet, pas d’erreur', async () => {
    const { exec } = execFactice([{ code: 0, stdout: ok('') }])
    const r = await creerTelechargeur({ delaiMinMs: 0, delaiMaxMs: 0 }, exec).telecharger('https://a/b')
    expect(r.statut).toBe(200); expect(r.octets.length).toBe(0); expect(r.erreur).toBeUndefined()
  })
  it('404 non retenté (un seul exec)', async () => {
    const { exec } = execFactice([{ code: 0, stdout: ok('introuvable', 404) }, { code: 0, stdout: ok('x') }])
    const r = await creerTelechargeur({ delaiMinMs: 0, delaiMaxMs: 0, tentatives: 2 }, exec).telecharger('https://a/b')
    expect(exec).toHaveBeenCalledTimes(1); expect(r.statut).toBe(404)
  })
  it('réponse sans marqueur : erreur, retentée', async () => {
    const { exec } = execFactice([{ code: 0, stdout: Buffer.from('abc') }, { code: 0, stdout: Buffer.from('abc') }])
    const r = await creerTelechargeur({ delaiMinMs: 0, delaiMaxMs: 0, tentatives: 2 }, exec).telecharger('https://a/b')
    expect(exec).toHaveBeenCalledTimes(2); expect(r.statut).toBe(0); expect(r.erreur).toMatch(/marqueur/)
  })
  it('restreint les protocoles (y compris après redirection) à http et https', async () => {
    const { exec, appels } = execFactice([{ code: 0, stdout: ok('x') }])
    await creerTelechargeur({ delaiMinMs: 0, delaiMaxMs: 0 }, exec).telecharger('https://a/b')
    expect(appels[0][appels[0].indexOf('--proto') + 1]).toBe('=http,https')
    expect(appels[0][appels[0].indexOf('--proto-redir') + 1]).toBe('=http,https')
  })
  it('limite la taille côté curl (--max-filesize)', async () => {
    const { exec, appels } = execFactice([{ code: 0, stdout: ok('x') }])
    await creerTelechargeur({ delaiMinMs: 0, delaiMaxMs: 0, tailleMaxOctets: 1234 }, exec).telecharger('https://a/b')
    expect(appels[0][appels[0].indexOf('--max-filesize') + 1]).toBe('1234')
  })
})

describe('expurger', () => {
  it('remplace hôte, port, utilisateur et mot de passe du proxy', () => {
    expect(expurger('Could not resolve proxy: proxy.example.fr; user pa55 port 8080', PROXY)).toBe('Could not resolve proxy: <proxy>; <proxy> <proxy> port <proxy>')
  })
  it('proxy sans schéma : hôte et mot de passe masqués', () => {
    const r = expurger('connect proxy.example.fr failed (pa55)', 'user:pa55@proxy.example.fr:8080')
    expect(r).not.toContain('proxy.example.fr'); expect(r).not.toContain('pa55')
  })
  it('mot de passe non décodable (pa%ss) : brut et hôte masqués', () => {
    const r = expurger('auth pa%ss refused by proxy.example.fr', 'http://user:pa%ss@proxy.example.fr:8080')
    expect(r).not.toContain('pa%ss'); expect(r).not.toContain('proxy.example.fr')
  })
  it('mot de passe encodé : formes brute et décodée masquées', () => {
    const r = expurger('a p@ss b p%40ss', 'http://user:p%40ss@proxy.example.fr:8080')
    expect(r).not.toContain('p@ss'); expect(r).not.toContain('p%40ss')
  })
  it('sans proxy : inchangé', () => { expect(expurger('abc')).toBe('abc') })
})
