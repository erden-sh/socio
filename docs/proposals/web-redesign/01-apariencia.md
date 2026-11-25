# PRD 1 · Apariencia y temas

Propuesta para revisión · [Programa](../WEB-REDESIGN.md) · [Plan](plans/01-apariencia.md)

## Resultado

Una persona puede usar la apariencia de su compañía o elegir la suya y encontrarla al volver a entrar. Un administrador puede definir la apariencia que hereda su compañía. El producto arranca con **Liquid Glass** y sigue inicialmente el modo de color del sistema.

El cambio se puede mostrar desde una galería HTML local antes de integrar nuevas piezas al producto. La galería compara los mismos controles en distintos temas y es el lugar para ajustar las paletas.

## Comportamiento

| ID    | Requisito                                                                                                                                                                                                                                                                                                                        |
| ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| AP-01 | Siete temas con ID estable: Socio (`socio`), People desk · Indigo (`indigo`), Erden (`erden`), Liquid Glass (`liquid-glass`), Cobalt & Ice (`cobalt`), Plum & Smoke (`plum`) y Clay & Graphite (`clay`). Cada uno cubre claro y oscuro.                                                                                          |
| AP-02 | El tema efectivo se resuelve en orden personal, compañía y producto. El selector personal presenta **Usar tema de la compañía** e indica cuál se hereda. El ajuste de compañía presenta **Usar tema predeterminado de Socio**. La apariencia compartida se ajusta por workspace.                                                 |
| AP-03 | Claro, oscuro y sistema son una preferencia personal independiente. Cambiar la paleta conserva ese valor. La elección con sesión persiste en servidor entre navegadores. El modo guardado históricamente en el navegador sigue disponible fuera de la sesión. En sesión, una cuenta sin modo guardado comienza en sistema.       |
| AP-04 | Un cambio personal o de compañía se refleja al guardarse. Los clientes que ya están abiertos lo reciben mediante las vistas sincronizadas del workspace. Los cambios de compañía afectan a quienes heredan. Un error de guardado se ve en el control, conserva el último valor confirmado y permite reintentar.                  |
| AP-05 | El primer render usa el tema efectivo y resuelve el modo antes de pintar. Abrir un enlace, recargar, cerrar sesión o cambiar de cuenta mantiene la apariencia que corresponde al contexto. Las páginas públicas de esa instalación pueden heredar la paleta de compañía usando solo su ID público.                               |
| AP-06 | Los temas comparten roles de color y estados. La variante Liquid Glass usa translucidez para navegación y controles flotantes cuando el fondo lo permite. El texto principal, las grillas y las revisiones usan superficies sólidas. Transparencia reducida, blur no disponible y colores forzados tienen alternativas legibles. |
| AP-07 | Móvil nativo conserva su salida generada. El iframe de plugin sigue recibiendo claro u oscuro, también al recargar. Calendar integrado, Docs y los portales de overlays se revisan con el tema del documento que los hospeda.                                                                                                    |

El catálogo inicial es un conjunto curado. La edición libre de colores, el bloqueo del tema personal por el administrador y las paletas para el cliente móvil quedan fuera de esta entrega. [Prototipo local de referencia](../WEB-REDESIGN.md#decisiones-propuestas-para-revisión)

## Opciones de implementación

**Archivos CSS por tema y un paquete crítico compartido.** Una paleta contiene pares semánticos y propiedades de material. Tailwind expone un solo conjunto de clases y el documento determina qué valores se aplican. Esta es la opción propuesta para siete paletas de valores pequeños y cambio sin espera. Registrar el delta de CSS comprimido y verificar que cambiar entre paletas no descargue CSS o JavaScript adicional.

**Archivo activo servido por separado.** El HTML SSR enlaza únicamente el CSS del tema seleccionado. El cambio necesita descargar el siguiente archivo y conservar el anterior hasta que esté disponible. Vale la pena evaluar esta opción para assets grandes o si la medición inicial muestra un costo relevante. [Temas de shadcn/ui](https://ui.shadcn.com/docs/theming), [variables de Tailwind](https://tailwindcss.com/docs/theme#referencing-other-variables), [división de CSS en Vite](https://vite.dev/guide/features.html#css-code-splitting)

## Aceptación

- Matriz de siete temas por dos modos con pares de texto, acción primaria, foco, estado y lienzo legibles. El material se comprueba sobre fondos reales. [WCAG 2.2](https://www.w3.org/TR/WCAG22/), [Materiales de Apple](https://developer.apple.com/design/human-interface-guidelines/materials)
- Cuenta nueva, cuenta antigua, dos cuentas en una pestaña, administrador y miembro. Verificar selección, restauración, rechazo de ID inválido, requisitos de acceso, error al guardar y actualización simultánea de otras preferencias.
- Primer HTML y primera pintura comprobados. La paleta de otra cuenta queda fuera del HTML. Una edición abierta conserva entrada, panel y foco al cambiar el tema.
- Generador móvil y CSP pasan sus pruebas. Probar que un iframe abierto en modo oscuro vuelve a recibir el esquema tras su segundo `ready`. [Fallo existente CB-419](https://brain.ingenioventures.com/issues/CB-419)
