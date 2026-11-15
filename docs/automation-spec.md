# Magician Security Check · Contrato de automatización

## Resultado

Detectar proyectos y stacks dentro de un repositorio, auditar dependencias resueltas y generar una configuración de Dependabot para comprobar versiones diariamente. Dependabot actualiza manifiestos y lockfiles mediante PR; patch/minor pueden fusionarse automáticamente tras los checks obligatorios.

## Límites y autoridad

- El inventario lee archivos, sin importar configuraciones ejecutables ni seguir enlaces simbólicos. Omite dependencias instaladas, VCS y salidas de compilación.
- Cada lockfile Node independiente es una unidad de auditoría. Los manifiestos sin lockfile se identifican por separado; un inventario no certifica su cobertura ni la pertenencia a un workspace.
- npm/pnpm/Yarn auditan paquetes de desarrollo y producción. OSV añade auditoría recursiva de los manifiestos/lockfiles que soporte, sin instalar la aplicación.
- Dependabot y los registros son la autoridad sobre versiones disponibles; las etiquetas de stack son informativas, no una lista limitada de paquetes auditados.
- El kit no se instala en otros repositorios ni verifica el runtime desplegado.

## Autofusión

- Solo PR abiertas, no borrador, del bot auténtico `dependabot[bot]`, desde una rama del mismo repositorio hacia su rama predeterminada.
- Metadatos verificados por `dependabot/fetch-metadata`; el cambio máximo debe ser patch/minor.
- Solo archivos de dependencias permitidos. Código fuente, Actions, Dockerfiles y cambios de runtime quedan para revisión.
- `RUBICON_REQUIRED_CHECKS` debe declarar al menos dos checks distintos (seguridad y pruebas de la aplicación). Todos deben estar exigidos por una protección de rama o ruleset activo de GitHub.
- El workflow privilegiado solo obtiene código del commit base; jamás obtiene/ejecuta código de la PR. El SHA actual debe coincidir con el evento y con `--match-head-commit`.
- Se solicita `--auto` sin bypass administrativo; GitHub decide cuándo se satisfacen los checks/revisiones. Sin protección verificable, con fallo de API o con metadatos incompletos, no se habilita autofusión.
- Repetir eventos es inocuo: se vuelve a evaluar la PR actual y se habilita la misma autofusión; no se crean ramas ni PR duplicadas.

## Aceptación y verificación

1. Un monorepo mixto produce inventario determinista con stacks, gestores, manifiestos y lockfiles; no incluye node_modules ni enlaces externos.
2. Generar Dependabot incluye todos los directorios/ecosistemas detectados y Actions; no sobrescribe configuración existente.
3. Las auditorías continúan con las demás raíces aunque una falle y el resultado global falla si alguna falló. Un manifiesto Node sin cobertura de lockfile no se presenta como auditado.
4. Falta de declaraciones concretas del gestor, discrepancias con el lockfile, pines de Node inexistentes y dependencias dev no quedan ocultos.
5. Las pruebas de política rechazan majors, forks, humanos, archivos no permitidos, cambios de SHA, ausencia de checks y checks declarados que GitHub no exige.
6. CI ejecuta pruebas en Node 22/24/26; se validan también las plantillas YAML y los ejemplos con un escáner real donde sea posible.

## Instalación y recuperación

Copiar scripts/plantillas, generar y revisar Dependabot, activar alertas/security updates y configurar protección de rama + variable de checks + auto-merge. Desactivar el workflow de autofusión revoca futuras solicitudes; una autofusión ya encolada se desactiva desde la PR o con `gh pr merge --disable-auto`.

## CLI e instalación para agentes

- Un paquete sin dependencias ni lifecycle scripts expone `magician-security-check init|inventory|doctor|scan`. Se distribuye por GitHub con una versión fijada, sin requerir publicación en npm.
- `init` instala una copia autónoma en `.magician/`, el workflow, Dependabot y una guía `MAGICIAN.md`; añade una sección delimitada a `AGENTS.md` conservando las instrucciones existentes. `--automerge` añade el workflow opcional sin modificar ajustes remotos de GitHub.
- `init --dry-run` calcula exactamente los mismos cambios sin escribir. La planificación completa precede a las escrituras: conflictos con archivos de usuario o enlaces simbólicos hacen fallar la operación sin empezar a instalar. Repetir la instalación no cambia archivos idénticos. Solo actualiza archivos gestionados cuyo hash siga coincidiendo con la instalación anterior.
- Dependabot preexistente se conserva; se genera un candidato para combinarlo y se informa de esa acción pendiente. No se reescribe YAML de terceros ni se modifica el package.json de la aplicación.
- `inventory`, `doctor` y `scan` son de lectura respecto al proyecto. No instalan dependencias de la aplicación, no ejecutan sus lifecycle scripts y no modifican GitHub. Los gestores pueden consultar registros y actualizar sus propias cachés.
- `--json` produce exactamente un documento JSON en stdout con `schemaVersion: 1`, comando, estado, código de salida, raíz, datos, errores y avisos. No hay prompts. Los estados/códigos son `ok/0`, `findings/1`, `error/2`; fallos de herramientas/red o cobertura incompleta tienen prioridad sobre hallazgos.
- `scan` agrega las declaraciones de runtime y auditorías Node por cada lockfile. Otros ecosistemas requieren `osv-scanner`; si falta o no entrega un resultado válido, no se presenta un análisis limpio. `--offline` solo desactiva las consultas de runtime, no las auditorías de registros.
- Se verifica instalación real desde el tarball, ejecución de la copia local, stdout JSON, repetición, conflictos, preservación de AGENTS/Dependabot, enlaces externos y fallos de escáner. Los checks de Node 22/24/26 y las garantías de autofusión se mantienen.

### Repositorio individual y carpeta matriz

- Los mismos comandos `matrix`, `inventory`, `doctor`, `scan` y `update` admiten una raíz individual o una carpeta con varios repositorios. `--scope auto` distingue un proyecto en la raíz de una colección; `--scope project|workspace` permite resolver estructuras ambiguas.
- La búsqueda no sigue symlinks ni entra en dependencias/salidas de build. Un repo Git o proyecto con manifiesto es una unidad, no cada carpeta de su monorepo. Se admiten worktrees con archivo `.git`.
- Los informes de análisis usan `data.repositories[]`, incluso para un único repo, y un resumen agregado. El fallo de un repo no oculta los demás. La salida humana muestra la misma matriz sin requerir JSON.
- La instalación en una carpeta matriz deja la CLI y las guías en esa carpeta; los workflows de CI se instalan al ejecutar `init` en cada repo individual.
- `update` planifica por defecto; solo `--apply` escribe. La primera implementación local aplica `npm audit fix --package-lock-only --ignore-scripts`, sin `--force`, sobre repos Git limpios y con exclusión mutua por repo. No hace commit, push, merge ni despliegue.
- Se respaldan los manifiestos/lockfiles afectados en memoria. Un error de ejecución, cambio de versión major/prerelease o un resultado de auditoría posterior inválido restaura esos archivos. Las actualizaciones compatibles con vulnerabilidades pendientes se reportan como hallazgos.
- Otros gestores/ecosistemas, versiones major y cambios de runtime quedan identificados en el plan para el agente o las PR de seguridad de Dependabot; no se simula que se han aplicado. Tras cualquier cambio local, las pruebas/build de la aplicación siguen pendientes antes de publicar.
