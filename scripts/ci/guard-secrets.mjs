import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'

const root = process.cwd()
const placeholderValues = new Set([
  '',
  'placeholder',
  'your_key_here',
  'your-key-here',
  'your_api_key_here',
  'your-api-key-here',
  '<placeholder>',
  '<your_key_here>',
  'changeme',
  'change_me',
])

const trackedFiles = execFileSync('git', ['ls-files'], {
  cwd: root,
  encoding: 'utf8',
})
  .split(/\r?\n/)
  .filter(Boolean)

const failures = []

if (trackedFiles.includes('.env.local')) {
  failures.push('.env.local is tracked; it must remain local-only and ignored.')
}

const allowedPlaceholderFiles = new Set(['.env.example'])
const skipFiles = new Set(['scripts/ci/guard-secrets.mjs'])

const scannableExtensions = new Set([
  '.env',
  '.js',
  '.jsx',
  '.ts',
  '.tsx',
  '.json',
  '.mjs',
  '.cjs',
  '.yml',
  '.yaml',
  '.toml',
])

function shouldScan(file) {
  if (skipFiles.has(file) || allowedPlaceholderFiles.has(file)) return false
  if (file.startsWith('node_modules/') || file.startsWith('dist/')) return false
  if (file.endsWith('.lock')) return false
  const ext = path.extname(file)
  return scannableExtensions.has(ext) || path.basename(file).startsWith('.env')
}

function isPlaceholder(value) {
  const normalized = value
    .trim()
    .replace(/^['"]|['"]$/g, '')
    .replace(/\s+#.*$/, '')
    .trim()
    .toLowerCase()

  if (placeholderValues.has(normalized)) return true
  if (normalized.includes('placeholder')) return true
  if (normalized.startsWith('your_') || normalized.startsWith('your-')) return true
  return false
}

function scanEnvAssignment(file, line, lineNumber) {
  const match = line.match(/^\s*(GEMINI_API_KEY|CLERK_SECRET_KEY)\s*=\s*(.*)$/)
  if (!match) return

  const [, name, rawValue] = match
  const value = rawValue.trim()
  if (!isPlaceholder(value)) {
    failures.push(`${file}:${lineNumber} contains a real-looking ${name} value.`)
  }
}

for (const file of trackedFiles) {
  if (!shouldScan(file)) continue

  let contents
  try {
    contents = readFileSync(path.join(root, file), 'utf8')
  } catch {
    continue
  }

  const lines = contents.split(/\r?\n/)
  lines.forEach((line, index) => {
    const lineNumber = index + 1
    scanEnvAssignment(file, line, lineNumber)

    if (/sk_(live|test)_[0-9A-Za-z_-]{12,}/.test(line)) {
      failures.push(`${file}:${lineNumber} contains a real-looking secret key.`)
    }

    if (/AIza[0-9A-Za-z_-]{20,}/.test(line)) {
      failures.push(`${file}:${lineNumber} contains a real-looking Google API key.`)
    }
  })

  if (/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(contents)) {
    failures.push(`${file} contains a private key block.`)
  }
}

if (failures.length > 0) {
  console.error('Secret guard failed:')
  for (const failure of failures) console.error(`- ${failure}`)
  process.exit(1)
}

console.log('Secret guard passed.')
