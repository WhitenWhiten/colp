import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { expandLocalRefs, readDocument } from './openapi-utils.mjs';

const args = process.argv.slice(2);
function option(name) {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}

const documentFile = option('--document');
const fixtureFile = option('--fixtures');
if (!documentFile && !fixtureFile) {
  throw new Error('Pass --document <openapi-file>, --fixtures <json-file>, or both.');
}

const ajv = new Ajv2020({ allErrors: true, strict: false, validateFormats: true });
addFormats(ajv);
const examples = [];
let openapiDocument;

if (documentFile) {
  openapiDocument = await readDocument(documentFile);
  for (const [name, schema] of Object.entries(openapiDocument.components?.schemas ?? {})) {
    for (const value of schema.examples ?? []) {
      examples.push({ name: `components.schemas.${name}`, schema: expandLocalRefs(openapiDocument, schema), value });
    }
    if (Object.hasOwn(schema, 'example')) {
      examples.push({ name: `components.schemas.${name}`, schema: expandLocalRefs(openapiDocument, schema), value: schema.example });
    }
  }
}

if (fixtureFile) {
  const fixture = await readDocument(fixtureFile);
  if (!Array.isArray(fixture)) throw new Error('Example fixture must be a { schema, value }[] array.');
  fixture.forEach((item, index) => {
    let schema = item.schema;
    if (typeof schema === 'string') {
      if (!openapiDocument) throw new Error('String fixture schemas require --document <openapi-file>.');
      schema = openapiDocument.components?.schemas?.[schema];
      if (!schema) throw new Error(`Unknown component schema in fixture[${index}]: ${item.schema}`);
      schema = expandLocalRefs(openapiDocument, schema);
    }
    examples.push({ name: `fixture[${index}]`, ...item, schema });
  });
}

if (examples.length === 0) {
  throw new Error('No schema examples were found; example validation must not pass vacuously.');
}

const failures = [];
for (const example of examples) {
  const validate = ajv.compile(example.schema);
  if (!validate(example.value)) {
    failures.push(`${example.name}: ${ajv.errorsText(validate.errors, { separator: '; ' })}`);
  }
}
if (failures.length > 0) {
  console.error(failures.map((failure) => `- ${failure}`).join('\n'));
  process.exitCode = 1;
} else {
  console.log(`Validated ${examples.length} OpenAPI schema example(s).`);
}
