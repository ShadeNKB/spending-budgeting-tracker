#!/usr/bin/env node
// Renders the opaque install icons from the inline SVG sources below, using the Chromium that
// Playwright already installs for the e2e suite. Dev tool, not part of `npm run verify`:
//
//   node scripts/render-icons.mjs
//
// Writes, into public/:
//   icon-maskable-192.png, icon-maskable-512.png  manifest icons with purpose "maskable"
//   apple-touch-icon.png (180)                     iOS home-screen icon
//   shortcut-add-96.png                            the "Add expense" app shortcut
//
// Launchers and iOS mask these icons themselves, so each one is full-bleed with no rounded
// corners, and the mark stays inside the central safe zone (ring outer radius 9.25/32 = 29% of
// the side, well inside the 40% maskable safe circle). Every pixel is asserted opaque before a
// file is written, the PNG is encoded as RGB (colour type 2, no alpha channel at all), and the
// written file is decoded again by the browser and compared pixel for pixel.
import { chromium } from '@playwright/test'
import { writeFileSync } from 'node:fs'
import { deflateSync } from 'node:zlib'

const OUT = new URL('../public/', import.meta.url)

// Same palette as public/favicon.svg and src/ui/SpendLogo.tsx.
const defs = `
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="32" y2="32" gradientUnits="userSpaceOnUse">
      <stop offset="0%" stop-color="#0E1217"/>
      <stop offset="100%" stop-color="#161B22"/>
    </linearGradient>
    <linearGradient id="ring" x1="6" y1="6" x2="26" y2="26" gradientUnits="userSpaceOnUse">
      <stop offset="0%" stop-color="#22D3EE"/>
      <stop offset="100%" stop-color="#3B82F6"/>
    </linearGradient>
  </defs>
  <rect width="32" height="32" fill="url(#bg)"/>`

const svg = (size, body) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 32 32">${defs}${body}</svg>`

// The PaceRing mark from the favicon, without the favicon's rounded tile and hairline border.
const paceRing = `
  <circle cx="16" cy="16" r="8" fill="none" stroke="rgba(255,255,255,0.12)" stroke-width="2.5"/>
  <circle cx="16" cy="16" r="8" fill="none" stroke="url(#ring)" stroke-width="2.5"
    stroke-linecap="round" stroke-dasharray="50.27" stroke-dashoffset="27.15"
    transform="rotate(-90 16 16)"/>
  <circle cx="16" cy="16" r="2" fill="url(#ring)"/>`

const plus = `
  <path d="M16 10.5v11M10.5 16h11" fill="none" stroke="url(#ring)" stroke-width="3"
    stroke-linecap="round"/>`

const ICONS = [
  { file: 'icon-maskable-192.png', size: 192, body: paceRing },
  { file: 'icon-maskable-512.png', size: 512, body: paceRing },
  { file: 'apple-touch-icon.png', size: 180, body: paceRing },
  { file: 'shortcut-add-96.png', size: 96, body: plus },
]

// ─── PNG (RGB, 8-bit) encoder ──────────────────────────────────────────────

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})

function crc32(buf) {
  let crc = 0xffffffff
  for (const byte of buf) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length)
  out.writeUInt32BE(data.length, 0)
  out.write(type, 4, 'latin1')
  data.copy(out, 8)
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length)
  return out
}

function paeth(a, b, c) {
  const p = a + b - c
  const pa = Math.abs(p - a)
  const pb = Math.abs(p - b)
  const pc = Math.abs(p - c)
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c
}

/** Picks, per row, the PNG filter with the smallest sum of absolute residuals. */
function filterRows(rgb, width, height) {
  const stride = width * 3
  const out = Buffer.alloc((stride + 1) * height)
  const candidate = Buffer.alloc(stride)
  for (let y = 0; y < height; y++) {
    const row = rgb.subarray(y * stride, (y + 1) * stride)
    const up = y > 0 ? rgb.subarray((y - 1) * stride, y * stride) : Buffer.alloc(stride)
    let best = null
    let bestScore = Infinity
    for (let filter = 0; filter <= 4; filter++) {
      let score = 0
      for (let x = 0; x < stride; x++) {
        const a = x >= 3 ? row[x - 3] : 0
        const b = up[x]
        const c = x >= 3 ? up[x - 3] : 0
        const predictor = [0, a, b, (a + b) >> 1, paeth(a, b, c)][filter]
        const value = (row[x] - predictor) & 0xff
        candidate[x] = value
        score += value < 128 ? value : 256 - value
      }
      if (score < bestScore) {
        bestScore = score
        best = { filter, bytes: Buffer.from(candidate) }
      }
    }
    out[y * (stride + 1)] = best.filter
    best.bytes.copy(out, y * (stride + 1) + 1)
  }
  return out
}

function encodePngRgb(rgb, width, height) {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 2 // colour type: RGB, no alpha
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(filterRows(rgb, width, height), { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

// ─── rendering ─────────────────────────────────────────────────────────────

/** Rasterises an image URL at `size` in the page; returns RGBA pixels as base64. */
function rasterise({ url, size }) {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => {
      const canvas = document.createElement('canvas')
      canvas.width = size
      canvas.height = size
      const ctx = canvas.getContext('2d')
      ctx.drawImage(img, 0, 0, size, size)
      const { data } = ctx.getImageData(0, 0, size, size)
      let binary = ''
      for (let i = 0; i < data.length; i += 0x8000) {
        binary += String.fromCharCode(...data.subarray(i, i + 0x8000))
      }
      resolve(btoa(binary))
    }
    img.onerror = () => reject(new Error(`could not decode ${url.slice(0, 40)}`))
    img.src = url
  })
}

const browser = await chromium.launch()
try {
  const page = await browser.newPage()
  for (const { file, size, body } of ICONS) {
    const source = `data:image/svg+xml;base64,${Buffer.from(svg(size, body)).toString('base64')}`
    const rgba = Buffer.from(await page.evaluate(rasterise, { url: source, size }), 'base64')

    const rgb = Buffer.alloc(size * size * 3)
    for (let i = 0, j = 0; i < rgba.length; i += 4, j += 3) {
      if (rgba[i + 3] !== 255) {
        throw new Error(`${file}: pixel ${i / 4} has alpha ${rgba[i + 3]}; icons must be opaque`)
      }
      rgb[j] = rgba[i]
      rgb[j + 1] = rgba[i + 1]
      rgb[j + 2] = rgba[i + 2]
    }

    const png = encodePngRgb(rgb, size, size)
    const decoded = Buffer.from(
      await page.evaluate(rasterise, {
        url: `data:image/png;base64,${png.toString('base64')}`,
        size,
      }),
      'base64',
    )
    if (!decoded.equals(rgba)) throw new Error(`${file}: PNG round trip changed pixels`)

    writeFileSync(new URL(file, OUT), png)
    console.log(`${file.padEnd(24)} ${size}x${size}  ${(png.length / 1024).toFixed(1)} KB  opaque`)
  }
} finally {
  await browser.close()
}
