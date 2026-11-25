# PRD 4 · Adopción en todas las vistas web

Propuesta para revisión · [Programa](../WEB-REDESIGN.md) · [Plan](plans/04-vistas.md)

## Resultado

Cualquier módulo se siente parte de Socio al navegar, buscar, editar, revisar o actuar. Cada familia conserva las interacciones especializadas que necesita. El alcance se comprueba contra las rutas y las superficies sin ruta propia del catálogo.

## Familia y criterio de salida

| ID    | Familia                  | Alcance y criterio                                                                                                                                                                                                         |
| ----- | ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| VI-01 | Entrada y soporte        | Inicio, autenticación, onboarding, recuperación, consentimientos, verificación de dispositivo, ayuda, releases, Docs y error. Debe funcionar por enlace directo, con y sin sesión.                                         |
| VI-02 | Conversación y ejecución | Chat, perfiles de socios, salas, Ask, voz, computadoras, coding, Runs, Approvals y Activity. Conservar composer, borrador, transmisión, seguimiento de scroll, atajos y manejo de estados en vivo.                         |
| VI-03 | Contenido y datos        | Spaces y sus secciones, Pages, editor, Datasets, Media, Learning y Memories. Conservar árbol, enlaces, búsqueda, edición, guardado, vista previa y autorizaciones.                                                         |
| VI-04 | Gestión de trabajo       | Issues, Schedules, Apps, Plugins, Calendar y Planner. Mantener tablero, detalle, edición, calendario y carga de integraciones. Los plugins alojados externamente siguen el contrato del iframe.                            |
| VI-05 | Administración           | Settings restante, Socios, Connected agents, Platform y Operations. Conservar ajustes, autorizaciones, métricas, filtros, registros y confirmaciones de cambios de impacto.                                                |
| VI-06 | Cierre transversal       | Cada ruta, panel o estado crítico tiene familia y evidencia. Las reglas CSS heredadas se retiran tras comprobar su último uso. Las excepciones de editor, gráficos y plugins se documentan con responsable de seguimiento. |

## Qué decide cada familia

La familia selecciona sus muestras, patrón y estados a partir del catálogo. Para las vistas nuevas que se pidan, se revisan tres alternativas HTML antes de integrar su estructura. Se puede iniciar la siguiente familia cuando la anterior tenga su pase registrado y las piezas compartidas sean estables. Puede haber Quick actions en una colección con acciones frecuentes, o Access review cuando se disponga de un estado real y su acción tenga permisos.

Por defecto se verifica cada cambio en escritorio y 390 px, Liquid Glass y Socio, claro y oscuro. La galería valida las siete paletas. En los estados sensibles se agregan pruebas de roles, enlaces directos, error, carga, teclado y movimiento reducido. Se documenta la decisión cuando una pantalla necesita CSS especializado o cuando un iframe depende de su propio tema.

## Aceptación del programa

La revisión registra URL o punto de entrada, rol, estados, tamaños, evidencia de comparación visual y prueba funcional por familia. El conjunto cubre el catálogo verificado contra el árbol vigente del router. El release de la app puede evaluar el rediseño por entregas sin cambiar URL, capacidades ni permisos de las vistas incluidas. [Router](../../../packages/client/src/routes.ts), [rutas de módulos](../../../packages/client/src/modules/routes.ts), [escenarios existentes](../../../scripts/ui-smoke.mjs)
