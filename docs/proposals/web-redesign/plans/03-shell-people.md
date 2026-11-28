# Plan de desarrollo 3 · Shell y People Desk

**Resultado.** Navegación global con el lenguaje de Socio y People Desk integrado como directorio piloto.

**Arquitectura.** El shell conserva su registro y los slots existentes. People compone DataGrid, QuickActions y AccessReview sobre los datos y permisos que ya usan sus pestañas. Los flujos de gestión se abren desde sus handlers actuales.

**Stack.** React Router, TypeScript, Tailwind, Radix, Vitest y Playwright.

[PRD del piloto](../03-shell-people.md) · [Plan de componentes](02-componentes.md)

## Condiciones comunes

Revisar la galería aprobada y el prototipo People Desk. Conservar URL, atajos, roles y datos. Usar fixtures y aplicar cada lote en un commit con su verificación. Separar las pruebas del shell y de People porque requieren sesiones distintas.

Revisar cambio de tamaño con menú abierto (3.1), tab o entidad de un enlace que ya no existe (3.2), cobertura incompleta de Access review (3.3), vínculo de una llave sin credencial visible (3.3 y 3.4), y foco tras Atrás o una confirmación (3.4).

## 3.1 · Navegación global · PI-01

**Archivos.** Modificar `packages/client/src/shell/{AppShell,AppHeader,CommandPalette}.tsx` y `packages/client/src/components/{app-sidebar,nav-user,nav-spaces,sidebar-nav}.tsx`. Extender el escenario `shell` de `scripts/ui-smoke.mjs`.

- [ ] Registrar antes del cambio el caso de sidebar expandida y colapsada, búsqueda global, resultado vacío, menú móvil y encabezado con acciones inyectadas. Agregar una comprobación de menú abierto al pasar de móvil a escritorio.
- [ ] Aplicar tokens y variantes de base. Preservar registro, atajos Ctrl/⌘+K y Ctrl/⌘+B según plataformas soportadas, breadcrumb y slots de acciones. Erden Glass vive en las superficies de navegación y apertura.
- [ ] Ejecutar `node scripts/ui-smoke.mjs --base http://127.0.0.1:4398 --scenario shell`. Comparar miembro y administrador. Verificar 390 px con teclado y tacto.

## 3.2 · Estructura del directorio · PI-02, PI-05

**Archivos.** Modificar `packages/client/src/modules/settings/people/{PeopleSection,PeopleList,PersonPage.route}.tsx`, `packages/client/src/modules/settings/SettingsLayout.tsx` donde lo necesite, y `packages/client/tests/people-ui.test.tsx`.

- [ ] Probar carga directa de cada pestaña, filtro, vista móvil, perfil canónico y cuenta inexistente. Probar que `?tab=service-accounts&account=<id>` sigue abriendo el contexto cuando vuelve el navegador.
- [ ] Componer el directorio con DataGrid y la estructura compartida. Respetar nombres, roles, estados, orden, filtros, acción de fila y enlaces. Conservar `/settings/people/:id` y sus pestañas `access`, `sign-in`, `owns` y `activity`.
- [ ] Ejecutar `pnpm test --project client packages/client/tests/people-ui.test.tsx`. Comprobar sin Better Auth que la navegación de las pestañas conserve los límites actuales.

## 3.3 · Quick actions y Access review · PI-03, PI-04

**Archivos.** Modificar `packages/client/src/modules/settings/people/{PeopleSection,PeopleList,GroupsPanel}.tsx`, `packages/client/src/modules/settings/ServiceAccountsSection.tsx` y `packages/client/tests/people-ui.test.tsx`.

**Contrato.** `QuickActions` recibe botones o enlaces de la vista. `AccessReview` recibe `loading|ready|partial|error` y contenido. Reutilizar `stateOf(person)` para invitaciones y la regla de creador ausente de `ServiceAccountsSection` para claves vivas. Usar modelos ya leídos por el directorio.

- [ ] Probar que cada acción abre o enfoca el flujo existente una vez, que los casos sin Better Auth muestran solo acciones habilitadas y que se puede cerrar con teclado.
- [ ] Probar una invitación vencida junto con una vigente, una clave viva con creador desactivado junto con otra vencida y un fallo de la carga de cuentas. Un dato sin cargar queda reportado como parcial o error, según qué fuente esté disponible.
- [ ] Usar InviteDialog, el diálogo de Groups y el formulario de Service accounts. Cuando la acción navega a otra pestaña, enfocar su destino al montar. Usar una sola lectura compartida de Service accounts si se necesita su información tanto para review como para la pestaña. Conservar las mutaciones y su recarga.
- [ ] Enlazar cada advertencia a su acción existente o contexto canónico. Mantener el detalle de una cuenta acotado a los campos que la vista ya muestra. Ejecutar `pnpm test --project client packages/client/tests/people-ui.test.tsx`.

## 3.4 · Detalle contextual y pase de administración · PI-05, PI-06

**Archivos.** Revisar `packages/client/src/modules/settings/people/{PersonPage.route,DeactivateDialog,InviteDialog}.tsx`, `packages/client/src/modules/settings/ServiceAccountsSection.tsx`, `packages/client/tests/people-ui.test.tsx`, `tests/people-detail.test.ts` y `scripts/ui-smoke.mjs`.

- [ ] Añadir casos de regreso del foco al cerrar detalle, ausencia de la fila que lo abrió, confirmación de cambio de rol, impacto de desactivación y preservación de creador de llave. Probar que Atrás cierra o vuelve al contexto determinable por URL.
- [ ] Componer panel contextual con Sheet o región lateral según ancho. Enlazar a la ruta completa de la persona o pestaña de la cuenta. Los detalles y acciones siguen los permisos del servidor y el mínimo de información ofrecido por cada respuesta existente.
- [ ] Ejecutar `pnpm test --project client packages/client/tests/people-ui.test.tsx` y `pnpm test --project server tests/people-detail.test.ts`. Correr los escenarios `people` con un fixture Better Auth y `shell` con las credenciales del fixture, de acuerdo con el encabezado de `scripts/ui-smoke.mjs`. Usar solamente un entorno de prueba porque el escenario desactiva y reactiva una cuenta.
- [ ] Registrar revisión comparada con el prototipo, incluido 390 px y los cuatro estados Erden Glass/Socio por esquema. Ejecutar `pnpm run check:cached`, `pnpm run test:cached` y `pnpm run build`.
