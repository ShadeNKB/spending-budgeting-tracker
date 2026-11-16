#!/usr/bin/env node
// Fails when the e2e job's Playwright container image and the installed @playwright/test differ.
// The browsers come baked into mcr.microsoft.com/playwright:v<version>-noble, and a Playwright
// package only drives the browser builds of its own version: an upgrade that forgets the image
// would fail every e2e shard with "Executable doesn't exist". This makes it fail in Validate,
// in a second. Every workflow that runs browsers in that image is checked: the e2e shards (ci.yml)
// and the data-engine suite (e2e-data.yml), and each must name the image.
// Usage: node scripts/check-playwright-image.mjs [package-lock.json] [workflow.yml ...]
import { readFileSync } from 'node:fs'

const LOCK = process.argv[2] ?? 'package-lock.json'
const WORKFLOWS =
  process.argv.length > 3
    ? process.argv.slice(3)
    : ['.github/workflows/ci.yml', '.github/workflows/e2e-data.yml']
const IMAGE = /mcr\.microsoft\.com\/playwright:v(\d+\.\d+\.\d+)(?:-[a-z]+)?/g

function read(path) {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return null
  }
}

function checkWorkflow(file, version) {
  const workflow = read(file)
  if (workflow === null) {
    console.error(`Cannot read ${file}.`)
    return 1
  }
  const tags = [...workflow.matchAll(IMAGE)]
  if (tags.length === 0) {
    console.error(
      `${file} names no mcr.microsoft.com/playwright:v<version> image.\n` +
        'Its browser jobs run in that container (it carries the browsers); put it back in their\n' +
        '`container:` block, tagged with the @playwright/test version.',
    )
    return 1
  }

  const wrong = tags.filter(([, tag]) => tag !== version)
  if (wrong.length > 0) {
    console.error(
      `@playwright/test is ${version} (${LOCK}), but ${file} runs its browsers in\n` +
        `${wrong.map(([image]) => image).join(', ')}.\n` +
        `Set the image to mcr.microsoft.com/playwright:v${version}-noble (check the tag exists:\n` +
        'https://mcr.microsoft.com/v2/playwright/tags/list).',
    )
    return 1
  }

  console.log(`Playwright image matches @playwright/test ${version} in ${file}: ${tags[0][0]}`)
  return 0
}

function main() {
  const lockText = read(LOCK)
  if (lockText === null) {
    console.error(`Cannot read ${LOCK}.`)
    return 1
  }
  let version
  try {
    version = JSON.parse(lockText).packages?.['node_modules/@playwright/test']?.version
  } catch {
    console.error(`${LOCK} is not valid JSON.`)
    return 1
  }
  if (!version) {
    console.error(`${LOCK} has no node_modules/@playwright/test entry with a version.`)
    return 1
  }

  for (const file of WORKFLOWS) {
    const status = checkWorkflow(file, version)
    if (status !== 0) return status
  }
  return 0
}

process.exitCode = main()
