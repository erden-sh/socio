# PRD 2 · Base de componentes

Propuesta para revisión · [Programa](../WEB-REDESIGN.md) · [Plan](plans/02-componentes.md)

## Resultado

Diseño puede comparar componentes funcionales antes de decidir cómo se usarán en cada vista. Desarrollo puede usar una misma API y esperar el mismo comportamiento en los siete temas. El resultado incluye una galería interna con ejemplos que corresponden al código real.

## Requisitos

| ID    | Requisito                                                                                                                                                                                                                                                         |
| ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| UI-01 | La galería inicial en HTML se revisa primero en Erden Glass y Socio, en claro y oscuro. La galería de desarrollo permite cambiar entre las siete paletas, claro, oscuro y sistema, y contiene ejemplos con foco, error, carga y contenido largo.                  |
| UI-02 | La base define tipo, tamaño, espaciado, densidad, radios, sombras, superficies, foco y movimiento. Los estados visibles tienen función clara. Conservar los tonos de módulos y acompañar estados importantes con palabras o iconos.                               |
| UI-03 | Están representadas las 25 familias de primitivas del repositorio. Empezar por Button, Input, Badge, Skeleton y Card. Continuar con controles de formulario, navegación, colecciones, feedback, menús y overlays.                                                 |
| UI-04 | La misma pieza conserva props, rol, teclado, retorno de foco y eventos cuando cambia la apariencia. Los ejemplos incluyen acciones deshabilitadas, errores, estados vacíos, superposiciones y pantallas táctiles.                                                 |
| UI-05 | El nivel de composición demuestra estructura de página, formulario, tabla responsive, lista/detalle, Quick actions y Access review. La última muestra usa datos ficticios. Las vistas podrán añadir acciones con sus permisos y seguir el mismo patrón de estado. |
| UI-06 | Las microinteracciones comunican pulsación, apertura o cambio de estado. Se prueban estados con movimiento reducido, contraste reforzado y fallback sólido. El lenguaje se aplica al producto con roles semánticos que pueden auditarse.                          |

## Cobertura mínima

| Familia                    | Piezas y estados                                                                                                                                                                     |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Acciones, entrada y estado | Button, Input, Textarea, Select, Checkbox, Switch, Badge, Avatar, Skeleton y Toaster. Variantes comunes, botones con icono, selección, campo inválido, confirmación, error y espera. |
| Superficies y estructura   | Card, Separator, Table y ScrollArea. Tabla densa, tabla en móvil, texto largo y contenido que desborda.                                                                              |
| Navegación                 | Breadcrumb, Sidebar, Tabs, Collapsible y Command. Actual, enfoque con teclado, truncado y navegación móvil.                                                                          |
| Overlays                   | AlertDialog, Dialog, DropdownMenu, Popover, Sheet y Tooltip. Apertura, Escape, anclado, posición, retorno de foco y acciones destructivas.                                           |

Quick actions agrupa acciones del flujo. Access review presenta un estado verificable con su explicación y una acción o enlace al detalle. Ambos tienen una anatomía compartida desde la galería. Su primera implementación con datos del producto se define en el [PRD del piloto](03-shell-people.md).

## Aceptación

- Revisión visual con escritorio y móvil de 390 px, claro y oscuro, zoom de 200 %, movimiento reducido, transparencia reducida y colores forzados. Validar todos los temas en la galería y guardar muestras comparables de Erden Glass y Socio.
- Interacciones accesibles comprobadas con teclado y tacto. Los ejemplos que requieren cursor tienen una vía identificable por teclado y toque.
- La galería de desarrollo usa las primitivas reales y vive fuera de las rutas de producción. Los patrones compuestos se prueban con contenido variable, estados vacíos y error.
- Una comprobación específica asegura que el nuevo estilo de una primitiva compartida no altera expectativas en sus consumidores existentes. [Primitivas](../../../packages/client/src/components/ui), [DataGrid](../../../packages/client/src/components/data-grid/DataGrid.tsx), [WorkspacePage](../../../packages/client/src/views/WorkspacePage.tsx)
