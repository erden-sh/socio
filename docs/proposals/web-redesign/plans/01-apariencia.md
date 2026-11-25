# Plan de desarrollo 1 · Apariencia y temas

**Resultado.** Una galería HTML inicial y siete temas aplicados por SSR, con preferencias personales y de compañía.

**Arquitectura.** Compartir el registro y la resolución en `@socio/shared`. Guardar los campos opcionales con los ajustes existentes. Mantener los estilos por tema en archivos CSS separados y distribuir los tokens ligeros con la base.

**Stack.** React Router SSR, TypeScript, Zod, Hono, Tailwind 4, SQLite, Vitest y Playwright.

[PRD de apariencia](../01-apariencia.md) · [Programa](../../WEB-REDESIGN.md)

## Condiciones comunes

Conservar rutas existentes, caché de HTML personalizado, CSP y formatos de los canales de plugins. Usar el Node del repositorio. Mantener cambios y verificaciones en un commit por tarea o por pareja de tareas que requiera compilar junta. Los nombres de carpetas nuevas de este plan son propuestas de implementación.

Revisar especialmente cinco casos. IDs retirados (1.1), guardados concurrentes de campos distintos (1.2), cambio de cuenta en una pestaña (1.3), rollback de guardado y polling (1.4), iframe recargado y salida nativa (1.5).

## 1.0 · Galería HTML inicial

**Archivos.** Crear `artifacts/web-redesign/component-gallery.html`. Usar los valores del prototipo `artifacts/people-design/people-desk-palettes.html` como referencia.

- [x] Construir una prueba local con Button, Input, Badge, Skeleton, tabla y menú. Mostrar defecto, foco, error y carga. Aplicar los tokens actuales de Socio y el material del prototipo.
- [x] Añadir el selector común de paleta y modo. Comparar Erden Glass y Socio en claro y oscuro. Pasar por las otras cinco paletas con las mismas piezas.
- [x] Probar escritorio, 390 px, teclado y fallback opaco. Registrar decisiones visuales antes de aplicar la base a las rutas del producto.

## 1.1 · Registro y contrato CSS · AP-01, AP-06

**Archivos.** Crear `packages/shared/src/settings/appearance.ts`, `packages/client/src/styles/themes/` con un CSS por cada ID y `tests/appearance-resolution.test.ts`. Modificar `packages/client/src/globals.css` y `packages/client/tests/theme-contrast.test.ts`.

**Contrato.** `THEME_IDS`, `COLOR_MODES`, `ThemeId`, `ColorMode`, `DEFAULT_THEME_ID = 'erden-glass'` y `resolveAppearance(input: { personalThemeId?: unknown; defaultThemeId?: unknown; colorMode?: unknown }): ResolvedAppearance`. `ResolvedAppearance` tiene `themeId: ThemeId` y `colorMode: ColorMode`. `COLOR_MODES = ['light', 'dark', 'system']`.

- [x] Probar la precedencia completa, valor nulo, ID desconocido almacenado, modo desconocido y registro sin IDs duplicados. Para los temas, probar los pares de texto, acción y control en cada esquema.
- [x] Ejecutar `pnpm test --project server tests/appearance-resolution.test.ts` y `pnpm test --project client packages/client/tests/theme-contrast.test.ts`. Los casos nuevos deben fallar antes de implementar.
- [x] Implementar la resolución pura y manifiesto estable. Definir capas con `data-theme` y `data-scheme`. Reutilizar `@theme inline`. Mantener los bloques base que lee Móvil en `globals.css` y que Socio usa como paleta de compatibilidad.
- [x] Repetir las pruebas y comprobar 14 combinaciones completas. Medir las reglas de apariencia en el CSS inicial compilado. La diferencia al excluirlas del mismo archivo es de 1.885 bytes gzip.

## 1.2 · Persistencia y validación · AP-02 a AP-04

**Archivos.** Modificar `packages/shared/src/types.ts`, `packages/shared/src/voice/dictation.ts`, `src/server/composition/http/settings.ts`, `src/server/live/views/state.ts` y `src/server/workspace/workspace-routes.ts`. Revisar `src/server/settings/workspace-settings.ts`, `src/server/workspace/people.ts` y `src/server/workspace/views.ts`. Extender la prueba de permisos y ajustes en `tests/branding.test.ts`.

**Contrato.** `Settings.defaultThemeId?: ThemeId | null`. `UserPreferences.themeId?: ThemeId | null` y `UserPreferences.colorMode?: ColorMode`. Campo omitido conserva el valor. `null` en un tema elimina la elección explícita. En modo, `system` vuelve al valor automático.

- [x] Probar PATCH válido, ID o modo inválido con 400, escritura de compañía por miembro con 403, intento de editar a otro usuario, restauración con `null` y escrituras de campos distintos que preservan notificaciones, dictado y branding.
- [x] Ejecutar `pnpm test --project server tests/branding.test.ts` y comprobar fallo de los casos nuevos.
- [x] Añadir campos a los esquemas y al estado ya serializado. Mantener la actualización parcial de JSON y los contadores existentes. Reusar los validadores del registro para escritura, dejando la resolución tolerante al leer registros antiguos.
- [x] Repetir la prueba del servidor. Confirmar que los objetos guardados antes del cambio siguen siendo válidos.

## 1.3 · Primer render y sesión · AP-03, AP-05

**Archivos.** Modificar `packages/shared/src/web/web.ts`, `src/server/composition/http/web.ts`, `src/server/web/services.ts`, `packages/client/src/root.tsx`, `public/theme-init.js`, `packages/client/src/shell/theme.tsx`, `packages/client/src/shell/App.tsx` y `tests/integration/ssr-document.test.ts`. Extender el escenario `shell` de `scripts/ui-smoke.mjs`.

**Contrato.** `WebServices.appearance(): Promise<ResolvedAppearance>` memoizado por solicitud. El documento emite `data-theme` y `data-color-mode`. Se aplica `data-scheme="light|dark"`, clase `.light/.dark` y `color-scheme`. Se conserva la forma de `useThemeChoice()` para sus consumidores.

- [x] Probar HTML SSR para herencia, override, Doc público, ruta por enlace y sesión cerrada. Verificar que la selección sea de la sesión y el script siga primero bajo CSP. Añadir navegador con modo del SO cambiante y dos sesiones en el mismo contexto.
- [x] Ejecutar `pnpm test --project mixed tests/integration/ssr-document.test.ts tests/integration/security-headers.test.ts` y comprobar el fallo esperable.
- [x] Compartir la identidad memoizada. Pasar a `userServices` una lectura estrecha de preferencias desde `LegacyWorkspace` en la composición HTTP. Leer únicamente ajustes y preferencias de la identidad confirmada. Exponer solo la apariencia resuelta. Aplicar esquema explícito desde SSR. Para `system`, el script y el proveedor siguen `matchMedia`. Leer el modo anterior del navegador solo para el contexto sin sesión. Coordinar cambios de sesión con la revalidación del shell.
- [x] Repetir las pruebas SSR y CSP. Comprobar en Chromium la app compilada con dos sesiones de prueba, una recarga sin el cliente y el cambio de tema en vivo.

## 1.4 · Controles y actualización en vivo · AP-02 a AP-04

**Archivos.** Modificar `packages/client/src/modules/settings/AccountSettings.tsx`, `packages/client/src/modules/settings/WorkspaceSettings.tsx`, `packages/client/src/shell/theme.tsx`, `packages/client/src/shell/App.tsx` y sus consumidores actuales de modo. Crear `packages/client/tests/appearance-controls.test.tsx`.

- [x] Probar que Cancel/rechazo mantiene el valor confirmado, un segundo guardado termina en el último valor elegido, reset vuelve a heredar y un cambio administrativo llega a la cuenta que hereda sin cambiar el override de otra.
- [x] Ejecutar `pnpm test --project client packages/client/tests/appearance-controls.test.tsx` y comprobar el fallo inicial.
- [x] Incorporar ambos selectores en las secciones existentes, reutilizando las primitivas actuales. Usar PATCH parcial con guardados secuenciales desde cada selector. Confirmar el valor con la respuesta o lectura revalidada. Compartir la información del poll y evitar que una lectura anterior pise un guardado confirmado.
- [x] Repetir prueba. Comprobar a dos pestañas y dos roles en el fixture. Registrar resultado y estado visible de error.

## 1.5 · Material y compatibilidad · AP-06, AP-07

**Archivos.** Revisar `packages/client/src/globals.css`, `packages/client/src/modules/plugins/PluginFrame.tsx`, `packages/plugin-ui/src/bridge.tsx`, `packages/client/tests/plugin-ui-bridge.test.ts`, `apps/mobile/scripts/generate-theme.mts` y `tests/integration/legacy-dark.test.ts`.

- [x] Añadir cobertura para `theme` con cada `ready` del iframe y cambios de esquema. Guardar muestras de material sólido y translúcido con contraste reforzado, transparencia reducida y colores forzados.
- [x] Mantener el mensaje existente `light|dark` y verificar segundo `ready` antes de cerrar el caso. Exponer tokens de material y su fallback para las piezas de la entrega 2.
- [x] Ejecutar `pnpm test --project client packages/client/tests/plugin-ui-bridge.test.ts packages/client/tests/theme-contrast.test.ts`, `pnpm test --project mixed tests/integration/legacy-dark.test.ts` y `node apps/mobile/scripts/generate-theme.mts --check`.
- [ ] Revisar los cambios junto con el PRD y pasar `pnpm run check:cached`, `pnpm run test:cached` y `pnpm run build` antes del cierre de la entrega.
