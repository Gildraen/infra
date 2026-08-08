---
name: git-workflow
description: Regles Git et workflow de contribution pour infra.
trigger: always
paths:
  - "**"
---

# Git workflow

## Regles

- Travailler sur une branche dediee, jamais directement sur `main`.
- Ne jamais commit ni push sans approbation explicite de l'utilisateur.
- Messages de commit conventionnels (`<type>: <description courte>`).
- Ouvrir une PR vers `main` avant merge.
