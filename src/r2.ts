// Archive des PDF, textes extraits et images de pages dans R2 (API S3). Clé : arretes/<saison>/<dept>/<sha256>.pdf
import { S3Client, PutObjectCommand, GetObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3'
import type { Env } from './env.ts'

export interface Archive { deposer(cle: string, octets: Buffer, contentType: string): Promise<void>; lire(cle: string): Promise<Buffer>; existe(cle: string): Promise<boolean> }

export function creerArchiveR2(r2: Env['r2']): Archive {
  const client = new S3Client({ region: 'auto', endpoint: `https://${r2.accountId}.eu.r2.cloudflarestorage.com`, credentials: { accessKeyId: r2.accessKeyId, secretAccessKey: r2.secretAccessKey } })
  return {
    async deposer(cle, octets, contentType) { await client.send(new PutObjectCommand({ Bucket: r2.bucket, Key: cle, Body: octets, ContentType: contentType })) },
    async lire(cle) { const r = await client.send(new GetObjectCommand({ Bucket: r2.bucket, Key: cle })); return Buffer.from(await r.Body!.transformToByteArray()) },
    async existe(cle) {
      try { await client.send(new HeadObjectCommand({ Bucket: r2.bucket, Key: cle })); return true }
      catch (e: any) { if (e?.name === 'NotFound' || e?.$metadata?.httpStatusCode === 404) return false; throw e }
    },
  }
}
export function creerArchiveMemoire(): Archive & { objets: Map<string, Buffer> } {
  const objets = new Map<string, Buffer>()
  return { objets, async deposer(c, o) { objets.set(c, o) }, async lire(c) { const o = objets.get(c); if (!o) throw new Error(`Objet absent : ${c}`); return o }, async existe(c) { return objets.has(c) } }
}
export const cleArchive = (saison: string, dept: string, sha256: string, ext: 'pdf' | 'texte.json') => `arretes/${saison}/${dept}/${sha256}.${ext}`
/** Image PNG d'une page scannée (produite avec la lecture mécanique, relue par le contrôle C1). */
export const cleImagePage = (saison: string, dept: string, sha256: string, page: number) => `arretes/${saison}/${dept}/${sha256}.page-${page}.png`
