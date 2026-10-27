# Puente Carrefour360 para A4 Studio

Extensión local de Chrome/Edge (Manifest V3). Consulta productos y PVP usando la
sesión que el usuario ya abrió en Carrefour360. No pide ni guarda contraseñas,
cookies o tokens. No activa productos, no genera etiquetas ni modifica precios.

## Instalación

1. Abrí `chrome://extensions` (o `edge://extensions`) y activá el modo desarrollador.
2. Elegí **Cargar descomprimida** y seleccioná esta carpeta `extensions/carrefour360`.
3. Volvé a A4 Studio. En una instalación nueva de la versión 1.0.3, las pestañas
   que ya estaban abiertas se conectan sin recargar. Si estás actualizando una
   versión anterior, guardá tu trabajo y recargá A4 Studio y Pricing una vez.
4. Iniciá sesión en Carrefour360 y dejá abierta una única pestaña de Pricing con
   la sucursal que querés consultar. Conectá desde A4 Studio.

El acceso de producción se limita a `https://claufrias.github.io/a4studio/`.
También se permiten `http://localhost/a4studio/` y
`http://127.0.0.1/a4studio/` (cualquier puerto) para probar una copia local servida
bajo esa ruta. La extensión no se conecta a archivos `file://` ni a otros sitios
o repositorios de GitHub Pages.

Los permisos de host cubren Carrefour360 y los orígenes de A4 indicados.
Desde la versión 1.0.4 también se permite `https://www.carrefour.com.ar/*` para
consultar el catálogo público y `https://carrefourar.vteximg.com.br/*` para
descargar las fotos de productos. No se aceptan otras direcciones de imagen.
El permiso `scripting` permite cargar los archivos propios del conector en las
pestañas que ya estaban abiertas al instalar. Se revalida cada URL y solo se
ejecuta en el frame principal de A4 o Pricing. Los content scripts también se
limitan a esas rutas. No se usan permisos `cookies`, `storage`, `webRequest` ni
`tabs`, servidores intermedios o código remoto.

## Funcionamiento

En una instalación nueva de la versión **1.0.3**, `onInstalled` conecta las
pestañas permitidas ya abiertas mediante `scripting.executeScript`, sin recargar,
abrir pestañas ni consultar productos. Cada script se instala una sola vez por
contexto, por lo que repetir la carga no duplica consultas ni pierde la conexión.
Una pestaña cerrada o sin permisos no impide conectar las demás. La reinyección
automática no se aplica al actualizar versiones anteriores: sus scripts pueden
quedar invalidados y requieren recargar las páginas una vez.

Desde la versión **1.0.2**, A4 Studio puede comprobar la presencia del conector
sin abrir Pricing, iniciar sesión ni consultar productos. El puente responde
localmente a `action: 'presence'` con
`{ installed: true, extensionVersion: '1.0.3' }`. Esto no establece ni cambia
la conexión con la pestaña Pricing. Las versiones anteriores no responden a
esta comprobación; hay que publicar la actualización en Chrome Web Store.

Al terminar de cargar el puente, se publica un aviso con
`{ source: 'carrefour360-a4studio', version: 1, action: 'ready' }` en el mismo
origen. La página no lo considera prueba de instalación: envía una nueva
solicitud `presence`. Si había una solicitud anterior pendiente, espera a que
termine y reintenta; si el usuario cerró la guía, el aviso no vuelve a abrirla.

La conexión se confirma solo si existe una única pestaña Pricing y están
disponibles los controles de consulta. Si no hay una pestaña, la extensión abre
Pricing y devuelve un aviso para iniciar sesión y volver a conectar. Si hay
varias pestañas, pide dejar una para no seleccionar una sucursal a ciegas.

Cada consulta primero comprueba que `#loadingContainer` esté oculto para evitar
mezclarse con una búsqueda manual previa. Escribe exclusivamente el EAN en
`#ean_product_value` y pulsa el control de búsqueda `#btn_ean_product`. Espera
un nodo **nuevo** `#description` dentro de `#pricing_content` y que se oculte
la máscara de carga; nunca devuelve el nodo anterior. El PVP se
lee únicamente de `#td_data[data-price]`. Si falta el atributo, se acepta el texto
del mismo campo en formato `$ 6,000.00`. Se interpreta a centavos sin cálculos con
decimales. No se consultan otros importes, stock, FID o precios promocionales.

Las consultas se ejecutan en orden por pestaña. El resultado incluye EAN,
descripción, PVP en centavos, fecha y fuente. `tienda` queda en `null` porque no
se ha verificado un selector estable de sucursal. La sucursal efectiva es la de
la pestaña Pricing vinculada; revisala en Carrefour360 antes de consultar.

Una consulta en Pricing vence a los 15 segundos y su transporte a los 18. Si
editaste el EAN de Pricing mientras se consultaba, la consulta se cancela
inmediatamente. Pricing no expone un EAN dentro del resultado: el puente valida
el EAN del input, la ausencia de consultas previas y el ciclo de carga observado;
no afirma una correlación directa por EAN devuelto. Si se detecta que desapareció
el input o cambió la ruta a login, la consulta falla. Después de cerrar la
pestaña, cerrar sesión o actualizar la
extensión, volvé a conectar.

## Protocolo con A4

Solicitud en la misma ventana y origen:

```js
window.postMessage({
  source: 'a4studio-carrefour360', version: 1,
  id: crypto.randomUUID(), action: 'status'
}, location.origin);
```

Para consultar, usar `action: 'lookup'` y `ean` como texto de 1 a 14 dígitos.
Primero debe completarse `status`. Las respuestas usan
`source: 'carrefour360-a4studio'`, `version: 1`, el mismo `id` y `ok`.
Si `ok` es verdadero, contienen `result`; de lo contrario,
`error: { code, message }`. Nunca se devuelve HTML ni información de sesión.

Desde la versión **1.0.4**, `action: 'image'` y un `ean` de 4 a 14 dígitos
consultan una foto sin conectar a Pricing. El servicio público usado es
`https://www.carrefour.com.ar/api/catalog_system/pub/products/search`, filtrado
por `alternateIds_Ean`. Se exige que el `ean` del SKU coincida exactamente; no se
elige una variante por similitud del nombre. El resultado incluye `ean`,
`descripcion`, `imageUrl`, `productUrl`, `source: 'Carrefour.com.ar'` e
`imageDataUrl` raster. La página muestra una vista previa y exige confirmación.

El catálogo está limitado a 2 MiB, la foto a 4 MiB y la consulta completa a 15 s.
Solo se permiten JPEG, PNG y WebP con tipo y firma compatibles. Se omiten
credenciales y se rechazan redirecciones y hosts ajenos. La foto se incorpora
como datos locales para poder guardar el proyecto, imprimir y deshacer el cambio.
El ZIP debe incluir `catalog-images.js` junto con el resto del conector.

## Verificación

```sh
node --test tests/carrefour-extension.test.cjs
```

Las pruebas cubren origen, permisos, validación de datos, precio decimal,
rechazo del resultado anterior y orden de consultas. La conexión real también
debe comprobarse con una sesión de Pricing abierta; las pruebas no simulan un
inicio de sesión válido ante el sitio.
