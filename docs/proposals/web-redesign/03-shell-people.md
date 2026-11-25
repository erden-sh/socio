# PRD 3 · Shell y People Desk

Propuesta para revisión · [Programa](../WEB-REDESIGN.md) · [Plan](plans/03-shell-people.md)

## Resultado

El shell da una estructura consistente a la aplicación. People Desk demuestra ese lenguaje en una vista con datos densos y acciones que requieren atención. El rediseño incorpora el prototipo elegido, las siete paletas y los flujos existentes de administración.

## Requisitos del shell y del piloto

| ID    | Requisito                                                                                                                                                                                                                                                                                      |
| ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| PI-01 | Sidebar, encabezado, breadcrumb, buscador global y menú de cuenta usan la base visual. Se mantienen enlaces, atajos de búsqueda y colapso, estado de conexión, avisos, acciones del encabezado y acceso según rol.                                                                             |
| PI-02 | `/settings/people` mantiene el directorio, Groups y Service accounts, incluidos enlaces con parámetros y el detalle de persona. El directorio mantiene búsqueda, orden y filtros, con tabla en escritorio y cards en móvil.                                                                    |
| PI-03 | **Quick actions** muestra Invite people, Create group y Create service account cuando están habilitadas en el producto. Enlaza a los formularios existentes. Las acciones por fila y la búsqueda global siguen disponibles en su contexto.                                                     |
| PI-04 | **Access review** muestra invitaciones vencidas y advertencias verificables de cuentas de servicio cuyo creador ya no puede iniciar sesión, usando los datos ya disponibles. Lleva a la vista o acción existente. El estado distingue revisión completa, información parcial y fallo de carga. |
| PI-05 | El detalle contextual enlaza al perfil canónico de la persona o a la cuenta de servicio. El historial del navegador puede restaurar la pestaña o la entidad correspondiente. Cerrar el detalle devuelve el foco al control que lo abrió si sigue visible.                                      |
| PI-06 | Invitar, cambiar rol, desactivar, reactivar y gestionar grupos o llaves conserva confirmaciones, manejo de errores, restricciones de Better Auth y controles del servidor. Las llaves y los enlaces de acceso se muestran únicamente en los flujos existentes que los entregan.                |

**Ejemplo.** El administrador abre People y filtra invitaciones. Access review muestra cuáles han vencido. Al elegir una, la app lo lleva a la fila o al detalle correspondiente. Desde allí puede usar la acción de emitir un enlace nuevo disponible en ese contexto. Una advertencia de cuenta de servicio lleva a su pestaña y a su contexto de gestión.

El contenido de review empieza con hechos ya presentes en People y Service accounts. Los puntajes de riesgo, nuevas políticas, procesamiento masivo y cambios de autorización requieren su propia definición de producto. [Flujos de People](../PEOPLE-MANAGEMENT.md), [propuesta del shell](../WORKSPACE-SHELL.md)

## Aceptación

- Un administrador usa las tres pestañas y los enlaces directos a personas y cuentas. Un miembro sigue las restricciones vigentes. Sin Better Auth, se conservan las restricciones y Service accounts sigue disponible como hoy.
- Cada acción primaria abre el flujo existente una sola vez. Al fallar una petición, el panel permite reintento o deriva a la vista que sí se cargó. Sin datos suficientes, Access review deja visible la cobertura conocida.
- La desactivación muestra impacto y pide confirmación. El cierre de sesión de una cuenta afectada y la reactivación siguen pasando las pruebas existentes.
- Comparación visual con People Desk en Erden Glass y Socio en claro y oscuro, con una comprobación básica de las cinco paletas restantes. Teclado, 390 px, escritorio, cadenas largas y navegación Atrás/Adelante forman parte del pase.
