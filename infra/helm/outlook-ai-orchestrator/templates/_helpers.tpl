{{/* vim: set filetype=mustache: */}}

{{/* ------------------------------------------------------------------ */}}
{{/*  Names                                                              */}}
{{/* ------------------------------------------------------------------ */}}
{{- define "oao.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "oao.fullname" -}}
{{- if .Values.fullnameOverride -}}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- $name := default .Chart.Name .Values.nameOverride -}}
{{- if contains $name .Release.Name -}}
{{- .Release.Name | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}
{{- end -}}

{{- define "oao.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{/* ------------------------------------------------------------------ */}}
{{/*  Labels                                                             */}}
{{/* ------------------------------------------------------------------ */}}
{{- define "oao.labels" -}}
helm.sh/chart: {{ include "oao.chart" . }}
app.kubernetes.io/name: {{ include "oao.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
app.kubernetes.io/part-of: outlook-ai-orchestrator
{{- with .Values.commonLabels }}
{{ toYaml . }}
{{- end }}
{{- end -}}

{{/* oao.componentLabels <root> <component> */}}
{{- define "oao.componentLabels" -}}
{{- $root := index . 0 -}}
{{- $component := index . 1 -}}
{{ include "oao.labels" $root }}
app.kubernetes.io/component: {{ $component }}
{{- end -}}

{{- define "oao.selectorLabels" -}}
{{- $root := index . 0 -}}
{{- $component := index . 1 -}}
app.kubernetes.io/name: {{ include "oao.name" $root }}
app.kubernetes.io/instance: {{ $root.Release.Name }}
app.kubernetes.io/component: {{ $component }}
{{- end -}}

{{- define "oao.annotations" -}}
{{- with .Values.commonAnnotations }}
{{ toYaml . }}
{{- end }}
{{- end -}}

{{/* ------------------------------------------------------------------ */}}
{{/*  Images                                                             */}}
{{/* ------------------------------------------------------------------ */}}
{{/* oao.image <root> <component> <overrides dict> */}}
{{- define "oao.image" -}}
{{- $root := index . 0 -}}
{{- $component := index . 1 -}}
{{- $override := index . 2 -}}
{{- $registry := $root.Values.image.registry | default "" -}}
{{- $repo := $override.repository | default (printf "%s-%s" $root.Values.image.repositoryPrefix $component) -}}
{{- $tag := $override.tag | default $root.Values.image.tag | default $root.Chart.AppVersion -}}
{{- if $registry -}}
{{- printf "%s/%s:%s" $registry $repo $tag -}}
{{- else -}}
{{- printf "%s:%s" $repo $tag -}}
{{- end -}}
{{- end -}}

{{- define "oao.imagePullSecrets" -}}
{{- with .Values.image.pullSecrets }}
imagePullSecrets:
{{ toYaml . }}
{{- end }}
{{- end -}}

{{- define "oao.serviceAccountName" -}}
{{- if .Values.serviceAccount.create -}}
{{ include "oao.fullname" . }}
{{- else -}}
default
{{- end -}}
{{- end -}}

{{/* ------------------------------------------------------------------ */}}
{{/*  Derived configuration                                              */}}
{{/* ------------------------------------------------------------------ */}}
{{- define "oao.corsOrigins" -}}
{{- if .Values.config.corsOrigins -}}
{{- .Values.config.corsOrigins -}}
{{- else -}}
{{- printf "https://%s" .Values.hosts.addin -}}
{{- end -}}
{{- end -}}

{{- define "oao.postgres.fullname" -}}
{{- printf "%s-postgres" (include "oao.fullname" .) -}}
{{- end -}}

{{/*
  Connection string. Priority:
    1. postgres.enabled            -> in-cluster StatefulSet + secrets.postgresPassword
    2. secrets.databaseUrl         -> full URL provided by the operator
    3. postgres.external.host      -> built from the external.* parts + secrets.postgresPassword
  postgres.external.existingSecret bypasses all of this (see oao.externalDbSecretName).
*/}}
{{- define "oao.databaseUrl" -}}
{{- $pg := .Values.postgres -}}
{{- if $pg.enabled -}}
{{- if .Values.secrets.postgresPassword -}}
{{- printf "postgres://%s:%s@%s:5432/%s" $pg.auth.username .Values.secrets.postgresPassword (include "oao.postgres.fullname" .) $pg.auth.database -}}
{{- end -}}
{{- else if .Values.secrets.databaseUrl -}}
{{- .Values.secrets.databaseUrl -}}
{{- else if and $pg.external.host .Values.secrets.postgresPassword -}}
{{- printf "postgres://%s:%s@%s:%v/%s?sslmode=%s" $pg.external.username .Values.secrets.postgresPassword $pg.external.host $pg.external.port $pg.external.database $pg.external.sslmode -}}
{{- end -}}
{{- end -}}

{{/* Name of the Secret holding the orchestrator secrets. */}}
{{- define "oao.secretName" -}}
{{- if .Values.secrets.existingSecret -}}
{{- .Values.secrets.existingSecret -}}
{{- else -}}
{{- printf "%s-secrets" (include "oao.fullname" .) -}}
{{- end -}}
{{- end -}}

{{/* Secret data rendered by this chart (empty values are skipped). */}}
{{- define "oao.secretData" -}}
{{- $d := dict -}}
{{- with .Values.secrets.llmApiKey }}{{- $_ := set $d "LLM_API_KEY" . -}}{{- end -}}
{{- with .Values.secrets.aadClientSecret }}{{- $_ := set $d "AAD_CLIENT_SECRET" . -}}{{- end -}}
{{- with .Values.secrets.adminApiToken }}{{- $_ := set $d "ADMIN_API_TOKEN" . -}}{{- end -}}
{{- with .Values.secrets.metricsToken }}{{- $_ := set $d "METRICS_TOKEN" . -}}{{- end -}}
{{- with .Values.secrets.notifyWebhookUrl }}{{- $_ := set $d "NOTIFY_WEBHOOK_URL" . -}}{{- end -}}
{{- with .Values.secrets.adminEntraClientSecret }}{{- $_ := set $d "AUTH_MICROSOFT_ENTRA_ID_SECRET" . -}}{{- end -}}
{{- with .Values.secrets.adminAuthSecret }}{{- $_ := set $d "AUTH_SECRET" . -}}{{- end -}}
{{- if and .Values.postgres.enabled .Values.secrets.postgresPassword -}}
{{- $_ := set $d "POSTGRES_PASSWORD" .Values.secrets.postgresPassword -}}
{{- end -}}
{{- if not (include "oao.externalDbSecretName" .) -}}
{{- $url := include "oao.databaseUrl" . -}}
{{- if $url -}}{{- $_ := set $d "DATABASE_URL" $url -}}{{- end -}}
{{- end -}}
{{- $d | toYaml -}}
{{- end -}}

{{/*
  Secret keys the orchestrator/admin pods consume. JSON array so callers can
  `fromJsonArray` it. Only keys that really exist are listed, otherwise a
  *_FILE env var would point at a missing file and the app would fail closed.
*/}}
{{- define "oao.secretKeys" -}}
{{- if .Values.secrets.existingSecret -}}
{{- .Values.secrets.existingSecretKeys | toJson -}}
{{- else if .Values.externalSecrets.enabled -}}
{{- (keys .Values.externalSecrets.data | sortAlpha) | toJson -}}
{{- else -}}
{{- (include "oao.secretData" . | fromYaml | keys | sortAlpha) | toJson -}}
{{- end -}}
{{- end -}}

{{/* External database Secret (takes precedence over DATABASE_URL in the chart secret). */}}
{{- define "oao.externalDbSecretName" -}}
{{- if and (not .Values.postgres.enabled) .Values.postgres.external.existingSecret -}}
{{- .Values.postgres.external.existingSecret -}}
{{- end -}}
{{- end -}}

{{/* ------------------------------------------------------------------ */}}
{{/*  Orchestrator env                                                   */}}
{{/* ------------------------------------------------------------------ */}}
{{/*
  Non-secret env for the orchestrator (ConfigMap data). Also reused verbatim
  by the migration hook ConfigMap so the Job boots with the same config.
*/}}
{{- define "oao.config.data" -}}
NODE_ENV: {{ .Values.config.nodeEnv | quote }}
PORT: "8080"
HOST: "0.0.0.0"
APP_VERSION: {{ .Chart.AppVersion | quote }}
ORGANIZATION_NAME: {{ .Values.config.organizationName | quote }}
LOG_LEVEL: {{ .Values.config.logLevel | quote }}
LOG_FORMAT: {{ .Values.config.logFormat | quote }}
DEFAULT_LANGUAGE: {{ .Values.config.defaultLanguage | quote }}
INTERNAL_DOMAINS: {{ .Values.config.internalDomains | quote }}
CORS_ORIGINS: {{ include "oao.corsOrigins" . | quote }}
RATE_LIMIT_PER_MINUTE: {{ .Values.config.rateLimitPerMinute | quote }}
BODY_LIMIT_BYTES: {{ .Values.config.bodyLimitBytes | quote }}
REQUEST_TIMEOUT_MS: {{ .Values.config.requestTimeoutMs | quote }}
SHUTDOWN_TIMEOUT_MS: {{ .Values.config.shutdownTimeoutMs | quote }}
AUDIT_STORE_CONTENT: {{ .Values.config.auditStoreContent | quote }}
AUDIT_RETENTION_DAYS: {{ .Values.config.auditRetentionDays | quote }}
INDEX_RETENTION_DAYS: {{ .Values.config.indexRetentionDays | quote }}
METRICS_ENABLED: {{ .Values.config.metricsEnabled | quote }}
API_DOCS_ENABLED: {{ .Values.config.apiDocsEnabled | quote }}
LLM_PROVIDER: {{ .Values.llm.provider | quote }}
LLM_BASE_URL: {{ .Values.llm.baseUrl | quote }}
LLM_MODEL: {{ .Values.llm.model | quote }}
{{- with .Values.llm.fastModel }}
LLM_FAST_MODEL: {{ . | quote }}
{{- end }}
LLM_TIMEOUT_MS: {{ .Values.llm.timeoutMs | quote }}
LLM_MAX_TOKENS: {{ .Values.llm.maxTokens | quote }}
LLM_JSON_MODE: {{ .Values.llm.jsonMode | quote }}
LLM_CONCURRENCY: {{ .Values.llm.concurrency | quote }}
LLM_CIRCUIT_FAILURES: {{ .Values.llm.circuitFailures | quote }}
LLM_CIRCUIT_COOLDOWN_MS: {{ .Values.llm.circuitCooldownMs | quote }}
LLM_INPUT_MAX_CHARS: {{ .Values.llm.inputMaxChars | quote }}
LLM_QUEUE_TIMEOUT_MS: {{ .Values.llm.queueTimeoutMs | quote }}
EMBEDDINGS_ENABLED: {{ .Values.llm.embeddings.enabled | quote }}
EMBEDDING_MODEL: {{ .Values.llm.embeddings.model | quote }}
EMBEDDING_DIMENSIONS: {{ .Values.llm.embeddings.dimensions | quote }}
EMBEDDING_BATCH_SIZE: {{ .Values.llm.embeddings.batchSize | quote }}
AUTH_MODE: {{ .Values.auth.mode | quote }}
AAD_TENANT_ID: {{ .Values.auth.aad.tenantId | quote }}
AAD_CLIENT_ID: {{ .Values.auth.aad.clientId | quote }}
AAD_ALLOWED_TENANTS: {{ .Values.auth.aad.allowedTenants | quote }}
AAD_REQUIRE_SCOPE: {{ .Values.auth.aad.requireScope | quote }}
AAD_CLOCK_SKEW_SECONDS: {{ .Values.auth.aad.clockSkewSeconds | quote }}
ADMIN_EMAILS: {{ .Values.auth.adminEmails | quote }}
COMPLIANCE_EMAILS: {{ .Values.auth.complianceEmails | quote }}
GRAPH_ENABLED: {{ .Values.graph.enabled | quote }}
GRAPH_AUTH_MODE: {{ .Values.graph.authMode | quote }}
SYNC_GROUP_ID: {{ .Values.graph.sync.groupId | quote }}
SYNC_USERS: {{ .Values.graph.sync.users | quote }}
SYNC_INTERVAL_MINUTES: {{ .Values.graph.sync.intervalMinutes | quote }}
SYNC_MAX_MESSAGES_PER_RUN: {{ .Values.graph.sync.maxMessagesPerRun | quote }}
PRECOMPUTE_ENABLED: {{ .Values.features.precompute | quote }}
DAILY_BRIEF_ENABLED: {{ .Values.features.dailyBrief | quote }}
DAILY_BRIEF_HOUR: {{ .Values.features.dailyBriefHour | quote }}
TRIAGE_ENABLED: {{ .Values.features.triage | quote }}
ANALYSIS_CACHE_ENABLED: {{ .Values.features.analysisCache | quote }}
ANALYSIS_CACHE_TTL_HOURS: {{ .Values.features.analysisCacheTtlHours | quote }}
DEMO_SEED: {{ .Values.features.demoSeed | quote }}
DB_AUTO_MIGRATE: {{ .Values.migration.autoAtBoot | quote }}
{{- if not .Values.postgres.enabled }}
{{- with .Values.postgres.external.host }}
PGSSLMODE: {{ $.Values.postgres.external.sslmode | quote }}
{{- end }}
{{- end }}
{{- range $k, $v := .Values.config.extraEnv }}
{{ $k }}: {{ $v | quote }}
{{- end }}
{{- end -}}

{{/*
  Secret-bearing env for the orchestrator and the migration Job.
  secrets.mountAsFiles=true -> <KEY>_FILE pointing at the mounted file.
  secrets.mountAsFiles=false -> plain secretKeyRef.
*/}}
{{- define "oao.secretEnv" -}}
{{- $adminOnly := list "AUTH_SECRET" "AUTH_MICROSOFT_ENTRA_ID_SECRET" -}}
{{- $keys := include "oao.secretKeys" . | fromJsonArray -}}
{{- $secret := include "oao.secretName" . -}}
{{- $extDb := include "oao.externalDbSecretName" . -}}
{{- range $keys }}
{{- if and (not (has . $adminOnly)) (or (ne . "DATABASE_URL") (not $extDb)) }}
{{- if $.Values.secrets.mountAsFiles }}
- name: {{ . }}_FILE
  value: {{ printf "%s/%s" (trimSuffix "/" $.Values.secrets.mountPath) . | quote }}
{{- else }}
- name: {{ . }}
  valueFrom:
    secretKeyRef:
      name: {{ $secret }}
      key: {{ . }}
{{- end }}
{{- end }}
{{- end }}
{{- if $extDb }}
- name: DATABASE_URL
  valueFrom:
    secretKeyRef:
      name: {{ $extDb }}
      key: {{ $.Values.postgres.external.existingSecretKey }}
{{- end }}
{{- end -}}

{{/* Volumes/volumeMounts carrying the secret files. */}}
{{- define "oao.secretVolume" -}}
{{- if .Values.secrets.mountAsFiles }}
- name: secrets
  secret:
    secretName: {{ include "oao.secretName" . }}
    defaultMode: 0400
    items:
{{- $skip := list "AUTH_SECRET" "AUTH_MICROSOFT_ENTRA_ID_SECRET" }}
{{- if include "oao.externalDbSecretName" . }}
{{- $skip = append $skip "DATABASE_URL" }}
{{- end }}
{{- range (include "oao.secretKeys" . | fromJsonArray) }}
{{- if not (has . $skip) }}
      - key: {{ . }}
        path: {{ . }}
{{- end }}
{{- end }}
{{- end }}
{{- end -}}

{{- define "oao.secretVolumeMount" -}}
{{- if .Values.secrets.mountAsFiles }}
- name: secrets
  mountPath: {{ .Values.secrets.mountPath | quote }}
  readOnly: true
{{- end }}
{{- end -}}

{{/* Checksum annotations so a config/secret change rolls the pods. */}}
{{- define "oao.checksums" -}}
checksum/config: {{ include "oao.config.data" . | sha256sum }}
{{- if not (or .Values.secrets.existingSecret .Values.externalSecrets.enabled) }}
checksum/secrets: {{ include "oao.secretData" . | sha256sum }}
{{- end }}
{{- end -}}

{{/* ------------------------------------------------------------------ */}}
{{/*  Scheduling helpers                                                 */}}
{{/* ------------------------------------------------------------------ */}}
{{/* oao.antiAffinity <root> <component> <mode> */}}
{{- define "oao.antiAffinity" -}}
{{- $root := index . 0 -}}
{{- $component := index . 1 -}}
{{- $mode := index . 2 -}}
{{- if eq $mode "hard" }}
podAntiAffinity:
  requiredDuringSchedulingIgnoredDuringExecution:
    - topologyKey: kubernetes.io/hostname
      labelSelector:
        matchLabels:
{{ include "oao.selectorLabels" (list $root $component) | indent 10 }}
{{- else if eq $mode "soft" }}
podAntiAffinity:
  preferredDuringSchedulingIgnoredDuringExecution:
    - weight: 100
      podAffinityTerm:
        topologyKey: kubernetes.io/hostname
        labelSelector:
          matchLabels:
{{ include "oao.selectorLabels" (list $root $component) | indent 12 }}
{{- end }}
{{- end -}}

{{/* TLS secret names. */}}
{{- define "oao.tls.apiSecretName" -}}
{{- .Values.ingress.tls.apiSecretName | default (printf "%s-api-tls" (include "oao.fullname" .)) -}}
{{- end -}}

{{- define "oao.tls.adminSecretName" -}}
{{- .Values.ingress.tls.adminSecretName | default (printf "%s-admin-tls" (include "oao.fullname" .)) -}}
{{- end -}}

{{- define "oao.tls.addinSecretName" -}}
{{- .Values.addin.tls.secretName | default (printf "%s-addin-tls" (include "oao.fullname" .)) -}}
{{- end -}}
