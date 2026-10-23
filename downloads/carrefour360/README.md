# Puente Carrefour360 para A4 Studio

Extensión local de Chrome/Edge (Manifest V3). Consulta productos y PVP usando la
sesión que el usuario ya abrió en Carrefour360. No pide ni guarda contraseñas,
cookies o tokens. No activa productos, no genera etiquetas ni modifica precios.

## Instalación

1. Abrí `chrome://extensions` (o `edge://extensions`) y activá el modo desarrollador.
2. Elegí **Cargar descomprimida** y seleccioná esta carpeta `extensions/carrefour360`.
3. Recargá A4 Studio y la pestaña Carrefour360 si ya estaban abiertas.
4. Iniciá sesión en Carrefour360 y dejá abierta una única pestaña de Pricing con
   la sucursal que querés consultar. Conectá desde A4 Studio.

El acceso de producción se limita a `https://claufrias.github.io/a4studio/`.
También se permiten `http://localhost/a4studio/` y
`http://127.0.0.1/a4studio/` (cualquier puerto) para probar una copia local servida
bajo esa ruta. La extensión no se conecta a archivos `file://` ni a otros sitios
o repositorios de GitHub Pages.

El único permiso de host para el service worker es
`https://carrefour360.carrefour.com.ar/*`. Los content scripts se limitan a las
rutas A4 indicadas y a Pricing. No se usan permisos `cookies`, `storage`,
`webRequest` o `scripting`, servidores intermedios ni código remoto.

## Funcionamiento

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

## Verificación

```sh
node --test tests/carrefour-extension.test.cjs
```

Las pruebas cubren origen, permisos, validación de datos, precio decimal,
rechazo del resultado anterior y orden de consultas. La conexión real también
debe comprobarse con una sesión de Pricing abierta; las pruebas no simulan un
inicio de sesión válido ante el sitio.
