# a4studio
Editor visual de carteles

El selector de promociones conserva el fondo de bienvenida y muestra tarjetas
con el nombre, el porcentaje y el ícono de cada aplicación. Las opciones de
**Cuenta Digital Carrefour Banco · 10% y 15%** están agrupadas y conservan sus
fondos propios. **Consumo inmediato** aparece por separado y permite ingresar el
descuento de cada producto. Los íconos se guardan en `assets/promotions/`, con
sus fuentes documentadas en `SOURCES.md`.

Elegir una tarjeta marca la opción sin modificar el cartel. El cambio se confirma
con **Usar esta promoción** y se puede aplicar a
**Solo este cartel** o **Todos los carteles**; cada cartel conserva su precio
normal y calcula su propio descuento. La etiqueta **Actual** identifica la
promoción aplicada. **Cancelar** conserva el proyecto y se puede deshacer una
promoción confirmada. Al crear un proyecto se requiere elegir una promoción
para el primer cartel.

El selector usa tarjetas compactas con íconos de 40 px. En pantallas de
1024 × 600 se ven las cinco opciones sin desplazar la lista. En ventanas más
pequeñas o con el navegador ampliado, la lista puede desplazarse mientras el
encabezado y los botones permanecen visibles.

El catálogo local incluye 3.362 productos del informe del 22/10/2026. Al escribir
al menos dos caracteres en el nombre se muestran hasta ocho coincidencias, sin
distinguir mayúsculas ni tildes. Elegir una sugerencia con clic o con las flechas
y Enter completa el nombre y el EAN. Ingresar un código que exista en el catálogo
completa el nombre automáticamente. Funciona en carteles normales, en la edición
directa del producto y en cada espacio de Consumo inmediato.

Los códigos se guardan como texto y las descripciones conservan las abreviaturas
del informe original. El catálogo contiene únicamente códigos y descripciones;
los precios se ingresan en el editor o se consultan en Carrefour360.

La conexión con Carrefour360 usa el complemento de Chrome incluido en
`extensions/carrefour360/`. Consulta la descripción completa y el PVP desde
una pestaña Pricing con la sesión iniciada y la tienda seleccionada allí.
El PVP se aplica como precio normal y luego se calcula el descuento del cartel;
en Consumo inmediato se conserva el descuento manual y se admiten centavos.

Para activarla, instalá el
[conector desde Chrome Web Store](https://chromewebstore.google.com/detail/pdephgakanbombajkihikkcjidcmeggf).
Abrí una única pestaña Pricing con tu sesión iniciada y la tienda seleccionada.
Usá **Conectar** en el editor.
La extensión se limita a `https://claufrias.github.io/a4studio/`, a la
página Pricing y a la ruta `/a4studio/` de localhost para desarrollo. No recibe
contraseñas ni cookies y no modifica precios en Carrefour360.

Para desarrollar la extensión, podés cargar `extensions/carrefour360/` desde
Chrome → Extensiones → Gestionar extensiones → Modo desarrollador → Cargar
descomprimida. El mismo código también está en `downloads/carrefour360.zip`.
Usá una sola instalación del conector a la vez para evitar respuestas duplicadas.

El panel **CARREFOUR360** del editor permite conectar la extensión y consultar
el producto del cartel. Después de conectar, ingresá un EAN o elegí una
sugerencia del catálogo: **Completar al ingresar un EAN** trae la descripción
y el PVP de Pricing. También podés usar **Traer datos de Carrefour360** para
volver a consultar el mismo código. **Desconectar** detiene las consultas y
permite seguir trabajando con el catálogo local.

El panel izquierdo agrupa los datos en **Producto**, **Precios y promoción** y
**Vigencia**. **Personalizar cartel** reúne el título, las tipografías y los
colores, y empieza cerrado. La conexión está junto al producto; las instrucciones
de instalación y consulta están en **Ayuda para conectar**. En Consumo inmediato
se elige el espacio en Producto, se editan los importes en Precios y promoción y
se mantienen las fechas en Vigencia.

Al entrar, A4 Studio comprueba si el conector responde, sin abrir Pricing ni
consultar productos. Si no responde, muestra cómo instalar la herramienta con
**Instalar en Chrome**, **Ya la instalé** y **Ahora no, seguir con mis carteles**.
Los mensajes de error aparecen solo después de intentar comprobar la instalación.
Al detectarla, el aviso cambia a **¡La herramienta está instalada!** y explica
cómo abrir Carrefour360, entrar a Pricing y dejar esa pestaña abierta. El botón
**Abrir Carrefour360** abre Pricing y cierra el aviso para poder volver al editor
y tocar **Conectar**. Detectarla por sí sola no abre ninguna pestaña.
El aviso espera a que
se cierre el selector inicial de plantilla. Cerrarlo lo descarta durante esa
sesión de la pestaña; se puede volver a abrir desde **Instalar o comprobar extensión**.
La instalación está pensada para Chrome o Edge en computadora.

Esta comprobación de presencia requiere el conector **1.0.2 o posterior**.
La versión 1.0.1 puede seguir consultando productos, pero no responde a la nueva
comprobación. Publicá el ZIP actualizado en Chrome Web Store para que los usuarios
reciban la detección. El aviso no afirma que la extensión esté desinstalada:
también puede estar deshabilitada, sin permiso para esta página o pendiente de
actualizar. Detectarla no equivale a tener una sesión de Pricing conectada.

Desde la versión **1.0.3**, una instalación nueva conecta las pestañas A4 Studio
y Pricing que ya estaban abiertas, sin recargarlas ni perder los cambios del
cartel. El puente avisa cuando está listo y A4 Studio vuelve a comprobar su
presencia, incluso si la primera comprobación ocurrió antes de la instalación.
Esto requiere publicar la versión 1.0.3 en Chrome Web Store; cambiar solo la
página no puede activar una extensión en una pestaña anterior a su instalación.
Si actualizás una versión anterior, guardá tu trabajo y recargá A4 Studio y
Pricing una vez. La activación automática se limita a instalaciones nuevas.

Para buscar fotos necesitás el conector **1.0.4 o posterior**. En un cartel normal,
ingresá el código de barras y, en el panel **Imagen**, tocá **Buscar imagen en
Carrefour**. Se consulta el catálogo público de carrefour.com.ar y se muestra
una vista previa del producto cuyo código coincida exactamente. Elegí **Usar esta
imagen** para agregarla; tu foto anterior se conserva hasta esa confirmación y
podés deshacer el cambio. Si cambiás de cartel, código o imagen durante la
búsqueda, se pide volver a buscar. Esta consulta no necesita una sesión de
Pricing ni modifica los precios del cartel. Consumo inmediato mantiene su diseño
sin imágenes.

Si hay varias pestañas Pricing, dejá abierta la que quieras consultar antes
de conectar. Ante una sesión vencida, una respuesta inválida o una consulta
fallida se conservan los datos del cartel. Cambiar de página, espacio o EAN
cancela la aplicación de respuestas pendientes; también se respeta el precio
editado manualmente durante la consulta.

El complemento necesita estar instalado y esta versión del editor debe estar
publicada para usar la conexión en GitHub Pages. Las pruebas automáticas no
sustituyen la comprobación final con el complemento cargado en Chrome.

Para regenerar el ZIP después de modificar el complemento:

```sh
python scripts/package-carrefour360.py
```

Para regenerar `productos.js` desde otro informe con el mismo formato:

```sh
node scripts/import-products.cjs "ruta/al/informe.txt"
```

Para verificar el catálogo y las búsquedas:

```sh
node --test tests/*.test.cjs
```
