# Plan de desarrollo 2 · Base de componentes

**Resultado.** Una galería aislada que renderiza las 25 familias de primitivas reales y sirve para validar los patrones de Socio.

**Arquitectura.** Las primitivas existentes conservan Radix, CVA y `data-slot`. Se apoyan en el contrato semántico de apariencia. Una entrada Vite local renderiza ejemplos reproducibles y queda fuera de las rutas de producción.

**Stack.** React, Vite, Tailwind 4, Radix, CVA, Vitest y Playwright.

[PRD de componentes](../02-componentes.md) · [Plan de apariencia](01-apariencia.md)

## Condiciones comunes

Usar el contrato de temas de 1.1. Conservar firmas, roles, eventos, foco y comportamiento de teclado. Los estilos de las vistas pueden adoptar la nueva base de forma incremental. La revisión visual parte de la galería HTML 1.0. Mantener un commit por lote verificable.

El prototipo aprobado de People Desk es la referencia visual de Erden Glass. La galería reúne las primitivas reales en un directorio de ejemplo para comprobar el borde iluminado de la barra, las cápsulas de navegación y acción, los paneles sólidos y el tratamiento de selección en claro y oscuro.

Revisar zoom y cadenas largas (2.1), entrada inválida y campo deshabilitado (2.2), cambio de tema con overlay abierto (2.3), foco al cerrar o filtrar un resultado (2.3 y 2.4) y datos incompletos de los paneles (2.4).

## 2.1 · Galería con las primitivas reales · UI-01, UI-03

**Archivos.** Crear `scripts/component-gallery/index.html`, `scripts/component-gallery/main.tsx`, `scripts/component-gallery/vite.config.ts` y `scripts/check-component-gallery.mjs`.

- [x] Definir ejemplos con nombres accesibles por familia. Incluir muestra de tema, formulario y tabla antes de agregar el resto.
- [x] Resolver `@` al código del cliente y cargar el CSS de producción en la entrada. Usar ThemeProvider para aplicar `data-theme`, `data-scheme` y el modo del sistema. Usar datos ficticios.
- [x] Arrancar con `pnpm exec vite scripts/component-gallery --config scripts/component-gallery/vite.config.ts --host 127.0.0.1 --port 4400`. Ejecutar `node scripts/check-component-gallery.mjs http://127.0.0.1:4400`. El script debe identificar sobreflujo horizontal de página a 390 px y confirmar siete paletas y dos esquemas.
- [x] Añadir las 25 familias de la tabla del PRD y verificar que el build de producción no incorpore la entrada de galería.

## 2.2 · Controles, estados y superficies · UI-02 a UI-04

Primer lote verificado en Chromium. Button, Input y Badge muestran un indicador de foco sólido. Button limita la transición a las propiedades que cambian y Skeleton respeta movimiento reducido. Los badges destructivos usan el par de color de su paleta.

**Archivos.** Modificar `packages/client/src/globals.css`, `packages/client/src/style.css`, `packages/client/src/components/form-fields.tsx` y `packages/client/src/components/ui/` por lote. Añadir verificaciones relevantes al script de la galería y al test de contraste existente.

- [x] Hacer que el chequeo de contraste cubra estados de acción primaria, destructiva, foco, campos inválidos y badges informativos por esquema. Separar estado deshabilitado del indicador de foco.
- [x] Ajustar Button, Input, Badge, Skeleton y Card. Tratar controles nativos y estilizados como familia. Después ajustar Textarea, Select, Checkbox, Switch, Avatar, Table, ScrollArea, Separator y Toaster. Mantener las variantes de densidad como elección del flujo.
- [x] Revisar contraste de pares y estados de carga/error. Confirmar que un control inválido se entiende por su mensaje y que uno bloqueado conserva su razón visible cuando el flujo la requiera.
- [x] Ejecutar `pnpm test --project client packages/client/tests/theme-contrast.test.ts` y la comprobación de galería. Si cambia una regla heredada, regenerar su equivalente con la prueba existente y revisar el diff.

## 2.3 · Navegación, overlays y microinteracciones · UI-03, UI-04, UI-06

**Archivos.** Modificar `packages/client/src/components/ui/{breadcrumb,sidebar,tabs,collapsible,command,alert-dialog,dialog,dropdown-menu,popover,sheet,tooltip}.tsx`. Reutilizar `packages/client/src/components/ui/return-focus.ts`. Extender `scripts/check-component-gallery.mjs`.

- [x] Probar apertura por teclado, Escape, restauración de foco, continuidad del overlay al cambiar de esquema y layout largo en 390 px. Probar superficie sólida con las preferencias de sistema disponibles.
- [x] Aplicar tokens de superficie y movimiento a transiciones de entrada, cambio de estado y cierre. Mantener la transición localizada al elemento y un mapa de movimiento reducido.
- [x] Confirmar que la opción actual se puede identificar con teclado y que los overlays sin blur se leen sobre contenido de ejemplo. Guardar muestras de Erden Glass y Socio en claro y oscuro y ejecutar la comprobación en las demás paletas.

## 2.4 · Patrones compuestos · UI-05

**Archivos.** Revisar `packages/client/src/views/WorkspacePage.tsx`, `packages/client/src/components/data-grid/DataGrid.tsx` y `packages/client/src/components/infinite-list/InfiniteList.tsx`. Crear `packages/client/src/components/quick-actions.tsx` y `packages/client/src/components/access-review.tsx` cuando la composición esté validada en la galería.

**Contrato.** `QuickActions({ children }: { children: ReactNode })` agrupa las acciones suministradas por la vista. `AccessReview({ state, children }: { state: 'loading' | 'ready' | 'partial' | 'error'; children: ReactNode })` presenta el estado y el contenido que el flujo aporta. Título y orden de interacción siguen el patrón validado. Cada vista conserva sus datos y permisos.

- [ ] Probar directorio responsive, formulario, detalle contextual y paneles vacíos, parciales y con error. Revisar foco si una acción desaparece al filtrar o cambia el dato mostrado.
- [ ] Ajustar estructura de página y tabla responsive. Construir los dos paneles con ejemplos ficticios. La API permite usar enlaces y botones existentes.
- [ ] Ejecutar la matriz de galería y `pnpm run check:cached`, `pnpm run test:cached` y `pnpm run build`. Registrar qué variantes se validaron antes de pasar al shell.
