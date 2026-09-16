{{/* Reusable egress rule blocks ------------------------------------------ */}}
{{- define "oao.netpol.dns" -}}
{{- if .Values.networkPolicy.dns.enabled }}
- to:
    - namespaceSelector:
        matchLabels:
{{ toYaml .Values.networkPolicy.dns.namespaceSelector | indent 10 }}
  ports:
    - port: 53
      protocol: UDP
    - port: 53
      protocol: TCP
{{- end }}
{{- end -}}
{{- define "oao.netpol.database" -}}
{{- if .Values.postgres.enabled }}
- to:
    - podSelector:
        matchLabels:
{{ include "oao.selectorLabels" (list . "postgres") | indent 10 }}
  ports:
    - port: 5432
      protocol: TCP
{{- else }}
{{- range .Values.postgres.external.cidrs }}
- to:
    - ipBlock:
        cidr: {{ . }}
  ports:
    - port: {{ $.Values.postgres.external.port }}
      protocol: TCP
{{- end }}
{{- end }}
{{- end -}}
{{- define "oao.netpol.llm" -}}
{{- $ports := .Values.llm.egress.ports -}}
{{- range .Values.llm.egress.cidrs }}
- to:
    - ipBlock:
        cidr: {{ . }}
  ports:
{{- range $ports }}
    - port: {{ . }}
      protocol: TCP
{{- end }}
{{- end }}
{{- end -}}
{{- define "oao.netpol.microsoft" -}}
{{/*
  Entra ID (login.microsoftonline.com) + Microsoft Graph (graph.microsoft.com).
  NetworkPolicy cannot match FQDNs: either give explicit CIDRs, or allow
  443/tcp to the public internet while keeping every private range blocked.
  On a Cilium-based NKP cluster prefer a CiliumNetworkPolicy with toFQDNs
  (see docs/SECURITY.md).
*/}}
{{- if .Values.networkPolicy.microsoft.enabled }}
- to:
{{- if .Values.networkPolicy.microsoft.cidrs }}
{{- range .Values.networkPolicy.microsoft.cidrs }}
    - ipBlock:
        cidr: {{ . }}
{{- end }}
{{- else }}
    - ipBlock:
        cidr: 0.0.0.0/0
        {{- if .Values.networkPolicy.microsoft.exceptPrivateRanges }}
        except:
          - 10.0.0.0/8
          - 172.16.0.0/12
          - 192.168.0.0/16
          - 169.254.0.0/16
          - 100.64.0.0/10
        {{- end }}
{{- end }}
  ports:
{{- range .Values.networkPolicy.microsoft.ports }}
    - port: {{ . }}
      protocol: TCP
{{- end }}
{{- end }}
{{- end -}}
