# Alternative à SOPS : External Secrets Operator (ESO)

Si Northbridge dispose déjà d'un coffre (Vault, Nutanix/AWS Secrets Manager,
Azure Key Vault), aucun secret — même chiffré — n'a besoin d'être versionné :
le chart rend un `ExternalSecret` et l'opérateur matérialise
`oao-secrets` dans le namespace.

```yaml
# overlay d'environnement (envs/prod/values.yaml)
secrets:
  create: false
externalSecrets:
  enabled: true
  secretStoreRef:
    name: nkp-vault
    kind: ClusterSecretStore
  data:
    LLM_API_KEY:        { key: oao/llm,      property: api_key }
    AAD_CLIENT_SECRET:  { key: oao/entra,    property: client_secret }
    ADMIN_API_TOKEN:    { key: oao/admin,    property: api_token }
    METRICS_TOKEN:      { key: oao/metrics,  property: token }
    DATABASE_URL:       { key: oao/postgres, property: url }
```

⚠ **Première installation** : le hook `pre-install` de migration s'exécute
avant que l'`ExternalSecret` ne soit appliqué, donc avant que `oao-secrets`
n'existe. Deux options :

1. Pré-créer l'`ExternalSecret` (ou le Secret) avant le premier
   `HelmRelease`, puis installer normalement ;
2. Pour la première installation seulement :
   `migration.enabled=false` + `migration.autoAtBoot=true`
   (l'orchestrator applique les migrations à son démarrage), puis revenir au
   Job de migration pour les upgrades suivants.

Le `ClusterSecretStore` lui-même est une ressource d'infrastructure, hors
périmètre de ce chart :

```yaml
apiVersion: external-secrets.io/v1beta1
kind: ClusterSecretStore
metadata:
  name: nkp-vault
spec:
  provider:
    vault:
      server: https://vault.northbridge.example
      path: kv
      version: v2
      auth:
        kubernetes:
          mountPath: kubernetes
          role: oao
          serviceAccountRef:
            name: oao
            namespace: oao
```

Dans ce cas, `serviceAccount.automountServiceAccountToken` peut rester à
`false` : c'est l'opérateur ESO, et non les pods, qui s'authentifie auprès du
coffre.
