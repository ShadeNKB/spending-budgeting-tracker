#!/usr/bin/env node
// Fails when the e2e job's Playwright container image and the installed @playwright/test differ.
// The browsers come baked into mcr.microsoft.com/playwright:v<version>-noble, and a Playwright
// package only drives the browser builds of its own version: an upgrade that forgets the image
// would fail every e2e shard with "Executable doesn't exist". This makes it fail in Validate,
// in a second. Usage: node scripts/check-playwright-image.mjs [package-lock.json] [ci.yml]
import { readFileSync } from 'node:fs'

const LOCK = process.argv[2] ?? 'package-lock.json'
const WORKFLOW = process.argv[3] ?? '.github/workflows/ci.yml'
const IMAGE = /mcr\.microsoft\.com\/playwright:v(\d+\.\d+\.\d+)(?:-[a-z]+)?/g

function read(path) {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return null
  }
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

  const workflow = read(WORKFLOW)
  if (workflow === null) {
    console.error(`Cannot read ${WORKFLOW}.`)
    return 1
  }
  const tags = [...workflow.matchAll(IMAGE)]
  if (tags.length === 0) {
    console.error(
      `${WORKFLOW} names no mcr.microsoft.com/playwright:v<version> image.\n` +
        'The e2e shards run in that container (it carries the browsers); put it back in their\n' +
        '`container:` block, tagged with the @playwright/test version.',
    )
    return 1
  }

  const wrong = tags.filter(([, tag]) => tag !== version)
  if (wrong.length > 0) {
    console.error(
      `@playwright/test is ${version} (${LOCK}), but ${WORKFLOW} runs the e2e shards in\n` +
        `${wrong.map(([image]) => image).join(', ')}.\n` +
        `Set the image to mcr.microsoft.com/playwright:v${version}-noble (check the tag exists:\n` +
        'https://mcr.microsoft.com/v2/playwright/tags/list).',
    )
    return 1
  }

  console.log(`Playwright image matches @playwright/test ${version}: ${tags[0][0]}`)
  return 0
}

process.exitCode = main()
