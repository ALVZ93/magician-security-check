# Contrato de automatización

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
