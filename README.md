# Rubicon Labs · Automatización de seguridad y dependencias

Kit para **detectar stacks, auditar vulnerabilidades y mantener dependencias mediante PR de Dependabot**, con autofusión de patch/minor cuando GitHub exige que pasen los checks de seguridad y de la aplicación.

Los scripts no tienen dependencias npm. Este repositorio contiene el kit y sus pruebas; las plantillas que se instalan en cada aplicación están en `examples/`.

## Qué hace

- Descubre manifiestos y lockfiles recursivamente, incluidos proyectos independientes y workspaces, sin recorrer dependencias instaladas, salidas de compilación ni enlaces simbólicos.
- Identifica Next.js, Astro, React, Vue, Nuxt, Angular, Svelte/SvelteKit, Express, Fastify, NestJS, Hono, Vite, TypeScript, Prisma y Drizzle, entre otros. Las etiquetas son informativas: **se auditan todos los paquetes del lockfile**, no solo los frameworks reconocidos.
- Detecta también Python, PHP/Composer, Go, Rust, Ruby, Maven, Gradle, Docker y GitHub Actions. Reconoce etiquetas de Django, Flask, FastAPI, Laravel y Symfony.
- Consulta el calendario oficial de Node y su índice de versiones; comprueba declaraciones heredadas dentro del repositorio, ramas fuera de soporte, pines obsoletos o inexistentes y Dockerfiles con Node antiguo.
- Audita cada raíz Node con npm/pnpm/Yarn a nivel **HIGH/CRITICAL**, incluyendo desarrollo, producción y dependencias transitivas. No instala las dependencias de la aplicación ni ejecuta sus lifecycle scripts.
- Añade un análisis completo con **OSV-Scanner** de los manifiestos/lockfiles compatibles de otros ecosistemas. OSV falla ante cualquier vulnerabilidad conocida que encuentre, incluso de severidad inferior a HIGH.
- Genera Dependabot para los ecosistemas/directorios detectados: comprobación **diaria** de versiones, PR con manifiestos y lockfiles actualizados, grupos de patch/minor y PR separadas para majors.
- Solo solicita autofusión de PR verificadas de Dependabot con cambios patch/minor en archivos de dependencias permitidos. GitHub espera a que se satisfagan los checks obligatorios y las revisiones configuradas.

## Instalación en una aplicación o monorepo

1. Copia **todos** los archivos `scripts/*.mjs` a `scripts/` del repositorio destino, conservando sus nombres.
2. Copia `examples/node-security.yml.example` a `.github/workflows/node-security.yml`.
3. Declara la versión de Node de tus aplicaciones mediante `.nvmrc`, `.node-version`, Volta o `engines.node`. El runtime del escáner no sustituye esa declaración. Cada proyecto independiente debe tener su lockfile; pnpm/Yarn necesitan `packageManager` con versión concreta, como `pnpm@10.20.0`.
4. Desde la raíz del repositorio destino, revisa el inventario y genera Dependabot:

   ```bash
   node scripts/project-inventory.mjs
   node scripts/project-inventory.mjs --write-dependabot
   ```

   `--write-dependabot` se niega a sobrescribir `.github/dependabot.yml`. Si ya existe, genera un candidato y **combina las entradas** conservando registros privados, exclusiones y configuración propia:

   ```bash
   node scripts/project-inventory.mjs --dependabot > dependabot.generated.yml
   ```

   `examples/dependabot.yml.example` sigue disponible como ejemplo mínimo para un proyecto Node en la raíz.
5. Activa **Dependabot alerts** y **Dependabot security updates** en GitHub. Las actualizaciones de versiones las configura el YAML; las correcciones de vulnerabilidades conocidas necesitan también security updates.
6. Abre una PR de instalación y comprueba el job **Rubicon security**, además de tus tests, lint y build habituales.

El inventario se vuelve a calcular en cada ejecución. Al añadir un ecosistema o una raíz independiente nueva, vuelve a generar/comparar Dependabot para que sus actualizaciones incluyan esa ubicación. El kit no modifica silenciosamente una configuración existente ni se instala en otros repositorios de tu cuenta.

### Monorepos y cobertura

- npm/Yarn: interpreta `workspaces` como lista o `workspaces.packages`.
- pnpm: interpreta una lista YAML sencilla `packages:` en `pnpm-workspace.yaml`, con patrones y exclusiones. Ante sintaxis que no puede interpretar, no supone cobertura: muestra el paquete como no verificado.
- Ejecuta las auditorías por cada directorio con lockfile Node propio; un fallo no impide revisar las demás raíces. Las declaraciones `.nvmrc`/`.node-version` se heredan hasta la raíz del repositorio.
- Un manifiesto Node sin lockfile propio ni pertenencia verificable a un workspace hace fallar el análisis. Los proyectos de otros ecosistemas que necesiten un lockfile/artefacto auditable también se señalan si no lo tienen.
- Se omiten directorios como `node_modules`, `vendor`, `.venv`, `.git`, `dist`, `build`, `target` y salidas habituales de frameworks. Si guardas código fuente en uno de esos directorios, adapta esa lista antes de usar el kit.

## Autofusión de patch/minor

1. Copia `examples/dependabot-automerge.yml.example` a `.github/workflows/dependabot-automerge.yml`.
2. Habilita **Allow auto-merge** y el método **Squash** en el repositorio.
3. Protege la rama predeterminada con checks obligatorios de seguridad **y de tu aplicación**. Configura, por ejemplo, `Rubicon security` y el nombre real de tu job de tests/build. Para exigir también la prueba contra la base actual, activa la opción de mantener la rama actualizada antes de fusionar.
4. Crea la variable de repositorio **`RUBICON_REQUIRED_CHECKS`** con esos mismos nombres:

   ```json
   ["Rubicon security", "Application tests"]
   ```

El kit comprueba mediante API que GitHub **exige todos esos checks**; escribir los nombres en la variable no basta. Se necesitan al menos dos nombres distintos. Sin configuración verificable, sin soporte de protección en el plan, ante fallos de API o si cambia el SHA de la PR, no habilita autofusión.

El workflow `pull_request_target` solo obtiene código del **commit base** y usa metadatos de Dependabot con verificación de firmas. Nunca obtiene ni ejecuta código de la PR con el token de escritura. La solicitud usa `--auto --match-head-commit`, sin bypass administrativo.

**Quedan para revisión:** majors, metadatos ambiguos, forks, cambios de código, de Actions, Dockerfiles y declaraciones de runtime. Una actualización minor puede ser incompatible, especialmente en paquetes `0.x`; tus checks deben cubrir el comportamiento real de la aplicación. Una política que exige revisión humana seguirá esperando esa revisión.

Para desactivar futuras solicitudes, deshabilita el workflow. Desactiva también las PR ya encoladas con `gh pr merge NUMERO --disable-auto`.

## Ejecución local

Desde la raíz del repositorio destino, con Node 22 o superior:

```bash
node scripts/project-inventory.mjs --json
node scripts/audit-projects.mjs
```

Para revisar solo las declaraciones de un proyecto:

```bash
node scripts/security-check.mjs --offline
node scripts/dependency-audit.mjs
```

`--offline` solo evita las consultas del runtime; usa un snapshot de soporte de octubre de 2026, avisa y no certifica el parche actual. Las auditorías de paquetes siguen necesitando red. npm/pnpm/Yarn están orientados a Linux/macOS y al runner Ubuntu; en Windows, usa WSL para esas auditorías. pnpm/Yarn requieren Corepack disponible.

## Límites

- El kit comprueba archivos y avisos conocidos; un análisis limpio no demuestra ausencia de vulnerabilidades ni certifica la versión de Node desplegada en Vercel, Netlify o tus servidores. Consulta `SECURITY-CHECKLIST.md`.
- Dependabot busca versiones publicadas y genera las correcciones; si no existe parche, el análisis seguirá fallando. No se ejecuta `audit fix --force` ni se saltan los checks para cerrar una alerta.
- Las vulnerabilidades transitivas dependen de la cobertura del gestor, del lockfile y de los avisos disponibles. Requisitos Python sin versiones fijadas y artefactos que OSV no soporte requieren resolución/revisión adicional.
- La resolución de `pom.xml` en OSV no incluye actualmente dependencias de test; añade el control específico de tu pipeline Maven si necesitas esa cobertura.
- Las etiquetas de stack no determinan compatibilidad entre versiones. Las majors y las migraciones necesitan revisión.
- Docker se detecta para actualizaciones e inspección básica de Node; esta plantilla no audita paquetes del sistema operativo dentro de las imágenes.
- Registros privados necesitan configuración/credenciales de Dependabot y del gestor correspondiente. El generador no elimina ni configura esos secretos.
- El acceso a protección de ramas en repositorios privados depende del plan de GitHub; la política de autofusión falla de forma cerrada si no está disponible.

## Desarrollo y validación del kit

```bash
node --test
```

CI prueba Node 22/24/26, inventario mixto, workspaces, enlaces, gestores, soporte de Node y casos negativos de autofusión. También contrasta una dependencia de desarrollo vulnerable aislada contra el registro npm y OSV, sin instalarla ni ejecutar lifecycle scripts. Las plantillas se validan con actionlint antes de publicarse.

Contrato de comportamiento: [`docs/automation-spec.md`](docs/automation-spec.md).

## Fuentes oficiales

- [Calendario de soporte de Node.js](https://github.com/nodejs/Release)
- [npm audit](https://docs.npmjs.com/cli/v11/commands/npm-audit/)
- [OSV-Scanner y su integración con Actions](https://google.github.io/osv-scanner/github-action/)
- [Opciones de Dependabot](https://docs.github.com/en/code-security/reference/supply-chain-security/dependabot-options-reference)
- [Actualizaciones de seguridad de Dependabot](https://docs.github.com/en/code-security/concepts/supply-chain-security/dependabot-security-updates)
- [Automatizar Dependabot con checks obligatorios](https://docs.github.com/en/code-security/tutorials/secure-your-dependencies/automate-dependabot-with-actions)
