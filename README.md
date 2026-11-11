# Rubicon Labs · Kit de seguridad Node.js

Kit reutilizable para repositorios **Next.js, Astro y Node.js** que usen **npm, pnpm o Yarn**. Diseñado para GitHub Actions; auditado a nivel de **vulnerabilidades HIGH/CRITICAL**, sin corregir dependencias automáticamente.

Este repositorio contiene el kit, sin dependencias externas ni `package.json` propio. Su CI valida los scripts y ejecuta pruebas con proyectos temporales; las plantillas para auditar tus aplicaciones están en `examples/`.

## Qué hace

- Se ejecuta en cada **pull request**, en cada push a `main`/`master`, los **lunes** y manualmente.
- Comprueba que existe `package.json`, **un único lockfile**, que el gestor concuerda con él y que hay una declaración de versión de Node.
- Detecta versiones de Node fuera de soporte en pines numéricos `.nvmrc`, `.node-version`, `volta.node` y `engines.node` simples; consulta el **índice oficial de Node.js** para comprobar pines completos (`24.22.0`, por ejemplo) contra el último parche publicado de su rama.
- Señala imágenes Docker basadas en Node obsoleto y recuerda cuándo hace falta reconstruirlas.
- Audita dependencias **de producción y desarrollo**, incluidas transitivas para npm y Yarn moderno, con el nivel `high` o superior. **No ejecuta `npm install` ni scripts de dependencias**.
- Deja un resumen de resultados en la ejecución de GitHub Actions.
- Dependabot propone PR de actualizaciones del ecosistema npm y de GitHub Actions.

## Instalación (por repositorio)

1. Copia `examples/node-security.yml.example` a `.github/workflows/node-security.yml`, `examples/dependabot.yml.example` a `.github/dependabot.yml` y los dos scripts `scripts/*.mjs` a `scripts/` del proyecto que quieras auditar. Si ya tienes configuración de Dependabot, integra sus entradas sin sobrescribir las existentes.
2. En cada proyecto, crea o revisa `.nvmrc` con la **rama compatible** de Node (por ejemplo, `24`); alternativamente declara `"engines": { "node": "^24.0.0" }` en `package.json`. El número `24` es un **ejemplo**, no migres un proyecto que requiera Node 22 sin probarlo.
3. Confirma que el proyecto tiene un lockfile versionado (`package-lock.json`, `pnpm-lock.yaml` o `yarn.lock`). Para **pnpm y Yarn** declara `packageManager` con una versión concreta, por ejemplo `"packageManager": "pnpm@10.20.0"` (usa realmente la que tengas en tu proyecto).
4. Sube los archivos en una rama y abre PR. El trabajo `Node security audit` debe ejecutarse en **Actions**; si falla, inspecciona los mensajes `FAIL` y corrige los problemas reales, no desactives los controles.
5. En **Settings → Security & analysis**, habilita **Dependabot alerts** y, si está disponible, **Dependabot security updates**. Version updates las gestiona el YAML.
6. Comprueba de forma independiente el runtime **en el hosting real**. Consulta `SECURITY-CHECKLIST.md`.

### Si usas monorepo

La configuración de ejemplo audita **un único proyecto en la raíz**. En proyectos con `apps/web`, `apps/api`, etc., crea jobs separados que ejecuten los scripts con `working-directory: apps/web` (repite para cada paquete que tenga lockfile independiente), o adapta el flujo a tu workspace. En ese caso, deja los scripts accesibles desde cada ubicación con una ruta ajustada, como `node ../../scripts/security-check.mjs`. `Dependabot` también necesita `directory` o `directories` adecuados. **No interpretes un PASS en la raíz como una auditoría del monorepo completo**.

### Gestores soportados

| Gestor | Comando | Observación |
| --- | --- | --- |
| npm | `npm audit --audit-level=high` | Requiere lockfile válido. |
| pnpm | `corepack pnpm audit --audit-level high` | `packageManager` debe declarar pnpm. |
| Yarn 2+ | `corepack yarn npm audit --all --recursive --severity high` | Auditoría de workspaces y transitivas. |
| Yarn 1 | `corepack yarn audit --level high` | Puede fallar también por avisos menores debido a su código de salida. |

Si estás en Yarn 1, considera una migración planificada; no la hagas durante un parche urgente de Node sin pruebas.

## Opcional: revisión de nuevas dependencias en PR

`examples/dependency-review.yml.example` se puede copiar a `.github/workflows/dependency-review.yml`, **solo si GitHub Dependency Review está disponible en ese repositorio**. Según el tipo de repositorio/plan puede no estar habilitado. El flujo principal no depende de ello.

## Limitaciones importantes

- **No verifica la versión real de Node que ejecuta Vercel, Netlify o tu servidor.** CI y producción pueden diferir.
- Un `npm audit` limpio **no demuestra ausencia de vulnerabilidades**. Solo detecta avisos conocidos y disponibles en el registro.
- La inspección de Dockerfiles es estática y básica. Docker usa imágenes, que deben reconstruirse y desplegarse tras un parche.
- `engines.node` con rangos semver complejos genera aviso: hay que revisar límites de soporte y compatibilidad manualmente.
- La comprobación de último parche necesita internet para leer `https://nodejs.org/dist/index.json`; si falla, los pines completos se consideran no verificables y el trabajo falla.
- Las ramas Node soportadas en `scripts/security-check.mjs` (**22, 24, 26**) corresponden al **21 de octubre de 2026**. El conjunto debe actualizarse conforme al calendario oficial de mantenimiento.
- El análisis ejecuta Node 24 actualizado **solo para el escáner**. No es una garantía sobre el Node efectivo de tus despliegues ni reemplaza tus propios tests con la versión real de la app.

## Comprobación local

Ejecuta estos comandos **desde la raíz de la aplicación que quieras auditar**, después de copiar los scripts:

```bash
node scripts/security-check.mjs --offline
node scripts/dependency-audit.mjs
```

`--offline` salta la consulta de versiones (avisa, no certifica que el patch esté actualizado). Para una comprobación completa, ejecuta sin ese parámetro.

La auditoría de dependencias está orientada a Linux/macOS y GitHub Actions (Ubuntu); en Windows, ejecútala desde WSL.

### Validación del propio kit

Desde este repositorio, con Node 22 o superior y sin instalar paquetes:

```bash
node --check scripts/security-check.mjs
node --check scripts/dependency-audit.mjs
node --test
```

Las pruebas comprueban metadatos válidos e inválidos, lockfiles, declaraciones de Node, imágenes Docker, el modo offline, el resumen de Actions y las validaciones previas de la auditoría. No sustituyen una auditoría real contra los registros de paquetes.

## Fuentes oficiales

- [Aviso Node.js de octubre de 2026](https://nodejs.org/en/blog/vulnerability/october-2026-security-releases)
- [Calendario de soporte Node.js](https://github.com/nodejs/Release)
- [setup-node](https://github.com/actions/setup-node)
- [npm audit](https://docs.npmjs.com/cli/v11/commands/npm-audit/)
- [GitHub Dependabot](https://docs.github.com/en/code-security/how-tos/secure-your-supply-chain/secure-your-dependencies/configure-version-updates)
