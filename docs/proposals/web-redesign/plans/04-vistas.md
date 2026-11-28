# Plan de desarrollo 4 · Adopción en todas las vistas web

**Resultado.** Cada familia adopta la base común y queda inventariada con evidencia por flujo.

**Arquitectura.** Trabajar por lotes de módulos manteniendo rutas, contratos de datos y permisos. Reusar la galería, el shell y los patrones validados en People. Conservar estilos especializados dentro del módulo que los necesita.

**Stack.** React Router SSR, Tailwind, shadcn/Radix, Vitest y Playwright.

[PRD de adopción](../04-vistas.md) · [Plan del piloto](03-shell-people.md)

## Condiciones comunes

Empezar tras la entrega de la base y el piloto. Cada lote produce un cambio revisable en el producto. Si una vista solicitada requiere una composición nueva, preparar primero las tres opciones HTML. Usar datos ficticios. Las pruebas de rutas para cliente y servidor van en `tests/integration/`.

Revisar enlace público y retorno a sesión (4.1), borrador con streaming o reconexión (4.2), cambios sin guardar y permiso de lectura (4.3), iframe recargado y arrastre por teclado (4.4) y filtros o acciones de administración (4.5). Usar el conjunto de comprobaciones común al acabar cada lote.

## 4.0 · Línea de base y registro de cobertura · VI-06

**Archivos.** Evaluar `packages/client/src/routes.ts` y `packages/client/src/modules/routes.ts`. Revisar `artifacts/web-redesign/catalogo.md`. Crear `docs/proposals/web-redesign/cobertura.md` al ejecutar este plan.

- [ ] Actualizar el catálogo desde HEAD y clasificar rutas, pestañas, paneles y errores por las cinco familias. People y el shell se registran con la evidencia del plan 3.
- [ ] Tomar capturas de línea de base para una muestra por familia en claro y oscuro y en 390 px y escritorio. Usar fixtures con los casos extremos de cada lote.
- [ ] Guardar por superficie punto de entrada, rol, estado, evidencia, prueba y excepción si aplica. Vincular sus issues y commits conforme a la regla del repo.

## 4.1 · Entrada y soporte · VI-01

**Archivos.** `packages/client/src/shell/{Home,SignIn,HelpMenu}.tsx`, `packages/client/src/modules/{onboarding,docs,whats-new}/`, `packages/client/src/views/` para conexión, recuperación, dispositivos, releases y error.

- [ ] Probar enlaces directos con sesión y sin ella, recuperación, consentimientos, primer uso y 404 en el fixture. Añadir una muestra de Docs público y otra con sesión.
- [ ] Aplicar navegación, formularios, avisos, versiones y layout de lectura de la base. Mantener borde entre Docs y shell y conservar controles en el orden de foco.
- [ ] Ejecutar los escenarios `routes`, `releases`, `whats-new` y los casos de Docs y acceso de `tests/integration/ssr-document.test.ts` con `pnpm test --project mixed`. Registrar capturas y enlaces.

## 4.2 · Conversación y ejecución · VI-02

**Archivos.** `packages/client/src/modules/{chat,rooms,ask,voice,computers,coding,runs,approvals,activity}/`, `packages/client/src/shell/DotPanel.tsx` y `packages/client/src/views/ChatViews.tsx`.

- [ ] Registrar borrador, streaming largo, aprobación pendiente, pérdida de conexión, resultados de herramientas, sala y modo llamada. Mantener fixture de modelo de prueba para streaming.
- [ ] Rediseñar primero transcript y composer. Después aplicar los patrones de formulario, detalle y estados en vivo a paneles, sesiones de código, Runs, Activity y Approvals. Mantener controles de streaming y scroll disponibles durante el cambio de apariencia.
- [ ] Ejecutar los escenarios `chat`, `tabs`, `routes` y `mobile-fit` de `scripts/ui-smoke.mjs`. Registrar pruebas manuales para llamada, panel remoto y errores que el fixture no produzca.

## 4.3 · Contenido y datos · VI-03

**Archivos.** `packages/client/src/modules/{spaces,pages,dataspace,media,learning,memories}/`, `packages/client/src/views/DatasetViewDisplay.tsx` y CSS del editor.

- [ ] Probar biblioteca/lector/editor, enlaces de página, estado sin guardar, un dataset con tabla ancha, Media sin elementos, un Space de acceso restringido y cobertura del editor en móvil.
- [ ] Aplicar encabezados, colecciones y detalle a Spaces, Datasets y Media. Revisar portadas, barras del editor y bloques embebidos con contenido realista. Adoptar estados de lista y lectura en Learning y Memories.
- [ ] Ejecutar escenarios `covers`, `links`, `search`, `views`, `data`, `media` y `learning`. Verificar guardado y retorno por enlace antes de cerrar.

## 4.4 · Gestión de trabajo · VI-04

**Archivos.** `packages/client/src/modules/{issues,schedules,apps,plugins}/`, `packages/client/src/plugins/{calendar,planner}/` y `packages/plugin-ui/src/` para superficies propias.

- [ ] Probar tablero y detalle, actualización de un schedule, menú táctil, acceso a App por rol y plugin abierto por deep link. Verificar reenvío de esquema tras recarga.
- [ ] Adaptar Issues y Schedules a grilla y detalle compartidos. Adoptar shell y controles en Apps, Plugins, Calendar y Planner. Registrar el límite de estilo con el documento alojado.
- [ ] Ejecutar escenarios `issues`, `schedules`, `routes` y `mobile-fit`. Correr `pnpm test --project client packages/client/tests/plugin-ui-bridge.test.ts`. Verificar a mano la interacción de tablero con teclado y scroll móvil.

## 4.5 · Administración · VI-05

**Archivos.** `packages/client/src/modules/{settings,dots,agents,operator,operations}/` y `packages/client/src/components/charts/`.

- [ ] Probar formulario con cambios sin guardar, estado bloqueado por rol, valores largos, filtros de Operations y detalle de un gráfico en ambas paletas. Registrar navegación de vuelta conservando filtros.
- [ ] Aplicar formularios, indicadores, tabla y detalle compartidos. Usar Quick actions y Access review donde haya acciones o hechos ya disponibles. Mantener controles sensibles en el flujo existente.
- [ ] Ejecutar escenarios `operator`, `operations`, `operations-access`, `ops-activity` y `ops-knowledge`. Probar rutas de Settings con miembro y administrador y registrar los casos condicionados por flags.

## 4.6 · Cierre de cobertura y CSS · VI-06

**Archivos.** Revisar `packages/client/src/{globals.css,style.css,styles/legacy-dark.css,styles/legacy-reset.css}`, hojas de estilo de módulos y `docs/proposals/web-redesign/cobertura.md`.

- [ ] Comparar cobertura con las rutas y puntos de entrada vigentes. Resolver pendientes de estados, permisos y puntos de acceso que salgan en la comparación.
- [ ] Retirar reglas heredadas cuando se verifique que ya no tienen consumidores. Si se edita `style.css`, regenerar el archivo oscuro con `pnpm test --project mixed tests/integration/legacy-dark.test.ts -u` y revisar el resultado.
- [ ] Repetir comprobación de galería, contraste, navegación y SSR, más `node apps/mobile/scripts/generate-theme.mts --check`. Cerrar con `pnpm run check:cached`, `pnpm run test:cached` y `pnpm run build` y adjuntar resultados al registro de cobertura.
