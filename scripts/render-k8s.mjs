#!/usr/bin/env node
/**
 * `pnpm k8s:render` — render the Helm chart into plain manifests under
 * infra/k8s/rendered/, for environments that only apply YAML (no Helm, no
 * Flux). The Helm chart stays the single source of truth: this output is a
 * generated artefact and must never be hand-edited.
 *
 *   pnpm k8s:render                       # NKP values, namespace oao
 *   pnpm k8s:render --env dev             # infra/gitops/envs/dev/values.yaml
 *   pnpm k8s:render --values my.yaml --namespace oao-test
 *
 * Requires the `helm` binary (>= 3.12). Secrets are NOT rendered: the
 * generated manifests reference an existing Secret (secrets.create=false),
 * so nothing sensitive can ever land in the repository.
 */
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";

import {
  die,
  has,
  helpIfRequested,
  info,
  ok,
  parseArgs,
  repoRoot,
  capture,
  step,
  warn,
} from "./lib/common.mjs";

const { flags } = parseArgs(process.argv.slice(2), { booleans: ["help", "h", "clean"] });

helpIfRequested(
  flags,
  `
Usage: pnpm k8s:render [options]

Options:
  --env <dev|prod>     also apply infra/gitops/envs/<env>/values.yaml
  --values <path>      extra values file (repeatable via comma separated list)
  --namespace <ns>     target namespace (default oao, or oao-dev for --env dev)
  --release <name>     Helm release name (default oao)
  --out <dir>          output directory (default infra/k8s/rendered)
  --clean              delete the output directory first
  -h, --help           show this help
`,
);

if (!has("helm")) {
  die(
    "helm not found.\n" +
      "     Install it from https://helm.sh/docs/intro/install/ (or your package manager)\n" +
      "     — it is only needed to regenerate infra/k8s/rendered/.",
  );
}

const chartDir = join(repoRoot, "infra", "helm", "outlook-ai-orchestrator");
const envName = flags.env ? String(flags.env) : "";
const release = String(flags.release ?? "oao");
const namespace = String(flags.namespace ?? (envName === "dev" ? "oao-dev" : "oao"));
const outDir = flags.out ? String(flags.out) : join(repoRoot, "infra", "k8s", "rendered");

const valuesFiles = [join(chartDir, "values-nkp.yaml")];
if (envName) {
  const envValues = join(repoRoot, "infra", "gitops", "envs", envName, "values.yaml");
  if (!existsSync(envValues)) die(`no values file for env "${envName}" (${envValues})`);
  valuesFiles.push(envValues);
}
for (const extra of String(flags.values ?? "").split(",").filter(Boolean)) {
  valuesFiles.push(extra);
}

// `helm template --output-dir` APPENDS to a file that already exists, so a
// second run without cleaning would duplicate every manifest. The chart's own
// output directory is therefore always wiped; `--clean` additionally removes
// anything else that may have accumulated under outDir (e.g. a stale README or
// a previous chart name).
if (flags.clean && existsSync(outDir)) {
  rmSync(outDir, { recursive: true, force: true });
}
const chartOutDir = join(outDir, "outlook-ai-orchestrator");
if (existsSync(chartOutDir)) {
  rmSync(chartOutDir, { recursive: true, force: true });
}
mkdirSync(outDir, { recursive: true });

step(`helm template ${release} (namespace ${namespace})`);
for (const file of valuesFiles) info(`values: ${relative(repoRoot, file)}`);

const args = [
  "template", release, chartDir,
  "--namespace", namespace,
  ...valuesFiles.flatMap((f) => ["-f", f]),
  // No secret material in generated files: the manifests expect an existing
  // Secret named `oao-secrets` (create it with kubectl / SOPS / ESO).
  "--set", "secrets.create=false",
  "--set", "secrets.existingSecret=oao-secrets",
  "--output-dir", outDir,
];

const rendered = capture("helm", args);
if (!rendered) {
  // capture() returns "" on failure; re-run without capture to surface stderr.
  die('helm template failed — run it manually to see the error:\n     helm template oao infra/helm/outlook-ai-orchestrator -f infra/helm/outlook-ai-orchestrator/values-nkp.yaml');
}

// helm --output-dir nests under <outDir>/<chart name>/templates/*.yaml
const chartOut = join(outDir, "outlook-ai-orchestrator", "templates");
const files = existsSync(chartOut) ? readdirSync(chartOut) : [];
if (files.length === 0) warn(`no manifest written under ${chartOut}`);

writeFileSync(
  join(outDir, "README.md"),
  `# Manifests générés — NE PAS ÉDITER

Sortie de \`helm template\` pour le chart
\`infra/helm/outlook-ai-orchestrator\` (source unique de vérité).

- Régénérer : \`pnpm k8s:render\` (options : \`--env dev|prod\`, \`--namespace\`)
- Namespace : \`${namespace}\` · release : \`${release}\`
- Values appliquées : ${valuesFiles.map((f) => `\`${relative(repoRoot, f)}\``).join(", ")}
- Secrets : **non rendus**. Ces manifests attendent un Secret existant
  nommé \`oao-secrets\` (voir \`infra/gitops/envs/*/secrets.example.yaml\`).

Application :

\`\`\`bash
kubectl create namespace ${namespace}
kubectl -n ${namespace} apply -f <votre secret oao-secrets>
kubectl -n ${namespace} apply -R -f infra/k8s/rendered/outlook-ai-orchestrator/templates
\`\`\`

Le Job de migration est un hook Helm : sans Helm, l'appliquer explicitement
avant le reste (\`job-migrate.yaml\`), ou utiliser \`DB_AUTO_MIGRATE=true\`.
`,
);

ok(`${files.length} manifest(s) written to ${relative(repoRoot, chartOut)}`);
info("Commit the result: it is the Helm-free deployment path (see infra/k8s/README.md).");
