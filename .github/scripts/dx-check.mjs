// Fetches DX files from all repos, diffs them, optionally calls Copilot API,
// and opens a single issue in infra if drift is detected.
//
// Required secrets:
//   GH_PAT         — classic PAT with `repo` scope (to read private repos)
//   GITHUB_TOKEN   — automatic, used to open issues in infra
// Optional secrets:
//   COPILOT_TOKEN  — PAT with `copilot` scope for AI analysis
//
// Env: DRY_RUN (skip issue creation)

const TOKEN = process.env.GITHUB_TOKEN
if (!TOKEN) { console.error('GITHUB_TOKEN required'); process.exit(1) }

// PAT needed to read private repos cross-context.
const READ_TOKEN = process.env.GH_PAT || TOKEN

// AI analysis requires a PAT with copilot scope.
const AI_TOKEN = process.env.COPILOT_TOKEN || null

// Issues are always opened in this repo (GITHUB_TOKEN has write access here).
const INFRA_REPO = 'Gildraen/infra'

const REPOS = ['Gildraen/Niki', 'Gildraen/local-llm']

// Path in repo → display label
const DX_FILES = {
  '.gitattributes': 'gitattributes',
  '.gitignore': 'gitignore',
  'renovate.json': 'renovate.json',
  '.devcontainer/devcontainer.json': 'devcontainer.json',
  '.devcontainer/.gh/.gitignore': 'devcontainer/.gh/.gitignore',
  '.devcontainer/.mcp/.gitignore': 'devcontainer/.mcp/.gitignore',
  '.devcontainer/.mcp/github/.gitignore': 'devcontainer/.mcp/github/.gitignore',
  '.agents/rules/git.md': 'agents/git.md',
  '.github/workflows/validate.yml': 'workflows/validate',
  '.github/workflows/maintenance.yml': 'workflows/maintenance',
}

// ---------------------------------------------------------------------------
// GitHub REST helpers
// ---------------------------------------------------------------------------
async function ghFetch(path, opts = {}) {
  const { headers: extraHeaders = {}, ...restOpts } = opts
  const res = await fetch(`https://api.github.com${path}`, {
    ...restOpts,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      ...extraHeaders,
    },
  })
  return res
}

async function getFileContent(repo, filePath) {
  const res = await fetch(`https://api.github.com/repos/${repo}/contents/${filePath.split('/').map(encodeURIComponent).join('/')}`, {
    headers: {
      Authorization: `Bearer ${READ_TOKEN}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
  })
  if (res.status === 404 || res.status === 403) return null
  if (!res.ok) return null
  const data = await res.json()
  return Buffer.from(data.content, 'base64').toString('utf8')
}

async function openIssue(repo, title, body) {
  if (process.env.DRY_RUN) { console.log(`[dry-run] Would open issue in ${repo}: ${title}`); return }
  const res = await ghFetch(`/repos/${repo}/issues`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title, body }),
  })
  if (!res.ok) {
    const err = await res.text()
    throw new Error(`Failed to open issue in ${repo}: ${res.status} ${err}`)
  }
  const data = await res.json()
  console.log(`Issue opened: ${data.html_url}`)
}

async function findOpenDriftIssue(repo) {
  const res = await ghFetch(`/repos/${repo}/issues?state=open&per_page=20`)
  if (!res.ok) return null
  const issues = await res.json()
  return issues.find(i => i.title.startsWith('[dx-drift]')) || null
}

// ---------------------------------------------------------------------------
// GitHub Models API
// ---------------------------------------------------------------------------
async function callModel(prompt) {
  if (!AI_TOKEN) throw new Error('COPILOT_TOKEN secret not configured')
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
// Simple line-level diff summary
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

  const lines = []
  lines.push(`- \`${label}\` diffère entre **${repoA}** et **${repoB}**:`)
  if (onlyInA.length) lines.push(`  - seulement dans ${repoA}: \`${onlyInA.slice(0, 3).join('`, `')}\``)
  if (onlyInB.length) lines.push(`  - seulement dans ${repoB}: \`${onlyInB.slice(0, 3).join('`, `')}\``)
  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  console.log('Collecting DX snapshots…')
  const snapshots = {}
  for (const repo of REPOS) {
    snapshots[repo] = {}
    for (const [path, label] of Object.entries(DX_FILES)) {
      snapshots[repo][label] = await getFileContent(repo, path)
    }
    console.log(`  ${repo}: done`)
  }

  // Diff: Niki (reference) vs local-llm
  const [repoA, repoB] = REPOS
  const diffs = { [repoA]: [], [repoB]: [] }

  for (const [, label] of Object.entries(DX_FILES)) {
    const line = diffSummary(label, snapshots[repoA][label], snapshots[repoB][label], repoA, repoB)
    if (line) { diffs[repoA].push(line); diffs[repoB].push(line) }
  }

  const driftedRepos = diffs[repoA].length > 0 ? REPOS : []

  if (!driftedRepos.length) {
    console.log('No DX drift detected. All repos are coherent.')
    return
  }

  console.log(`Drift detected between ${repoA} and ${repoB}`)
  console.log(AI_TOKEN ? 'Calling Copilot API for analysis…' : 'No COPILOT_TOKEN — skipping AI analysis.')

  const allDiffs = diffs[repoA].join('\n')

  let analysis = '_Analyse IA indisponible. Pour l\'activer, configurez le secret `COPILOT_TOKEN` dans le repo infra (PAT avec scope `copilot`)._'
  try {
    analysis = await callModel(`
Tu analyses la cohérence DX (developer experience) entre 2 repos GitHub d'un même développeur.
Les repos sont : ${repoA} (référence) et ${repoB}.

Voici les différences détectées dans les fichiers DX (gitattributes, gitignore, renovate.json, devcontainer.json, protections secrets devcontainer, agents/git.md, CI workflows) :

${allDiffs}

1. Explique en 2-3 lignes pourquoi ces différences sont problématiques.
2. Donne les actions concrètes prioritaires pour aligner (maximum 3 bullet points).
3. Signale si une différence est intentionnelle et acceptable (ex: local-llm a des fichiers spécifiques à Ollama absents dans Niki — c'est normal).

Réponds en markdown, en français, de façon très concise.
`.trim())
  } catch (e) {
    console.warn(`AI analysis skipped: ${e.message}`)
  }

  console.log('\n--- Analysis ---\n', analysis, '\n---\n')

  // Open one issue in infra (GITHUB_TOKEN has write access here)
  const existing = await findOpenDriftIssue(INFRA_REPO)
  if (existing) {
    console.log(`Issue already open: ${existing.html_url} — skipping`)
    return
  }

  const body = `## DX drift détecté — rapport automatique

> Généré par le workflow \`dx-coherence\`. Repos comparés : [${repoA}](https://github.com/${repoA}) (référence) et [${repoB}](https://github.com/${repoB}).

### Différences identifiées

${allDiffs}

---

### Analyse IA

${analysis}

---

*Fermer cette issue une fois les fichiers DX alignés. Le prochain run hebdomadaire vérifiera à nouveau.*`

  await openIssue(INFRA_REPO, '[dx-drift] Incohérence DX détectée', body)
}

main().catch(e => { console.error(e); process.exit(1) })
