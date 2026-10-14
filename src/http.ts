// Téléchargement poli via curl : proxy optionnel, rythme par hôte, 2 tentatives, taille bornée, erreurs expurgées.
import { spawn } from 'node:child_process'
import type { Telechargeur, Telechargement } from './types.ts'

export interface OptionsHttp { proxy?: string; delaiMinMs?: number; delaiMaxMs?: number; timeoutS?: number; tailleMaxOctets?: number; tentatives?: number }
export type Exec = (args: string[]) => Promise<{ code: number; stdout: Buffer; stderr: string }>

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36'
const MARQUEUR = '\n' // -w écrit "\n<code> <url>" après le corps

export function expurger(msg: string, proxy?: string): string {
  if (!proxy) return msg
  let secrets: string[] = []
  try { const u = new URL(proxy); secrets = [u.password, u.username, decodeURIComponent(u.password), decodeURIComponent(u.username), u.host, u.hostname, u.port] } catch { secrets = [proxy] }
  for (const s of [...new Set(secrets)].filter(Boolean).sort((a, b) => b.length - a.length)) msg = msg.split(s).join('<proxy>')
  return msg
}

const execCurl: Exec = (args) => new Promise((resolve) => {
  const p = spawn('curl', args); const out: Buffer[] = []; let err = ''
  p.stdout.on('data', (d) => out.push(d)); p.stderr.on('data', (d) => { err += d })
  p.on('close', (code) => resolve({ code: code ?? 1, stdout: Buffer.concat(out), stderr: err }))
  p.on('error', (e) => resolve({ code: 1, stdout: Buffer.alloc(0), stderr: String(e) }))
})

export function creerTelechargeur(o: OptionsHttp = {}, exec: Exec = execCurl): Telechargeur {
  const delaiMin = o.delaiMinMs ?? 3000, delaiMax = o.delaiMaxMs ?? 6000, timeoutS = o.timeoutS ?? 40
  const tailleMax = o.tailleMaxOctets ?? 50 * 1024 * 1024, tentatives = o.tentatives ?? 2
  const dernierAcces = new Map<string, number>()

  async function attendre(hote: string) {
    const d = dernierAcces.get(hote); if (d !== undefined) {
      const delai = delaiMin + Math.random() * (delaiMax - delaiMin); const reste = d + delai - Date.now()
      if (reste > 0) await new Promise(r => setTimeout(r, reste))
    }
    dernierAcces.set(hote, Date.now())
  }

  async function unEssai(url: string): Promise<Telechargement> {
    const args = ['-sS', '-L', '--http1.1', '-4', '--max-time', String(timeoutS), '-A', UA, '-H', 'Accept-Language: fr-FR,fr;q=0.9', '-w', `${MARQUEUR}%{http_code} %{url_effective}`]
    if (o.proxy) args.unshift('-x', o.proxy)
    args.push(url)
    const r = await exec(args)
    if (r.code !== 0) return { statut: 0, octets: Buffer.alloc(0), urlFinale: url, contentType: null, erreur: expurger((r.stderr || `curl code ${r.code}`).trim().split('\n')[0], o.proxy) }
    const idx = r.stdout.lastIndexOf(MARQUEUR); const fin = r.stdout.subarray(idx + 1).toString().trim()
    const [code, ...urlParts] = fin.split(' '); const octets = r.stdout.subarray(0, idx)
    if (octets.length > tailleMax) return { statut: +code || 0, octets: Buffer.alloc(0), urlFinale: urlParts.join(' ') || url, contentType: null, erreur: `taille ${octets.length} > max ${tailleMax}` }
    return { statut: +code || 0, octets, urlFinale: urlParts.join(' ') || url, contentType: octets.subarray(0, 5).toString() === '%PDF-' ? 'application/pdf' : null }
  }

  return {
    async telecharger(url) {
      await attendre(new URL(url).host)
      let dernier: Telechargement | null = null
      for (let i = 0; i < tentatives; i++) { dernier = await unEssai(url); if (dernier.statut !== 0 || !dernier.erreur) break }
      return dernier!
    },
  }
}
