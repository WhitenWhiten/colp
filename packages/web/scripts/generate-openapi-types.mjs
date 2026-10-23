/**
 * Generate web Product API types from the trimmed server document.
 *
 * Reads packages/server/openapi/colp-server-v1.yaml directly. There is no
 * OpenAPI copy inside packages/web. The server generator
 * (packages/server/scripts/generate-openapi.mjs) still emits the full Known
 * client from openapi/product-v1.yaml; this script is the web type generator
 * and it takes the trimmed document as its main input.
 *
 * Automations are optional and stay out of the trimmed document. Their types
 * come from the server's producer mirror, openapi/fragments/automations.yaml
 * (kept in step with product-v1.yaml by sync-automation-openapi.mjs). Its
 * responses name the server's shared transport headers, which this script
 * copies in from the trimmed document.
 *
 * `--check` regenerates in memory and fails when a committed file differs.
 */
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse } from 'yaml'
import openapiTS, { astToString, COMMENT_HEADER } from 'openapi-typescript'

const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const documentPath = path.resolve(webRoot, '../server/openapi/colp-server-v1.yaml')
const outputPath = path.resolve(webRoot, 'src/generated/colp-server-v1.ts')
const automationPath = path.resolve(webRoot, '../server/openapi/fragments/automations.yaml')
const automationOutputPath = path.resolve(webRoot, 'src/generated/automations-v1.ts')

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

const check = process.argv.includes('--check')
const stale = []

/** Write the file, or in check mode record that the committed one differs. */
async function emit(target, content, source) {
  const relative = path.relative(webRoot, target)
  if (!check) {
    await writeFile(target, content, 'utf8')
    console.log(`Wrote ${relative} from ${source}`)
  } else if (await readFile(target, 'utf8').catch(() => null) !== content) stale.push(relative)
}

/** Copy the components a fragment references but does not carry, and theirs, from the full document. */
function withSharedComponents(fragment, shared) {
  const components = structuredClone(fragment.components ?? {})
  const pending = [fragment.paths, components]
  while (pending.length) {
    const value = pending.pop()
    if (Array.isArray(value)) { pending.push(...value); continue }
    if (!value || typeof value !== 'object') continue
    const match = typeof value.$ref === 'string' ? /^#\/components\/([^/]+)\/([^/]+)$/u.exec(value.$ref) : null
    if (match && !components[match[1]]?.[match[2]]) {
      const [, category, name] = match
      const definition = shared.components?.[category]?.[name]
      if (!definition) throw new Error(`Unresolved shared component ${value.$ref}`)
      components[category] = { ...components[category], [name]: structuredClone(definition) }
      pending.push(components[category][name])
    }
    pending.push(...Object.values(value))
  }
  return { ...fragment, components }
}

const source = parse(await readFile(documentPath, 'utf8'))
const document = preserveAnyOfSiblings(source)
const typeAst = await openapiTS(document)
const banner = `/**
 * Generated from packages/server/openapi/colp-server-v1.yaml.
 * Do not edit. Regenerate with npm run generate:api-types.
 */

`
await emit(outputPath, `${banner}${COMMENT_HEADER}${astToString(typeAst)}`, 'packages/server/openapi/colp-server-v1.yaml')

// The fragment is paths + components only; wrap it as a document.
const fragment = withSharedComponents(parse(await readFile(automationPath, 'utf8')), source)
const automationAst = await openapiTS(preserveAnyOfSiblings({
  openapi: '3.1.0',
  info: { title: 'COLP Automations', version: '0.2.1-design' },
  ...fragment,
}))
const automationBanner = `/**
 * Generated from packages/server/openapi/fragments/automations.yaml.
 * Do not edit. Regenerate with npm run generate:api-types.
 */

`
await emit(automationOutputPath, `${automationBanner}${COMMENT_HEADER}${astToString(automationAst)}`,
  'packages/server/openapi/fragments/automations.yaml')

if (stale.length > 0) {
  console.error(`Generated API types are stale; run npm run generate:api-types:\n${stale.map((file) => `  ${file}`).join('\n')}`)
  process.exitCode = 1
}
