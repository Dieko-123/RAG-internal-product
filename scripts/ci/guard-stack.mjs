import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'

const root = process.cwd()
const packageJson = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'))
const deps = {
  ...packageJson.dependencies,
  ...packageJson.devDependencies,
}

const failures = []

if (!existsSync(path.join(root, 'vite.config.ts')) && !existsSync(path.join(root, 'vite.config.js'))) {
  failures.push('Missing vite.config.ts or vite.config.js.')
}

if (!deps.vite) {
  failures.push('Missing vite dependency.')
}

if (!deps.react || !deps['react-dom']) {
  failures.push('Missing React dependencies.')
}

if (!deps['@vitejs/plugin-react']) {
  failures.push('Missing @vitejs/plugin-react dependency.')
}

if (deps.next) {
  failures.push('Next.js dependency detected. This project must remain React + Vite.')
}

for (const configName of ['next.config.js', 'next.config.mjs', 'next.config.ts']) {
  if (existsSync(path.join(root, configName))) {
    failures.push(`${configName} detected. This project must not be converted to Next.js.`)
  }
}

const appDir = path.join(root, 'app')
const pagesDir = path.join(root, 'pages')
if (existsSync(path.join(appDir, 'layout.tsx')) || existsSync(path.join(appDir, 'page.tsx'))) {
  failures.push('Next.js App Router files detected in app/.')
}
if (existsSync(path.join(pagesDir, '_app.tsx')) || existsSync(path.join(pagesDir, 'api'))) {
  failures.push('Next.js Pages Router files detected in pages/.')
}

const trackedFiles = execFileSync(
  'git',
  ['ls-files', '--cached', '--others', '--exclude-standard'],
  {
    cwd: root,
    encoding: 'utf8',
  },
)
  .split(/\r?\n/)
  .filter(Boolean)

for (const file of trackedFiles) {
  if (!file.startsWith('src/')) continue
  if (!/\.(ts|tsx|js|jsx)$/.test(file)) continue

  const contents = readFileSync(path.join(root, file), 'utf8')

  if (contents.includes('@google/genai')) {
    failures.push(`${file} imports @google/genai. Gemini must stay in Convex/server-side code.`)
  }

  if (contents.includes('GEMINI_API_KEY')) {
    failures.push(`${file} references GEMINI_API_KEY. Gemini secrets must not enter frontend code.`)
  }
}

if (failures.length > 0) {
  console.error('Stack guard failed:')
  for (const failure of failures) console.error(`- ${failure}`)
  process.exit(1)
}

console.log('Stack guard passed.')
