{{/* Annotations shared by the three Ingress objects. */}}
{{- define "oao.ingress.baseAnnotations" -}}
{{- $isNginx := contains "nginx" .Values.ingress.className -}}
{{- if $isNginx }}
nginx.ingress.kubernetes.io/ssl-redirect: "true"
nginx.ingress.kubernetes.io/force-ssl-redirect: "true"
nginx.ingress.kubernetes.io/proxy-body-size: {{ .Values.ingress.proxyBodySize | quote }}
nginx.ingress.kubernetes.io/proxy-read-timeout: {{ .Values.ingress.timeouts.read | quote }}
nginx.ingress.kubernetes.io/proxy-send-timeout: {{ .Values.ingress.timeouts.send | quote }}
nginx.ingress.kubernetes.io/proxy-connect-timeout: {{ .Values.ingress.timeouts.connect | quote }}
{{- end }}
{{- if contains "traefik" .Values.ingress.className }}
traefik.ingress.kubernetes.io/router.entrypoints: websecure
traefik.ingress.kubernetes.io/router.tls: "true"
{{- end }}
{{- with .Values.ingress.annotations }}
{{ toYaml . }}
{{- end }}
{{- end -}}
