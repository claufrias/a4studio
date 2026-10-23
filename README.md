# a4studio
Editor visual de carteles

El catálogo local incluye 3.362 productos del informe del 22/10/2026. Al escribir
al menos dos caracteres en el nombre se muestran hasta ocho coincidencias, sin
distinguir mayúsculas ni tildes. Elegir una sugerencia con clic o con las flechas
y Enter completa el nombre y el EAN. Ingresar un código que exista en el catálogo
completa el nombre automáticamente. Funciona en carteles normales, en la edición
directa del producto y en cada espacio de Consumo inmediato.

Los códigos se guardan como texto y las descripciones conservan las abreviaturas
del informe original. El catálogo contiene únicamente códigos y descripciones;
los precios se ingresan en el editor.

Para regenerar `productos.js` desde otro informe con el mismo formato:

```sh
node scripts/import-products.cjs "ruta/al/informe.txt"
```

Para verificar el catálogo y las búsquedas:

```sh
node --test tests/product-catalog.test.cjs
```
