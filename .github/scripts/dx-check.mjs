// Compares DX files of this repo against all peer repos.
// Identical script runs in every repo — GITHUB_REPOSITORY tells it where it is.
//
// Required secrets:
//   GH_PAT        — classic PAT with `repo` scope (to read private repos)
//   GITHUB_TOKEN  — automatic, used to open issues in this repo
// Optional secrets:
//   COPILOT_TOKEN — PAT with `copilot` scope for AI analysis
//
// Env: GITHUB_REPOSITORY (auto-set by Actions), DRY_RUN (skip issue creation)

const TOKEN = process.env.GITHUB_TOKEN
if (!TOKEN) { console.error('GITHUB_TOKEN required'); process.exit(1) }

const CURRENT_REPO = process.env.GITHUB_REPOSITORY
if (!CURRENT_REPO) { console.error('GITHUB_REPOSITORY required'); process.exit(1) }

// PAT needed to read private repos.
const READ_TOKEN = process.env.GH_PAT || TOKEN

// AI analysis requires a PAT with copilot scope.
const AI_TOKEN = process.env.COPILOT_TOKEN || null

// All repos in the DX ecosystem. Niki is the reference.
const ALL_REPOS = ['Gildraen/Niki', 'Gildraen/local-llm']
const REFERENCE_REPO = 'Gildraen/Niki'

// Peers to compare against (everyone except self).
const PEERS = ALL_REPOS.filter(r => r !== CURRENT_REPO)

// Path in repo → display label
const DX_FILES = {
  '.gitattributes':                          'gitattributes',
  '.gitignore':                              'gitignore',
  'renovate.json':                           'renovate.json',
  '.devcontainer/devcontainer.json':         'devcontainer.json',
  '.devcontainer/.gh/.gitignore':            'devcontainer/.gh/.gitignore',
  '.devcontainer/.mcp/.gitignore':           'devcontainer/.mcp/.gitignore',
  '.devcontainer/.mcp/github/.gitignore':    'devcontainer/.mcp/github/.gitignore',
  '.agents/rules/git.md':                    'agents/git.md',
  '.github/workflows/validate.yml':          'workflows/validate',
  '.github/workflows/maintenance.yml':       'workflows/maintenance',
  '.github/workflows/dx-coherence.yml':      'workflows/dx-coherence',
  '.github/scripts/dx-check.mjs':            'scripts/dx-check',
}

// ---------------------------------------------------------------------------
// GitHub REST helpers
// ---------------------------------------------------------------------------
async function readFile(repo, filePath) {
  const url = `https://api.github.com/repos/${repo}/contents/${filePath.split('/').map(encodeURIComponent).join('/')}`
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${READ_TOKEN}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
  })
  if (!res.ok) return null
  const data = await res.json()
  return Buffer.from(data.content, 'base64').toString('utf8')
}

async function openIssue(title, body) {
  if (process.env.DRY_RUN) { console.log(`[dry-run] Would open issue: ${title}`); return }
  const res = await fetch(`https://api.github.com/repos/${CURRENT_REPO}/issues`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ title, body }),
  })
  if (!res.ok) {
    const err = await res.text()
    throw new Error(`Failed to open issue: ${res.status} ${err}`)
  }
  const data = await res.json()
  console.log(`Issue opened: ${data.html_url}`)
}

async function findOpenDriftIssue() {
  const res = await fetch(`https://api.github.com/repos/${CURRENT_REPO}/issues?state=open&per_page=20`, {
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
  })
  if (!res.ok) return null
  const issues = await res.json()
  return issues.find(i => i.title.startsWith('[dx-drift]')) || null
}

// ---------------------------------------------------------------------------
// GitHub Copilot API (optional)
// ---------------------------------------------------------------------------
async function callModel(prompt) {
  if (!AI_TOKEN) throw new Error('COPILOT_TOKEN not configured')
  const res = await fetch('https://api.githubcopilot.com/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${AI_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 1200,
      temperature: 0.2,
    }),
  })
  if (!res.ok) {
    const err = await res.text()
    throw new Error(`Copilot API error ${res.status}: ${err}`)
  }
  const data = await res.json()
  return data.choices[0].message.content.trim()
}

// ---------------------------------------------------------------------------
// Diff
// ---------------------------------------------------------------------------
function diffSummary(label, a, b, repoA, repoB) {
  if (a === null && b === null) return null
  if (a === null) return `- \`${label}\` absent dans **${repoA}**, présent dans **${repoB}**`
  if (b === null) return `- \`${label}\` présent dans **${repoA}**, absent dans **${repoB}**`
  if (a.trim() === b.trim()) return null

  const linesA = a.split('\n')
  const linesB = b.split('\n')
  const onlyInA = linesA.filter(l => l.trim() && !linesB.includes(l))
  const onlyInB = linesB.filter(l => l.trim() && !linesA.includes(l))
  if (!onlyInA.length && !onlyInB.length) return null

  const lines = [`- \`${label}\` diffère entre **${repoA}** et **${repoB}**:`]
  if (onlyInA.length) lines.push(`  - seulement dans ${repoA}: \`${onlyInA.slice(0, 3).join('`, `')}\``)
  if (onlyInB.length) lines.push(`  - seulement dans ${repoB}: \`${onlyInB.slice(0, 3).join('`, `')}\``)
  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  if (!PEERS.length) {
    console.log(`${CURRENT_REPO} has no peers to compare against.`)
    return
  }

  console.log(`Running DX check for ${CURRENT_REPO} against: ${PEERS.join(', ')}`)

  const snapshots = {}
  for (const repo of [CURRENT_REPO, ...PEERS]) {
    snapshots[repo] = {}
    for (const [path, label] of Object.entries(DX_FILES)) {
      snapshots[repo][label] = await readFile(repo, path)
    }
    console.log(`  ${repo}: fetched`)
  }

  // Compare current repo against reference
  const ref = PEERS.includes(REFERENCE_REPO) ? REFERENCE_REPO : PEERS[0]
  const diffLines = []

  for (const [, label] of Object.entries(DX_FILES)) {
    const line = diffSummary(label, snapshots[ref][label], snapshots[CURRENT_REPO][label], ref, CURRENT_REPO)
    if (line) diffLines.push(line)
  }

  if (!diffLines.length) {
    console.log('No DX drift detected.')
    return
  }

  console.log(`Drift detected (${diffLines.length} differences)`)
  console.log(AI_TOKEN ? 'Calling Copilot API for analysis…' : 'No COPILOT_TOKEN — skipping AI analysis.')

  let analysis = "_Analyse IA indisponible. Pour l'activer, configurez le secret `COPILOT_TOKEN` (PAT avec scope `copilot`)._"
  try {
    analysis = await callModel(`
Tu analyses la cohérence DX entre 2 repos GitHub d'un même développeur.
Référence : ${ref}. Repo analysé : ${CURRENT_REPO}.

Différences détectées dans les fichiers DX :

${diffLines.join('\n')}

1. Explique en 2-3 lignes pourquoi ces différences sont problématiques.
2. Actions concrètes prioritaires pour aligner ${CURRENT_REPO} (max 3 bullet points).
3. Signale si une différence est intentionnelle et acceptable.

Réponds en markdown, en français, très concis.
`.trim())
  } catch (e) {
    console.warn(`AI analysis skipped: ${e.message}`)
  }

  console.log('\n--- Analysis ---\n', analysis, '\n---\n')

  const existing = await findOpenDriftIssue()
  if (existing) {
    console.log(`Issue already open: ${existing.html_url} — skipping`)
    return
  }

  const body = `## DX drift détecté — rapport automatique

> Généré par le workflow \`dx-coherence\`. Comparé contre [${ref}](https://github.com/${ref}) (référence).

### Différences identifiées

${diffLines.join('\n')}

---

### Analyse IA

${analysis}

---

*Fermer cette issue une fois les fichiers DX alignés.*`

  await openIssue('[dx-drift] Incohérence DX détectée', body)
}

main().catch(e => { console.error(e); process.exit(1) })
