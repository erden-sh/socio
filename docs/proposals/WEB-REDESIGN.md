# Rediseño web de Socio

Propuesta para revisión · 24 de noviembre de 2026

Socio necesita una identidad visual común para toda la aplicación web y una forma predecible de cambiar de tema. La primera entrega visual es una galería HTML que permite comparar las siete paletas sobre los mismos componentes. People Desk sirve como primer piloto dentro de la app. El objetivo final cubre todas las familias de vistas.

## Entregas

| Entrega                | PRD                                      | Plan de desarrollo                              | Condición para avanzar                                                                                                                  |
| ---------------------- | ---------------------------------------- | ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| 1. Apariencia y temas  | [PRD 1](web-redesign/01-apariencia.md)   | [Plan 1](web-redesign/plans/01-apariencia.md)   | La galería inicial demuestra claro y oscuro, y las preferencias pasan pruebas de herencia, recarga y cambio de sesión.                  |
| 2. Base de componentes | [PRD 2](web-redesign/02-componentes.md)  | [Plan 2](web-redesign/plans/02-componentes.md)  | La galería cubre las 25 familias de primitivas y una muestra de patrones compuestos, con evidencia de teclado, tacto y los siete temas. |
| 3. Shell y People Desk | [PRD 3](web-redesign/03-shell-people.md) | [Plan 3](web-redesign/plans/03-shell-people.md) | Navegación y directorio conservan flujos, permisos y enlaces. El piloto deja listos Quick actions, Access review y detalle contextual.  |
| 4. Resto de las vistas | [PRD 4](web-redesign/04-vistas.md)       | [Plan 4](web-redesign/plans/04-vistas.md)       | Cada familia tiene inventario de rutas y estados, comparación visual y pruebas de sus flujos.                                           |

La primera pieza que se revisa es **una galería HTML aislada con Button, Input, Badge, Skeleton, una tabla y un menú**. Se compara Liquid Glass en claro y oscuro con la paleta Socio y se verifica que las otras cinco compartan el contrato. La implementación sigue el orden de la tabla. Las entregas 1 y 2 pueden compartir una revisión visual antes de incorporar el nuevo valor por defecto a una versión de producto.

## Alcance común

- Cubrir la aplicación web autenticada, acceso, Docs y superficies propias de plugins. Mantener la integración existente con móvil nativo, el sitio público y los enlaces de instalación.
- Mantener las rutas, permisos, contratos de datos y atajos que usa cada flujo. Quick actions y Access review presentan acciones y hechos que cada módulo ya puede ofrecer.
- Preparar tres alternativas HTML cuando se pida un diseño nuevo para una vista. La adopción de un patrón acordado puede continuar por migración. People Desk ya tiene una dirección elegida que se puede refinar.
- Mantener el criterio de Socio de usar color para identidad del módulo, prioridad o estado, con texto o icono cuando comunique información. Usar las microinteracciones para indicar respuesta, apertura o cambio de estado. [Revisión anterior de Socio](https://brain.ingenioventures.com/issues/CB-308)

## Decisiones propuestas para revisión

| Decisión                                                                                                       | Razón                                                                                                                 |
| -------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Colores y materiales en CSS, primitivas compartidas                                                            | Mantiene las APIs de componentes y los controles accesibles de shadcn/Radix.                                          |
| Las siete paletas ligeras viajan en el CSS inicial                                                             | Permite cambiar en el acto. La compilación medirá el tamaño comprimido y los recursos pesados podrán cargarse aparte. |
| Preferencia de color con sesión en servidor. El valor histórico del navegador se usa fuera de la sesión        | El valor histórico carece de dueño y dos personas pueden usar el mismo navegador.                                     |
| Access review empieza con invitaciones vencidas y cuentas de servicio que ya tienen una advertencia disponible | Presenta datos accionables que el producto ya conoce y mantiene el alcance del piloto.                                |

La otra opción de carga es enviar por red el CSS de un solo tema por vez. Está descrita en el [PRD de apariencia](web-redesign/01-apariencia.md). Se reconsidera si la medición muestra un costo relevante de descarga. La auditoría original y el prototipo People Desk están disponibles como artefactos locales en `artifacts/web-redesign/` y `artifacts/people-design/`.

Las entregas se vinculan al tablero de Issues cuando empieza su ejecución. [CB-308](https://brain.ingenioventures.com/issues/CB-308) es la referencia visual y [CB-419](https://brain.ingenioventures.com/issues/CB-419) es una regresión conocida que debe verificarse al tocar el esquema de los plugins.
