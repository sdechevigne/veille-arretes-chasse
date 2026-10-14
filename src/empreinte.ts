import { createHash } from 'node:crypto'
export const sha256 = (octets: Buffer) => createHash('sha256').update(octets).digest('hex')
