// Fetches DX files from all repos, diffs them, calls GitHub Models,
// and opens an issue in each repo that has drifted.
//
// DX files tracked: .gitattributes  .gitignore  devcontainer.json
//                   agents-git.md   validate.yml  maintenance.yml
//
// Run: node .github/scripts/dx-check.mjs
// Env: GITHUB_TOKEN, DRY_RUN (optional, skip issue creation)

import { execSync } from 'child_process'

const TOKEN = process.env.GITHUB_TOKEN
if (!TOKEN) { console.error('GITHUB_TOKEN required'); process.exit(1) }

const REPOS = ['Gildraen/Niki', 'Gildraen/local-llm', 'Gildraen/infra']

// Path in repo → display label
const DX_FILES = {
  '.gitattributes':                    'gitattributes',
  '.gitignore':                        'gitignore',
  '.devcontainer/devcontainer.json':   'devcontainer.json',
  '.agents/rules/git.md':              'agents/git.md',
  '.github/workflows/validate.yml':    'workflows/validate',
  '.github/workflows/maintenance.yml': 'workflows/maintenance',
}

// ---------------------------------------------------------------------------
// GitHub REST helpers
// ---------------------------------------------------------------------------
async function ghFetch(path, opts = {}) {
  const res = await fetch(`https://api.github.com${path}`, {
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      ...opts.headers,
    },
    ...opts,
  })
  return res
}

async function getFileContent(repo, filePath) {
  const res = await ghFetch(`/repos/${repo}/contents/${encodeURIComponent(filePath)}`)
  if (res.status === 404) return null
  if (!res.ok) return null
  const data = await res.json()
  return Buffer.from(data.content, 'base64').toString('utf8')
}

async function openIssue(repo, title, body) {
  if (process.env.DRY_RUN) { console.log(`[dry-run] Would open issue in ${repo}: ${title}`); return }
  const res = await ghFetch(`/repos/${repo}/issues`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title, body, labels: ['dx-drift'] }),
  })
  const data = await res.json()
  console.log(`Issue opened: ${data.html_url}`)
}

async function findOpenDriftIssue(repo) {
  const res = await ghFetch(`/repos/${repo}/issues?state=open&labels=dx-drift&per_page=5`)
  if (!res.ok) return null
  const issues = await res.json()
  return issues.find(i => i.title.startsWith('[dx-drift]')) || null
}

// ---------------------------------------------------------------------------
// GitHub Models API
// ---------------------------------------------------------------------------
async function callModel(prompt) {
  const res = await fetch('https://models.inference.ai.azure.com/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${TOKEN}`,
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
    throw new Error(`Models API error ${res.status}: ${err}`)
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
  if (onlyInA.length) lines.push(`  - seulement dans ${repoA}: \`${onlyInA.slice(0,3).join('`, `')}\``)
  if (onlyInB.length) lines.push(`  - seulement dans ${repoB}: \`${onlyInB.slice(0,3).join('`, `')}\``)
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

  // Pairwise diff (each repo vs the first repo with the file as reference)
  const diffs = {}  // repo → list of diff lines
  for (const repo of REPOS) diffs[repo] = []

  const refRepo = REPOS[0]
  for (const [, label] of Object.entries(DX_FILES)) {
    for (let i = 1; i < REPOS.length; i++) {
      const repo = REPOS[i]
      const line = diffSummary(label, snapshots[refRepo][label], snapshots[repo][label], refRepo, repo)
      if (line) diffs[repo].push(line)
    }
  }

  // Also check between REPOS[1] and REPOS[2]
  for (const [, label] of Object.entries(DX_FILES)) {
    const line = diffSummary(label, snapshots[REPOS[1]][label], snapshots[REPOS[2]][label], REPOS[1], REPOS[2])
    if (line) diffs[REPOS[2]].push(line)
  }

  // Deduplicate and filter repos with actual drift
  const driftedRepos = REPOS.filter(r => diffs[r].length > 0)

  if (!driftedRepos.length) {
    console.log('No DX drift detected. All repos are coherent.')
    return
  }

  console.log(`Drift detected in: ${driftedRepos.join(', ')}`)
  console.log('Calling GitHub Models for analysis…')

  const allDiffs = REPOS.map(r =>
    diffs[r].length ? `### ${r}\n${diffs[r].join('\n')}` : `### ${r}\n✅ no drift`
  ).join('\n\n')

  const analysis = await callModel(`
Tu analyses la cohérence DX (developer experience) entre 3 repos GitHub d'un même développeur.
Les repos sont : ${REPOS.join(', ')}.

Voici les différences détectées dans les fichiers DX (gitattributes, gitignore, devcontainer, agents/git.md, CI workflows) :

${allDiffs}

Pour chaque repo avec du drift :
1. Explique en 2-3 lignes pourquoi c'est problématique.
2. Donne les actions concrètes prioritaires pour aligner (sois concis, maximum 3 bullet points par repo).
3. Signale si une différence est intentionnelle et acceptable (ex: infra n'a pas de CI car pas de code).

Réponds en markdown, en français, de façon très concise.
`.trim())

  console.log('\n--- Analysis ---\n', analysis, '\n---\n')

  // Open one issue per drifted repo
  for (const repo of driftedRepos) {
    const existing = await findOpenDriftIssue(repo)
    if (existing) {
      console.log(`Issue already open in ${repo}: ${existing.html_url} — skipping`)
      continue
    }

    const body = `## DX drift détecté — rapport automatique

> Généré par le workflow \`dx-coherence\` dans [Gildraen/infra](https://github.com/Gildraen/infra).

### Différences identifiées

${diffs[repo].join('\n')}

---

### Analyse IA

${analysis}

---

*Fermer cette issue une fois les fichiers DX alignés. Le prochain run hebdomadaire vérifiera à nouveau.*`

    await openIssue(repo, '[dx-drift] Incohérence DX détectée', body)
  }
}

main().catch(e => { console.error(e); process.exit(1) })
