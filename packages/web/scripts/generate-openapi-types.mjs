/**
 * Generate web Product API types from the trimmed server document.
 *
 * Reads packages/server/openapi/colp-server-v1.yaml directly. There is no
 * OpenAPI copy inside packages/web. The server generator
 * (packages/server/scripts/generate-openapi.mjs) still emits the full Known
 * client from openapi/product-v1.yaml; this script is the web type generator
 * and it takes the trimmed document as its only input.
 */
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse } from 'yaml'
import openapiTS, { astToString, COMMENT_HEADER } from 'openapi-typescript'

const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const documentPath = path.resolve(webRoot, '../server/openapi/colp-server-v1.yaml')
const outputPath = path.resolve(webRoot, 'src/generated/colp-server-v1.ts')

/** Sibling shape constraints apply to every anyOf branch. Same transform as the server generator. */
function preserveAnyOfSiblings(value) {
  if (Array.isArray(value)) return value.map(preserveAnyOfSiblings)
  if (!value || typeof value !== 'object') return value
  const result = Object.fromEntries(
    Object.entries(value).map(([key, child]) => [key, preserveAnyOfSiblings(child)]),
  )
  if (Array.isArray(result.anyOf) && (result.type || result.properties || result.required)) {
    const { anyOf, ...base } = result
    return { allOf: [base, { anyOf }] }
  }
  return result
}

const document = preserveAnyOfSiblings(parse(await readFile(documentPath, 'utf8')))
const typeAst = await openapiTS(document)
const banner = `/**
 * Generated from packages/server/openapi/colp-server-v1.yaml.
 * Do not edit. Regenerate with npm run generate:api-types.
 */

`
await writeFile(outputPath, `${banner}${COMMENT_HEADER}${astToString(typeAst)}`, 'utf8')
console.log(`Wrote ${path.relative(webRoot, outputPath)} from packages/server/openapi/colp-server-v1.yaml`)
