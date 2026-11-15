# Magician Security Check · Checklist Node.js / Next.js / Astro

**Frecuencia:** al abrir PR, cada lunes (auditoría automática), y tras cualquier alerta oficial de seguridad.

## P0 · Parche de Node / incidencia de severidad alta

- [ ] Identificar todas las aplicaciones con Node **ejecutándose en producción** (SSR, APIs, colas, workers, agentes y webhooks).
- [ ] Confirmar la versión **real** de Node en cada entorno: local, CI, previews y **producción**. No confundir las cuatro.
- [ ] Comparar con el [último parche oficial de la rama](https://nodejs.org/en/download) y con el [calendario de soporte](https://github.com/nodejs/Release).
- [ ] Actualizar a la última versión **compatible de la rama soportada**; no saltar de Node 22 a 24/26 automáticamente.
- [ ] Si se usa Docker: actualizar la imagen base, reconstruir, publicar la imagen nueva y redeplegar el servicio.
- [ ] Si se usa Vercel/Netlify: revisar el runtime configurado y confirmar que el despliegue activo usa la versión corregida.
- [ ] Validar login/sesiones, permisos, endpoints, server actions, webhooks, base de datos y workers antes de cerrar la incidencia.
- [ ] En caso de vulnerabilidad explotable y exposición real, evaluar logs e indicadores de compromiso con el boletín técnico definitivo.

## P1 · Dependencias y pipeline

- [ ] `npm audit` / `pnpm audit` / `yarn npm audit` sin vulnerabilidades HIGH o CRITICAL sin investigar.
- [ ] Lockfile presente, commiteado y coherente con el gestor configurado.
- [ ] Dependabot alerts y security updates habilitados, versiones de Actions revisadas.
- [ ] Revisar PR de Dependabot con CI y pruebas; **no ejecutar `npm audit fix --force` a ciegas**.
- [ ] Actions con permisos mínimos y sin credenciales persistidas innecesariamente.
- [ ] Confirmar que el scanner cubre todos los paquetes en monorepos y los lockfiles secundarios.

## P1 · Configuración de despliegue

- [ ] Variables secretas solo en el gestor de secretos del hosting, nunca en Git.
- [ ] Variables `NODE_ENV`, secretos y URLs de servicios adecuados por entorno.
- [ ] Endpoints sensibles protegidos por autenticación y autorización del lado servidor.
- [ ] Webhooks autenticados, verificados e idempotentes.
- [ ] Logs sin credenciales, tokens ni datos personales innecesarios.
- [ ] CORS, cookies, cabeceras de seguridad y límites de petición revisados donde corresponda.
- [ ] Usuarios y claves de servicio con permisos mínimos; revisar accesos de tokens GitHub y del hosting.

## Matriz rápida de riesgo

| Tipo de proyecto | Riesgo de una vulnerabilidad en el runtime Node de producción | Qué verificar |
| --- | --- | --- |
| Next.js con SSR / route handlers | Potencialmente relevante | Runtime Node de funciones y servidor |
| Astro con adaptador SSR | Potencialmente relevante | Runtime del adaptador/servidor |
| API Node / agente / worker | Potencialmente relevante | Proceso en servidor o contenedor |
| Astro estático | Normalmente no expone Node al visitante | Node del build y dependencias; hosting de estáticos |
| Next.js exportado como estático | Normalmente no expone Node al visitante | Build y hosting, confirmar ausencia de SSR/API |

**Criterio de cierre:** versión de producción corregida y verificada + pruebas satisfactorias + evaluación de exposición cuando exista CVE con detalles. Un check verde de Actions por sí solo **no basta**.
