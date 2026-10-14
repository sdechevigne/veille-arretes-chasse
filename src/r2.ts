// Archive des PDF et textes extraits dans R2 (API S3). Clé : arretes/<saison>/<dept>/<sha256>.pdf
import { S3Client, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3'
import type { Env } from './env.ts'

export interface Archive { deposer(cle: string, octets: Buffer, contentType: string): Promise<void>; lire(cle: string): Promise<Buffer> }

export function creerArchiveR2(r2: Env['r2']): Archive {
  const client = new S3Client({ region: 'auto', endpoint: `https://${r2.accountId}.eu.r2.cloudflarestorage.com`, credentials: { accessKeyId: r2.accessKeyId, secretAccessKey: r2.secretAccessKey } })
  return {
    async deposer(cle, octets, contentType) { await client.send(new PutObjectCommand({ Bucket: r2.bucket, Key: cle, Body: octets, ContentType: contentType })) },
    async lire(cle) { const r = await client.send(new GetObjectCommand({ Bucket: r2.bucket, Key: cle })); return Buffer.from(await r.Body!.transformToByteArray()) },
  }
}
export function creerArchiveMemoire(): Archive & { objets: Map<string, Buffer> } {
  const objets = new Map<string, Buffer>()
  return { objets, async deposer(c, o) { objets.set(c, o) }, async lire(c) { const o = objets.get(c); if (!o) throw new Error(`Objet absent : ${c}`); return o } }
}
export const cleArchive = (saison: string, dept: string, sha256: string, ext: 'pdf' | 'texte.json') => `arretes/${saison}/${dept}/${sha256}.${ext}`
